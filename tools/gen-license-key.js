// بيعمل مفتاحين لتوقيع التراخيص (ECDSA P-256):
//  - المفتاح الخاص: بيتطبع هنا عشان تحطه في Render > Environment باسم LICENSE_PRIVATE_KEY (مايتحفظش في أي ملف)
//  - المفتاح العام: بيتكتب في YtDownloaderWebView2/LicenseKey.cs (البرنامج بيتحقق بيه من التوقيع)
// التشغيل (من فولدر TelegramBot):  node tools/gen-license-key.js
// تنبيه: لو عملت مفاتيح جديدة، لازم تحدّث الاتنين مع بعض وتبني البرنامج من جديد.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

const cs = `// اتعمل تلقائي بـ TelegramBot/tools/gen-license-key.js — المفتاح العام بس (آمن يكون في الكود)
namespace YtDownloaderWebView2
{
    internal static class LicenseKey
    {
        public const string PublicKeyPem = @"${pubPem.trim()}";
    }
}
`;

const target = path.join(__dirname, '..', '..', 'YtDownloaderWebView2', 'LicenseKey.cs');
if (fs.existsSync(path.dirname(target))) {
    fs.writeFileSync(target, cs, 'utf8');
    console.log('✅ اتكتب المفتاح العام في:', target);
} else {
    console.log('ماقدرتش ألاقي فولدر YtDownloaderWebView2، انسخ ده في LicenseKey.cs:\n\n' + cs);
}

console.log('\n================ LICENSE_PRIVATE_KEY (حطه في Render > Environment) ================\n');
console.log(Buffer.from(privPem).toString('base64'));
console.log('\n====================================================================================');
console.log('⚠️ المفتاح الخاص ده سر: ماتبعتهوش لحد وماتحطهوش في GitHub.');
