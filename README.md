# واتس CRM — WhatsApp Customer Service Manager

منصة إدارة خدمة عملاء كاملة عبر الواتساب مع دعم أرقام متعددة وفريق عمل.

## المميزات
- ✅ ربط أرقام واتساب متعددة عبر QR Code
- ✅ استقبال وإرسال الرسائل في لوحة تحكم واحدة
- ✅ تعيين المحادثات للموظفين
- ✅ متابعة أداء كل موظف
- ✅ تقييم العملاء (نجوم)
- ✅ إحصائيات تفصيلية
- ✅ Real-time بدون إعادة تحميل الصفحة

## التشغيل المحلي

```bash
# نسخ المشروع
git clone <your-repo>
cd whatsapp-crm

# تثبيت المكتبات
npm install

# إنشاء ملف البيئة
cp .env.example .env

# تشغيل المشروع
npm start
# أو للتطوير:
npm run dev
```

افتح المتصفح على: http://localhost:3000

## الرفع على GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USER/whatsapp-crm.git
git push -u origin main
```

## ⚠️ مهم: لماذا لا Vercel؟

**whatsapp-web.js تستخدم Puppeteer (متصفح Chrome في الخلفية)** — هذا لا يعمل على Vercel لأن:
1. Vercel بيشغل serverless functions بس (مش persistent server)
2. Puppeteer محتاج Chrome مثبت ومساحة كبيرة
3. الاتصال محتاج يفضل مفتوح طول الوقت

### ✅ البدائل المناسبة للرفع المجاني:

| المنصة | الخطة المجانية | سهولة |
|--------|---------------|-------|
| **Railway** | $5 credit شهرياً | ⭐⭐⭐⭐⭐ |
| **Render**  | Free tier (sleep after 15min) | ⭐⭐⭐⭐ |
| **Fly.io**  | 3 VMs مجاناً | ⭐⭐⭐ |

### الرفع على Railway (الأسهل):

1. اعمل حساب على [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. اختار الـ repo
4. Railway هيكتشف تلقائياً إنه Node.js ويشغله
5. ستحصل على رابط مثل: `https://whatsapp-crm-production.up.railway.app`

### إضافة Puppeteer للـ Production:

في `server.js` الـ Puppeteer args موجودة بالفعل (`--no-sandbox` إلخ).  
على Railway/Render لازم تضيف buildpack للـ Chrome:

```bash
# في Railway: أضف variable
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
```

أو استخدم الـ Docker image:

```dockerfile
# Dockerfile (اختياري)
FROM ghcr.io/puppeteer/puppeteer:latest
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server.js"]
```

## هيكل الملفات

```
whatsapp-crm/
├── server.js      # Express + Socket.io + WhatsApp logic
├── database.js    # SQLite (better-sqlite3)
├── package.json
├── .env.example
└── public/
    └── index.html # Dashboard SPA كامل
```

## .gitignore المقترح

```
node_modules/
.env
data.db
.wwebjs_auth/
.wwebjs_cache/
```
