const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const firebase = require('firebase/app');
require('firebase/firestore');

// الأسرار بتتقري من متغيرات البيئة (Render > Environment)، مش من الكود
const token = process.env.BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const paymentNumber = process.env.PAYMENT_NUMBER;

if (!token || !adminChatId || !paymentNumber) {
    console.error("Missing env vars: BOT_TOKEN, ADMIN_CHAT_ID, PAYMENT_NUMBER");
    process.exit(1);
}

// على Render بنستخدم Webhook: تيليجرام بيبعت الرسالة للسيرفر فيصحّيه لو كان نايم.
// محلياً (من غير RENDER_EXTERNAL_URL) بنرجع لـ polling عشان التجربة.
const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";
const useWebhook = publicUrl.startsWith("https://");
const webhookSecret = process.env.WEBHOOK_SECRET || require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 32);
const webhookPath = "/telegram/" + webhookSecret;

const bot = useWebhook ? new TelegramBot(token) : new TelegramBot(token, { polling: true });

const firebaseConfig = {
    apiKey: "AIzaSyBeLAM_PeieqjvwVdqbp3rh3lzS8Oz5JxM",
    authDomain: "videodownloaderpro-c7d45.firebaseapp.com",
    projectId: "videodownloaderpro-c7d45",
    storageBucket: "videodownloaderpro-c7d45.firebasestorage.app",
    messagingSenderId: "481931785419",
    appId: "1:481931785419:web:4bbc9fe7a3ad4cc6d9174e"
};
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

const userStates = {};

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    // Clear any existing state
    delete userStates[chatId];

    try {
        const snapshot = await db.collection("packages").get();
        if (snapshot.empty) {
            bot.sendMessage(chatId, "عفواً لا توجد باقات متاحة الآن. يرجى المحاولة لاحقاً.");
            return;
        }

        let buttons = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            buttons.push([{ text: `💎 ${data.name} - ${data.price}`, callback_data: `PKG_${data.name}_${data.price}` }]);
        });

        const welcomeMessage = `مرحباً بك في Video Downloader Pro! 🚀\n\nالرجاء اختيار الباقة التي تناسبك من الأسفل:`;
        bot.sendMessage(chatId, welcomeMessage, {
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (error) {
        console.error("Error fetching packages:", error);
        bot.sendMessage(chatId, "حدث خطأ أثناء جلب الباقات. تواصل مع الدعم.");
    }
});

bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;

    if (data.startsWith('PKG_')) {
        const parts = data.split('_');
        const pkgName = parts[1];
        const pkgPrice = parts[2];
        
        userStates[chatId] = {
            step: 'ASK_NAME',
            package: pkgName,
            price: pkgPrice
        };

        const replyText = `✅ تم اختيار باقة: ${pkgName} (${pkgPrice})\n\nالرجاء إدخال الاسم بالكامل:`;
        bot.sendMessage(chatId, replyText);
        bot.answerCallbackQuery(callbackQuery.id);
    }
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text && msg.text.startsWith('/')) return;

    if (!userStates[chatId]) {
        if (chatId.toString() !== adminChatId.toString()) {
            bot.sendMessage(chatId, "الرجاء إرسال /start للبدء واختيار باقة.");
        }
        return;
    }

    const state = userStates[chatId];

    if (state.step === 'ASK_NAME') {
        state.name = msg.text;
        state.step = 'ASK_EMAIL';
        bot.sendMessage(chatId, "الرجاء إدخال البريد الإلكتروني (الإيميل) الذي قمت بتسجيله في البرنامج:");
    } 
    else if (state.step === 'ASK_EMAIL') {
        state.email = msg.text;
        state.step = 'ASK_PHONE';
        bot.sendMessage(chatId, "الرجاء إدخال رقم الموبايل للتواصل:");
    }
    else if (state.step === 'ASK_PHONE') {
        state.phone = msg.text;
        state.step = 'ASK_RECEIPT';
        let txt = `أخيراً، قم بتحويل مبلغ الاشتراك (${state.price}) إلى حساب فودافون كاش أو إنستاباي على الرقم:\n`;
        txt += `📞 ${paymentNumber}\n\n`;
        txt += `ثم قم بتصوير إيصال التحويل وأرسل صورة التحويل هنا في المحادثة لتأكيد طلبك.`;
        bot.sendMessage(chatId, txt);
    }
    else if (state.step === 'ASK_RECEIPT') {
        if (msg.photo || msg.document) {
            // Forward everything to admin
            let notify = `🔔 *طلب ترخيص جديد!*\n\n`;
            notify += `📦 الباقة: ${state.package} (${state.price})\n`;
            notify += `👤 الاسم: ${state.name}\n`;
            notify += `✉️ الإيميل: ${state.email}\n`;
            notify += `📱 الموبايل: ${state.phone}\n`;
            notify += `💬 يوزر تيليجرام: @${msg.chat.username || 'بدون_يوزر'}`;

            bot.sendMessage(adminChatId, notify).then(() => {
                bot.forwardMessage(adminChatId, chatId, msg.message_id);
            });

            bot.sendMessage(chatId, "✅ تم استلام طلبك وصورة التحويل بنجاح! سيتم مراجعة الطلب وتفعيل حسابك في أقرب وقت ممكن. شكراً لك.");
            
            // Clear state
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "❌ الرجاء إرسال صورة التحويل لاستكمال الطلب. لا ترسل نصاً.");
        }
    }
});

console.log("Telegram Bot Wizard is running...");


// HTTP server: health check + Telegram webhook
const http = require('http');
const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];

    if (useWebhook && req.method === 'POST' && path === webhookPath) {
        if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
            res.writeHead(401); res.end(); return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
            res.writeHead(200); res.end('OK');   // نرد فوراً عشان تيليجرام مايعيدش الإرسال
            try { bot.processUpdate(JSON.parse(body)); }
            catch (e) { console.error("Bad update:", e.message); }
        });
        return;
    }

    res.writeHead(200);
    res.end('Bot is running!');
});

server.listen(process.env.PORT || 3000, async () => {
    console.log("HTTP server listening on", process.env.PORT || 3000);
    if (useWebhook) {
        try {
            await bot.setWebhook(publicUrl + webhookPath, { secret_token: webhookSecret });
            console.log("Webhook set:", publicUrl + "/telegram/***");
        } catch (e) {
            console.error("Failed to set webhook:", e.message);
        }
    } else {
        console.log("Polling mode (no RENDER_EXTERNAL_URL)");
    }
});

bot.on('error', e => console.error("Bot error:", e.message));
// أي رسالة تفشل (مثلاً مستخدم عامل بلوك للبوت) ماتوقعش البوت كله
process.on('unhandledRejection', e => console.error("Unhandled:", e && e.message ? e.message : e));
process.on('uncaughtException', e => console.error("Uncaught:", e && e.message ? e.message : e));
bot.on('polling_error', e => console.error("Polling error:", e.message));
