# EpicTalk 🚀

> منصة دردشة ومكالمات فيديو متكاملة | Chat & Video Calls Platform

![EpicTalk Banner](https://i.imgur.com/placeholder.png)

## ✨ المميزات

| الميزة | الوصف |
|--------|-------|
| 🔐 **Auth كاملة** | تسجيل دخول بالبريد + Google OAuth |
| 💬 **رسائل فورية** | Realtime chat مع Supabase |
| 📹 **مكالمات فيديو** | WebRTC + Supabase signaling |
| 📞 **مكالمات صوتية** | Audio-only calls |
| 👥 **مجموعات** | إنشاء وإدارة غرف المجموعات |
| 🔔 **إشعارات** | Real-time notifications + browser push |
| 🖥 **مشاركة الشاشة** | Screen sharing أثناء المكالمات |
| 📎 **مشاركة الملفات** | رفع الصور والملفات |
| 🟢 **حالة الاتصال** | Online / Away / Busy / Offline |
| 🌙 **تصميم Glassmorphism** | واجهة داكنة فاخرة RTL عربية |
| 📱 **متجاوب** | يعمل على الجوال والحاسوب |
| 🔒 **RLS آمنة** | Row Level Security على كل الجداول |

---

## 🛠️ خطوات الإعداد الكاملة

### الخطوة 1: إنشاء مشروع Supabase

1. اذهب إلى **[supabase.com](https://supabase.com)** وأنشئ حساباً
2. اضغط **"New Project"** واملأ البيانات
3. انتظر حتى يتم إنشاء المشروع (~2 دقيقة)
4. اذهب إلى **Project Settings → API** واحفظ:
   - `Project URL` → مثال: `https://abcxyz.supabase.co`
   - `anon / public` key → يبدأ بـ `eyJ...`

### الخطوة 2: تشغيل Schema قاعدة البيانات

1. في Supabase Dashboard اذهب إلى **SQL Editor**
2. اضغط **"New Query"**
3. انسخ كامل محتوى ملف `supabase/schema.sql`
4. اضغط **"Run"** ✅

### الخطوة 3: إنشاء Storage Buckets

1. في Supabase اذهب إلى **Storage**
2. اضغط **"New Bucket"** → اسمه: `avatars` → ✅ Public
3. اضغط **"New Bucket"** → اسمه: `attachments` → ❌ Private

### الخطوة 4: تفعيل Google Auth (اختياري)

1. في Supabase: **Authentication → Providers → Google**
2. فعّله وأضف:
   - `Client ID` من Google Cloud Console
   - `Client Secret`
3. أضف redirect URL: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`

### الخطوة 5: ضبط إعدادات المشروع

افتح **`js/config.js`** وعدّل هذين السطرين:

```javascript
const SUPABASE_URL     = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

---

## 🐙 رفع المشروع على GitHub

### إنشاء Repo جديد

```bash
# 1. تهيئة Git
git init
git add .
git commit -m "🚀 Initial EpicTalk commit"

# 2. إنشاء repo على GitHub (عبر الموقع أو CLI)
gh repo create epictalk --public --source=. --remote=origin --push

# أو يدوياً:
git remote add origin https://github.com/YOUR_USERNAME/epictalk.git
git branch -M main
git push -u origin main
```

### نشر على GitHub Pages (مجاناً)

1. اذهب إلى **Settings** في الـ repo
2. قسم **Pages** → Source: **Deploy from a branch**
3. Branch: **main** → Folder: **/ (root)**
4. اضغط **Save**
5. رابطك سيكون: `https://YOUR_USERNAME.github.io/epictalk`

> ⚠️ **مهم:** بعد النشر، أضف رابط GitHub Pages في:
> - Supabase: **Authentication → URL Configuration → Site URL**
> - Supabase: **Authentication → Redirect URLs** أضف `https://YOUR_USERNAME.github.io/epictalk/**`

---

## 📁 هيكل الملفات

```
epictalk/
├── 📄 index.html              ← صفحة تسجيل الدخول / إنشاء الحساب
├── 📄 app.html                ← التطبيق الرئيسي الكامل
│
├── 📁 js/
│   ├── config.js              ← Supabase client + AppState + UI helpers
│   ├── auth.js                ← تسجيل الدخول، إنشاء الحساب، OAuth
│   ├── app.js                 ← منطق التطبيق: غرف، رسائل، إشعارات
│   └── video.js               ← WebRTC مكالمات الفيديو والصوت
│
├── 📁 supabase/
│   └── schema.sql             ← الجداول + RLS + Triggers + Functions
│
└── 📄 README.md               ← دليل الإعداد (هذا الملف)
```

---

## 🗃️ قاعدة البيانات

### الجداول

| الجدول | الوصف |
|--------|-------|
| `profiles` | بيانات المستخدمين (اسم، صورة، حالة) |
| `rooms` | غرف المحادثة (مباشرة أو مجموعات) |
| `room_members` | أعضاء كل غرفة مع الأدوار |
| `messages` | الرسائل (نص، صورة، ملف، مكالمة) |
| `notifications` | الإشعارات لكل مستخدم |
| `calls` | سجل المكالمات + WebRTC signaling |

### Realtime مفعّل على:
- `messages` → رسائل فورية
- `notifications` → إشعارات فورية
- `calls` → signaling المكالمات
- `profiles` → تحديث حالة الاتصال

---

## 📹 كيف تعمل مكالمات الفيديو

```
المتصل (Initiator)              Supabase               المستقبل (Receiver)
      │                              │                         │
      │── إنشاء call record ──────>  │                         │
      │── إنشاء SDP offer ────────>  │                         │
      │                              │ ── إشعار واردة ──────>  │
      │                              │                         │── قبول المكالمة
      │                              │  <── SDP answer ────────│
      │  <── تلقي answer ────────────│                         │
      │                              │                         │
      │═══════ WebRTC ICE Candidates عبر Supabase Realtime ════│
      │                              │                         │
      │═══════════════ اتصال مباشر P2P مشفر ══════════════════│
```

---

## 🔒 الأمان

- ✅ **RLS** على كل الجداول - المستخدم يرى بياناته فقط
- ✅ **JWT** مشفر لكل جلسة
- ✅ **Supabase Auth** يتولى إدارة كلمات المرور
- ✅ **WebRTC** اتصال مشفر E2E
- ✅ **Storage policies** تمنع الوصول غير المصرح

---

## 🚧 خطوات مستقبلية (Roadmap)

- [ ] تشفير E2E للرسائل
- [ ] تطبيق موبايل (PWA)
- [ ] ردود الفعل (Reactions) على الرسائل
- [ ] اقتباس الرسائل (Reply)
- [ ] مكالمات جماعية (Group calls)
- [ ] TURN server لجودة مكالمات أفضل
- [ ] بحث في الرسائل
- [ ] تثبيت الرسائل (Pinned messages)

---

## 🛠️ تقنيات مستخدمة

| التقنية | الاستخدام |
|---------|-----------|
| **HTML5 / CSS3 / Vanilla JS** | Frontend بدون frameworks |
| **Supabase** | Backend as a Service (PostgreSQL + Auth + Realtime + Storage) |
| **WebRTC** | مكالمات الفيديو والصوت P2P |
| **Supabase Realtime** | Signaling للمكالمات + رسائل فورية |
| **GitHub Pages** | Hosting مجاني |

---

## 📞 الدعم

إذا واجهت أي مشكلة، افتح **Issue** على GitHub.

---

<div align="center">
  صُنع بـ ❤️ | EpicTalk © 2025
</div>
