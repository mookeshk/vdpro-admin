// Video Downloader Pro — بوت تيليجرام + سيرفر التراخيص (Render)
//
// متغيرات البيئة (Render > Environment):
//   BOT_TOKEN, ADMIN_CHAT_ID, PAYMENT_NUMBER  — زي ما هي
//   LICENSE_PRIVATE_KEY  — المفتاح الخاص لتوقيع التراخيص (من tools/gen-license-key.js)
//   CRON_SECRET          — كلمة سر لمسار /cron/run (GitHub Actions بيناديه كل كام ساعة)
// Secret File على Render: firebase-sa.json (Service Account من Firebase Console)

const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==================== الإعدادات ====================
const token = process.env.BOT_TOKEN;
const adminChatId = String(process.env.ADMIN_CHAT_ID || '');
const paymentNumber = process.env.PAYMENT_NUMBER;
const cronSecret = process.env.CRON_SECRET || '';

if (!token || !adminChatId || !paymentNumber) {
    console.error("Missing env vars: BOT_TOKEN, ADMIN_CHAT_ID, PAYMENT_NUMBER");
    process.exit(1);
}

const DAY = 24 * 60 * 60 * 1000;
const LICENSE_VALID_MS = 7 * DAY;   // البرنامج بيشتغل بالترخيص المحفوظ لحد أسبوع لو السيرفر مش متاح

// ==================== Firebase Admin ====================
function loadServiceAccount() {
    for (const f of ['/etc/secrets/firebase-sa.json', path.join(__dirname, 'firebase-sa.json')]) {
        try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); }
        catch (e) { console.error("Bad service account file", f, e.message); }
    }
    const env = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (env) {
        try { return JSON.parse(env); } catch { }
        try { return JSON.parse(Buffer.from(env, 'base64').toString('utf8')); } catch { }
        console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON/base64");
    }
    return null;
}

const serviceAccount = loadServiceAccount();
let db = null, authAdmin = null;
if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    authAdmin = admin.auth();
    console.log("Firebase Admin ready:", serviceAccount.project_id);
} else {
    console.error("⚠️ Service account missing: add Secret File 'firebase-sa.json' on Render. Bot runs in maintenance mode.");
}
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// ==================== مفتاح التراخيص ====================
let licenseKey = null;
try {
    let pem = process.env.LICENSE_PRIVATE_KEY || '';
    if (pem && !pem.includes('BEGIN')) pem = Buffer.from(pem, 'base64').toString('utf8');
    if (pem) licenseKey = crypto.createPrivateKey(pem);
} catch (e) { console.error("LICENSE_PRIVATE_KEY invalid:", e.message); }
if (!licenseKey) console.error("⚠️ LICENSE_PRIVATE_KEY missing: /license disabled");

// ==================== تيليجرام ====================
const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";
const useWebhook = publicUrl.startsWith("https://");
const webhookSecret = process.env.WEBHOOK_SECRET || crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
const webhookPath = "/telegram/" + webhookSecret;
const bot = useWebhook ? new TelegramBot(token) : new TelegramBot(token, { polling: true });

const send = (chatId, text, opts) => bot.sendMessage(chatId, text, opts).catch(e => console.error("send failed", chatId, e.message));
const isAdminChat = chatId => String(chatId) === adminChatId;
const MAINTENANCE = "البوت تحت الصيانة دلوقتي، جرّب كمان شوية 🙏";

// ==================== أدوات ====================
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const normDigits = s => String(s || '').replace(/[٠-٩]/g, d => ARABIC_DIGITS[d]);
function priceNumber(pkg) {
    if (typeof pkg.priceValue === 'number' && pkg.priceValue > 0) return pkg.priceValue;
    const m = normDigits(pkg.price).match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
}
const fmtDate = ms => new Date(ms).toLocaleDateString('ar-EG', { timeZone: 'Africa/Cairo', year: 'numeric', month: 'long', day: 'numeric' });
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// المميزات الافتراضية: لو الباقة مالهاش مميزات متحددة تاخد كل حاجة (عشان المشتركين الحاليين مايتأثروش)
const FULL_FEATURES = { maxQuality: 0, maxConcurrent: 0, dailyDownloads: 0, playlist: true, convert: true, schedule: true, follows: true };
function cleanFeatures(f) {
    f = f || {};
    const num = (v, max) => { v = parseInt(v); return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0; };
    return {
        maxQuality: num(f.maxQuality, 4320),
        maxConcurrent: num(f.maxConcurrent, 10),
        dailyDownloads: num(f.dailyDownloads, 10000),
        playlist: f.playlist !== false,
        convert: f.convert !== false,
        schedule: f.schedule !== false,
        follows: f.follows !== false
    };
}

async function getConfig() {
    const d = await db.collection('app_config').doc('public').get();
    const c = d.exists ? d.data() : {};
    return {
        trialDays: parseInt(c.trialDays) > 0 ? parseInt(c.trialDays) : 30,
        trialFeatures: c.trialFeatures ? cleanFeatures(c.trialFeatures) : { ...FULL_FEATURES },
        referralBonusDays: parseInt(c.referralBonusDays) >= 0 ? parseInt(c.referralBonusDays) : 7
    };
}

async function findPackage(user) {
    if (user.packageId) {
        const d = await db.collection('packages').doc(user.packageId).get();
        if (d.exists) return { id: d.id, ...d.data() };
    }
    if (user.package) {
        const s = await db.collection('packages').where('name', '==', user.package).limit(1).get();
        if (!s.empty) return { id: s.docs[0].id, ...s.docs[0].data() };
    }
    return null;
}

// حالة الاشتراك من السيرفر (نفس منطق البرنامج)
async function computeSubscription(user, cfg) {
    const now = Date.now();
    if (user.status === 'active') {
        const exp = user.expiresAt && user.expiresAt.toMillis ? user.expiresAt.toMillis() : 0;
        const pkg = await findPackage(user);
        if (exp > now) {
            return { status: 'active', plan: (pkg && pkg.name) || user.package || 'active', expiresAt: exp,
                     features: pkg && pkg.features ? cleanFeatures(pkg.features) : { ...FULL_FEATURES } };
        }
        return { status: 'expired', plan: (pkg && pkg.name) || user.package || '', expiresAt: exp, features: null };
    }
    const created = user.createdAt && user.createdAt.toMillis ? user.createdAt.toMillis() : now;
    const trialEnd = created + (cfg.trialDays + (parseInt(user.trialBonusDays) || 0)) * DAY;
    if (trialEnd > now) return { status: 'trial', plan: 'trial', expiresAt: trialEnd, features: cfg.trialFeatures };
    return { status: 'expired', plan: 'trial', expiresAt: trialEnd, features: null };
}

// ==================== جلسات المحادثة (محفوظة في Firestore عشان ماتضيعش لو Render عمل restart) ====================
const sessions = new Map();
async function getSession(chatId) {
    const k = String(chatId);
    if (sessions.has(k)) return sessions.get(k);
    let s = null;
    try {
        const d = await db.collection('bot_sessions').doc(k).get();
        s = d.exists ? d.data() : null;
        if (s && Date.now() - (s.updatedAt || 0) > DAY) s = null;
    } catch (e) { console.error("getSession", e.message); }
    sessions.set(k, s);
    return s;
}
async function setSession(chatId, s) {
    s.updatedAt = Date.now();
    sessions.set(String(chatId), s);
    await db.collection('bot_sessions').doc(String(chatId)).set(s).catch(e => console.error("setSession", e.message));
}
async function clearSession(chatId) {
    sessions.delete(String(chatId));
    await db.collection('bot_sessions').doc(String(chatId)).delete().catch(() => { });
}

// ==================== الكوبونات ====================
async function checkCoupon(code, packageId) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return { ok: false, msg: "الكود ده مش صحيح" };
    const d = await db.collection('coupons').doc(code).get();
    if (!d.exists) return { ok: false, msg: "الكود ده مش موجود" };
    const c = d.data();
    if (c.active === false) return { ok: false, msg: "الكود ده متوقف" };
    if (c.expiresAt && c.expiresAt.toMillis() < Date.now()) return { ok: false, msg: "الكود ده انتهت صلاحيته" };
    if (c.maxUses > 0 && (c.uses || 0) >= c.maxUses) return { ok: false, msg: "الكود ده اتستخدم العدد المسموح بيه" };
    if (Array.isArray(c.packageIds) && c.packageIds.length && !c.packageIds.includes(packageId)) return { ok: false, msg: "الكود ده مش على الباقة دي" };
    const percent = Math.min(100, Math.max(1, parseInt(c.percent) || 0));
    return { ok: true, code, percent };
}

// ==================== البوت: الأوامر ====================
async function showPackages(chatId) {
    const snapshot = await db.collection("packages").get();
    if (snapshot.empty) return send(chatId, "عفواً لا توجد باقات متاحة الآن. يرجى المحاولة لاحقاً.");
    const buttons = [];
    snapshot.forEach(doc => {
        const p = doc.data();
        buttons.push([{ text: `💎 ${p.name} - ${p.price}${p.duration ? ` (${p.duration} يوم)` : ''}`, callback_data: `PKG_${doc.id}` }]);
    });
    await send(chatId, "مرحباً بك في Video Downloader Pro! 🚀\n\nاختار الباقة اللي تناسبك:\n\n(اكتب /status عشان تعرف حالة اشتراكك)", {
        reply_markup: { inline_keyboard: buttons }
    });
}

// ربط الحساب من زرار "ربط تيليجرام" في البرنامج: /start link_<code>
async function linkAccount(msg, code) {
    const chatId = msg.chat.id;
    if (!/^[A-Za-z0-9]{20,40}$/.test(code)) return send(chatId, "رابط الربط مش صحيح، جرّب تاني من البرنامج.");
    const s = await db.collection('users').where('telegramLinkCode', '==', code).limit(1).get();
    if (s.empty) return send(chatId, "رابط الربط انتهى أو اتستخدم. دوس \"ربط تيليجرام\" تاني من البرنامج.");
    const doc = s.docs[0], u = doc.data();
    const at = u.telegramLinkAt && u.telegramLinkAt.toMillis ? u.telegramLinkAt.toMillis() : 0;
    if (Date.now() - at > 60 * 60 * 1000) return send(chatId, "رابط الربط انتهى (صالح لساعة). دوس \"ربط تيليجرام\" تاني من البرنامج.");
    await doc.ref.update({
        telegramChatId: String(chatId),
        telegramUsername: msg.chat.username || '',
        telegramLinkCode: FieldValue.delete(),
        telegramLinkAt: FieldValue.delete()
    });
    await send(chatId, `✅ تم ربط حسابك (${u.email}) بتيليجرام.\nهتوصلك رسالة قبل ما الاشتراك يخلص. اكتب /status في أي وقت.`);
}

bot.onText(/^\/start(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!db) return send(chatId, MAINTENANCE);
    try {
        const payload = match && match[1] ? match[1] : '';
        if (payload.startsWith('link_')) return await linkAccount(msg, payload.slice(5));
        await clearSession(chatId);
        await showPackages(chatId);
    } catch (e) {
        console.error("start failed:", e);
        send(chatId, "حدث خطأ، جرّب تاني أو تواصل مع الدعم.");
    }
});

bot.onText(/^\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (!db) return send(chatId, MAINTENANCE);
    try {
        const s = await db.collection('users').where('telegramChatId', '==', String(chatId)).limit(3).get();
        if (s.empty) return send(chatId, "مفيش حساب مربوط بالمحادثة دي.\nمن البرنامج: حسابي ← \"ربط تيليجرام\".");
        const cfg = await getConfig();
        for (const d of s.docs) {
            const u = d.data();
            const sub = await computeSubscription(u, cfg);
            const left = Math.ceil((sub.expiresAt - Date.now()) / DAY);
            let txt = `👤 ${u.email}\n`;
            if (sub.status === 'active') txt += `✅ مفعّل — ${sub.plan}\n📅 ينتهي ${fmtDate(sub.expiresAt)} (فاضل ${left} يوم)`;
            else if (sub.status === 'trial') txt += `🧪 فترة تجريبية — فاضل ${left} يوم`;
            else txt += `⛔ الاشتراك منتهي. اكتب /start للتجديد`;
            if (u.referralCode) txt += `\n🎁 كود الدعوة بتاعك: ${u.referralCode}`;
            await send(chatId, txt);
        }
    } catch (e) { console.error("status failed:", e); send(chatId, "حدث خطأ، جرّب تاني."); }
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = q.data || '';
    bot.answerCallbackQuery(q.id).catch(() => { });
    if (!db) return send(chatId, MAINTENANCE);
    try {
        if (data.startsWith('PKG_')) {
            const d = await db.collection('packages').doc(data.slice(4)).get();
            if (!d.exists) return send(chatId, "الباقة دي مش متاحة دلوقتي. اكتب /start تاني.");
            const p = d.data();
            await setSession(chatId, { step: 'ASK_NAME', packageId: d.id, packageName: p.name, price: p.price || '', priceValue: priceNumber(p) });
            return send(chatId, `✅ اخترت باقة: ${p.name} (${p.price})\n\nاكتب اسمك بالكامل:`);
        }
        if (data === 'NOCOUPON') {
            const s = await getSession(chatId);
            if (s && s.step === 'ASK_COUPON') return goToPayment(chatId, s);
        }
        if (data === 'RENEW') { await clearSession(chatId); return showPackages(chatId); }
    } catch (e) { console.error("callback failed:", e); send(chatId, "حدث خطأ، اكتب /start وجرّب تاني."); }
});

async function goToPayment(chatId, s) {
    s.finalPrice = s.priceValue > 0 ? Math.round(s.priceValue * (100 - (s.percent || 0)) / 100) : 0;
    s.step = 'ASK_RECEIPT';
    await setSession(chatId, s);
    const amount = s.priceValue > 0 ? `${s.finalPrice} جنيه` : s.price;
    let txt = s.coupon ? `🎟️ تم تطبيق الكود ${s.coupon} (خصم ${s.percent}%)\nالسعر قبل الخصم: ${s.price}\n\n` : '';
    txt += `أخيراً، حوّل مبلغ الاشتراك (${amount}) على فودافون كاش أو إنستاباي على الرقم:\n📞 ${paymentNumber}\n\n`;
    txt += `وبعدين صوّر إيصال التحويل وابعت الصورة هنا عشان نأكد طلبك.`;
    return send(chatId, txt);
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.text && msg.text.startsWith('/')) return;
    if (!db) return send(chatId, MAINTENANCE);

    let s;
    try { s = await getSession(chatId); } catch { s = null; }
    if (!s) {
        if (!isAdminChat(chatId)) send(chatId, "اكتب /start عشان تبدأ وتختار باقة، أو /status لحالة اشتراكك.");
        return;
    }
    const text = (msg.text || '').trim();

    try {
        if (s.step === 'ASK_NAME') {
            if (text.length < 2 || text.length > 80) return send(chatId, "اكتب اسمك بالكامل (من 2 لـ 80 حرف):");
            s.name = text; s.step = 'ASK_EMAIL';
            await setSession(chatId, s);
            return send(chatId, "اكتب الإيميل اللي سجلت بيه في البرنامج:");
        }
        if (s.step === 'ASK_EMAIL') {
            const email = text.toLowerCase();
            if (!EMAIL_RX.test(email)) return send(chatId, "الإيميل مش صحيح، اكتبه تاني:");
            let user;
            try { user = await authAdmin.getUserByEmail(email); }
            catch (e) {
                if (e.code === 'auth/user-not-found')
                    return send(chatId, "❌ الإيميل ده مش مسجل في البرنامج.\nسجّل حساب في البرنامج الأول بنفس الإيميل، وبعدين ابعته هنا:");
                throw e;
            }
            s.email = email; s.uid = user.uid; s.step = 'ASK_PHONE';
            await setSession(chatId, s);
            return send(chatId, "اكتب رقم الموبايل للتواصل:");
        }
        if (s.step === 'ASK_PHONE') {
            const phone = normDigits(text).replace(/[\s-]/g, '');
            if (!/^\+?\d{8,15}$/.test(phone)) return send(chatId, "رقم الموبايل مش صحيح، اكتبه تاني:");
            s.phone = phone; s.step = 'ASK_COUPON';
            await setSession(chatId, s);
            return send(chatId, "عندك كود خصم؟ ابعته هنا، أو دوس الزرار:", {
                reply_markup: { inline_keyboard: [[{ text: "معنديش كود", callback_data: "NOCOUPON" }]] }
            });
        }
        if (s.step === 'ASK_COUPON') {
            const r = await checkCoupon(text, s.packageId);
            if (!r.ok) return send(chatId, `❌ ${r.msg}. جرّب كود تاني أو دوس "معنديش كود".`, {
                reply_markup: { inline_keyboard: [[{ text: "معنديش كود", callback_data: "NOCOUPON" }]] }
            });
            s.coupon = r.code; s.percent = r.percent;
            return goToPayment(chatId, s);
        }
        if (s.step === 'ASK_RECEIPT') {
            if (!msg.photo && !msg.document) return send(chatId, "❌ ابعت صورة إيصال التحويل عشان نكمّل الطلب.");
            const receiptFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
            const orderRef = db.collection('orders').doc();

            // الكوبون بيتحسب استخدامه مع إنشاء الطلب (Transaction عشان الحد الأقصى مايتعداش)
            await db.runTransaction(async tx => {
                if (s.coupon) {
                    const cRef = db.collection('coupons').doc(s.coupon);
                    const c = await tx.get(cRef);
                    const cd = c.exists ? c.data() : null;
                    const valid = cd && cd.active !== false && !(cd.expiresAt && cd.expiresAt.toMillis() < Date.now())
                                  && !(cd.maxUses > 0 && (cd.uses || 0) >= cd.maxUses);
                    if (valid) tx.update(cRef, { uses: FieldValue.increment(1) });
                    else { s.coupon = ''; s.percent = 0; s.finalPrice = s.priceValue; }
                }
                tx.set(orderRef, {
                    chatId: String(chatId), tgUsername: msg.chat.username || '',
                    name: s.name, email: s.email, uid: s.uid, phone: s.phone,
                    packageId: s.packageId, packageName: s.packageName, price: s.price, priceValue: s.priceValue || 0,
                    coupon: s.coupon || '', discountPercent: s.percent || 0, finalPrice: s.finalPrice || 0,
                    receiptFileId, status: 'pending', userNotified: false,
                    createdAt: FieldValue.serverTimestamp()
                });
            });

            let notify = `🔔 طلب ترخيص جديد  #${orderRef.id.slice(0, 6)}\n\n`;
            notify += `📦 الباقة: ${s.packageName} (${s.price})\n`;
            if (s.coupon) notify += `🎟️ كود: ${s.coupon} (−${s.percent}%) ← المطلوب ${s.finalPrice} جنيه\n`;
            notify += `👤 الاسم: ${s.name}\n✉️ الإيميل: ${s.email}\n📱 الموبايل: ${s.phone}\n`;
            notify += `💬 تيليجرام: @${msg.chat.username || 'بدون_يوزر'}\n\nفعّله من لوحة التحكم ← الطلبات`;
            await send(adminChatId, notify);
            await bot.forwardMessage(adminChatId, chatId, msg.message_id).catch(e => console.error("forward", e.message));

            await clearSession(chatId);
            return send(chatId, "✅ تم استلام طلبك وصورة التحويل! هنراجع الطلب ونفعّل حسابك في أقرب وقت، وهتوصلك رسالة هنا أول ما يتفعّل.");
        }
    } catch (e) {
        console.error("message failed:", e);
        send(chatId, "حدث خطأ، جرّب تاني أو اكتب /start من الأول.");
    }
});

// ==================== إشعار العميل لما الأدمن يفعّل/يرفض الطلب ====================
async function notifyOrder(doc) {
    const o = doc.data();
    if (o.userNotified || (o.status !== 'approved' && o.status !== 'rejected')) return false;
    // نعلّم الأول عشان مانبعتش مرتين لو فيه أكتر من تشغيل
    const claimed = await db.runTransaction(async tx => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists || fresh.data().userNotified) return false;
        tx.update(doc.ref, { userNotified: true });
        return true;
    });
    if (!claimed) return false;
    if (o.status === 'approved') {
        let txt = `🎉 تم تفعيل اشتراكك — ${o.packageName}`;
        if (o.uid) {
            const u = await db.collection('users').doc(o.uid).get();
            const exp = u.exists && u.data().expiresAt ? u.data().expiresAt.toMillis() : 0;
            if (exp) txt += `\n📅 صالح لحد ${fmtDate(exp)}`;
            if (u.exists && u.data().referralCode) txt += `\n\n🎁 ادعي صحابك بكود ${u.data().referralCode} وخد أيام مجانية على كل اشتراك جديد.`;
        }
        txt += `\n\nافتح البرنامج واستمتع 🚀`;
        await send(o.chatId, txt);
    } else {
        await send(o.chatId, `❌ للأسف ماقدرناش نأكد طلب الاشتراك (${o.packageName}).${o.rejectReason ? '\nالسبب: ' + o.rejectReason : ''}\nلو فيه مشكلة تواصل مع الدعم.`);
    }
    return true;
}

async function processOrderNotifications() {
    let n = 0;
    const s = await db.collection('orders').where('userNotified', '==', false).limit(50).get();
    for (const d of s.docs) { try { if (await notifyOrder(d)) n++; } catch (e) { console.error("notify order", d.id, e.message); } }
    return n;
}

// ==================== تذكير قبل انتهاء الاشتراك ====================
async function remindUser(docRef, u, endMs, kind) {
    if (!u.telegramChatId) return false;
    const left = Math.ceil((endMs - Date.now()) / DAY);
    const stage = left <= 0 ? 'expired' : left <= 1 ? '1d' : left <= 3 ? '3d' : null;
    if (!stage) return false;
    const key = `${kind}_${endMs}_${stage}`;
    if (u.reminders && u.reminders[key]) return false;
    let txt;
    if (kind === 'trial') {
        txt = stage === 'expired' ? "⏰ الفترة التجريبية خلصت. اشترك دلوقتي عشان تكمّل التحميل 👇"
                                  : `⏰ الفترة التجريبية هتخلص خلال ${left} يوم. اشترك عشان ماتتوقفش 👇`;
    } else {
        txt = stage === 'expired' ? `⛔ اشتراكك (${u.package || ''}) خلص. جدّد دلوقتي 👇`
                                  : `⏰ اشتراكك (${u.package || ''}) هيخلص خلال ${left} يوم (${fmtDate(endMs)}). جدّد عشان ماتتوقفش 👇`;
    }
    await bot.sendMessage(u.telegramChatId, txt, { reply_markup: { inline_keyboard: [[{ text: "🔄 تجديد الاشتراك", callback_data: "RENEW" }]] } });
    await docRef.update({ ['reminders.' + key]: true });
    return true;
}

async function runReminders() {
    const now = Date.now();
    let sent = 0;
    // المشتركين: اللي باقي لهم 3 أيام أو أقل أو خلصوا من يومين
    const act = await db.collection('users')
        .where('expiresAt', '>=', Timestamp.fromMillis(now - 2 * DAY))
        .where('expiresAt', '<=', Timestamp.fromMillis(now + 3.5 * DAY)).get();
    for (const d of act.docs) {
        const u = d.data();
        if (u.status !== 'active') continue;
        try { if (await remindUser(d.ref, u, u.expiresAt.toMillis(), 'sub')) sent++; } catch (e) { console.error("remind", d.id, e.message); }
    }
    // الفترة التجريبية
    const cfg = await getConfig();
    const tr = await db.collection('users')
        .where('createdAt', '>=', Timestamp.fromMillis(now - (cfg.trialDays + 30) * DAY))
        .where('createdAt', '<=', Timestamp.fromMillis(now - (cfg.trialDays - 3.5) * DAY)).get();
    for (const d of tr.docs) {
        const u = d.data();
        if (u.status === 'active' || !u.createdAt) continue;
        const end = u.createdAt.toMillis() + (cfg.trialDays + (parseInt(u.trialBonusDays) || 0)) * DAY;
        if (end < now - 2 * DAY) continue;
        try { if (await remindUser(d.ref, u, end, 'trial')) sent++; } catch (e) { console.error("remind trial", d.id, e.message); }
    }
    return sent;
}

let jobsRunning = false;
async function runJobs(reason) {
    if (!db || jobsRunning) return { skipped: true };
    jobsRunning = true;
    try {
        const notified = await processOrderNotifications();
        const reminded = await runReminders();
        console.log(`Jobs (${reason}): ${notified} order notifications, ${reminded} reminders`);
        return { notified, reminded };
    } catch (e) {
        console.error("Jobs failed:", e);
        return { error: e.message };
    } finally { jobsRunning = false; }
}

// ==================== سيرفر التراخيص ====================
async function issueLicense(body) {
    if (!db || !licenseKey) return { code: 503, json: { ok: false, error: 'license_disabled' } };
    const idToken = String(body.idToken || '');
    const machineId = String(body.machineId || '').slice(0, 100);
    if (!idToken) return { code: 400, json: { ok: false, error: 'bad_request' } };

    let decoded;
    try { decoded = await authAdmin.verifyIdToken(idToken); }
    catch { return { code: 401, json: { ok: false, error: 'bad_token' } }; }

    const ref = db.collection('users').doc(decoded.uid);
    const snap = await ref.get();
    if (!snap.exists) return { code: 404, json: { ok: false, error: 'no_user' } };
    const user = snap.data();
    const cfg = await getConfig();
    const sub = await computeSubscription(user, cfg);

    let status = sub.status;
    const devices = Array.isArray(user.devices) ? user.devices : [];
    if (status !== 'expired' && machineId && !devices.includes(machineId)) status = 'device';

    const now = Date.now();
    const payload = {
        v: 1, uid: decoded.uid, email: decoded.email || user.email || '', machineId,
        status, plan: sub.plan, features: status === 'active' || status === 'trial' ? sub.features : null,
        expiresAt: sub.expiresAt || 0, iat: now,
        exp: status === 'active' || status === 'trial' ? Math.min(now + LICENSE_VALID_MS, sub.expiresAt) : now + DAY
    };
    const p64 = b64url(JSON.stringify(payload));
    const sig = crypto.sign('sha256', Buffer.from(p64, 'ascii'), { key: licenseKey, dsaEncoding: 'ieee-p1363' });
    ref.update({ lastLicenseAt: FieldValue.serverTimestamp() }).catch(() => { });
    return { code: 200, json: { ok: true, license: p64 + '.' + b64url(sig) } };
}

function readBody(req, limit = 20000) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too_large')); req.destroy(); } });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    try {
        if (useWebhook && req.method === 'POST' && p === webhookPath) {
            if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) { res.writeHead(401); return res.end(); }
            const body = await readBody(req, 1e6);
            res.writeHead(200); res.end('OK');   // نرد فوراً عشان تيليجرام مايعيدش الإرسال
            try { bot.processUpdate(JSON.parse(body)); } catch (e) { console.error("Bad update:", e.message); }
            return;
        }
        if (req.method === 'POST' && p === '/license') {
            let body = {};
            try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: 'bad_request' }); }
            const r = await issueLicense(body);
            return sendJson(res, r.code, r.json);
        }
        if (p === '/cron/run') {
            const key = url.searchParams.get('key') || req.headers['x-cron-key'] || '';
            if (!cronSecret || key.length !== cronSecret.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cronSecret)))
                return sendJson(res, 403, { ok: false });
            const r = await runJobs('cron');
            return sendJson(res, 200, { ok: true, ...r });
        }
        res.writeHead(200);
        res.end('Bot is running!');
    } catch (e) {
        console.error("HTTP error:", e.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false });
    }
});

server.listen(process.env.PORT || 3000, async () => {
    console.log("HTTP server listening on", process.env.PORT || 3000);
    if (useWebhook) {
        try {
            await bot.setWebhook(publicUrl + webhookPath, { secret_token: webhookSecret });
            console.log("Webhook set:", publicUrl + "/telegram/***");
        } catch (e) { console.error("Failed to set webhook:", e.message); }
    } else {
        console.log("Polling mode (no RENDER_EXTERNAL_URL)");
    }

    if (db) {
        // أول ما السيرفر يصحى نشغل المهام، وبعدين كل 3 ساعات طول ما هو صاحي
        setTimeout(() => runJobs('startup'), 15_000);
        setInterval(() => runJobs('interval'), 3 * 60 * 60 * 1000);
        // إشعار فوري لما الأدمن يفعّل طلب (وقت ما السيرفر صاحي)
        db.collection('orders').where('userNotified', '==', false).onSnapshot(
            snap => snap.docChanges().forEach(ch => { if (ch.type !== 'removed') notifyOrder(ch.doc).catch(e => console.error("notify", e.message)); }),
            e => console.error("orders listener:", e.message));
    }
});

bot.on('error', e => console.error("Bot error:", e.message));
bot.on('polling_error', e => console.error("Polling error:", e.message));
process.on('unhandledRejection', e => console.error("Unhandled:", e && e.message ? e.message : e));
process.on('uncaughtException', e => console.error("Uncaught:", e && e.message ? e.message : e));

console.log("Video Downloader Pro bot is running...");

// للاختبارات بس
module.exports = { issueLicense, computeSubscription, checkCoupon, runJobs, server };
