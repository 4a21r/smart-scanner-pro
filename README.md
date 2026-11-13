<div dir="rtl" align="right">

# 🖨️ منظومة الماسح الضوئي الذكي والأرشفة (Smart Scanner Pro v4.0)

![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?style=for-the-badge&logo=windows)
![Electron](https://img.shields.io/badge/Electron-Desktop%20App-47848F?style=for-the-badge&logo=electron)
![Python](https://img.shields.io/badge/Python-WIA%20Scanner%20Bridge-3776AB?style=for-the-badge&logo=python)
![Status](https://img.shields.io/badge/Status-Production%20Ready-10B981?style=for-the-badge)

نظام مكتبي متكامل ومصمم خصيصاً للمؤسسات الأكاديمية والدوائر الرسمية لإدارة عمليات المسح الضوئي، معالجة الوثائق، أرشفة الكتب الرسمية (الصادرة والواردة)، والإرسال المباشر المشفر عبر البريد الإلكتروني.

---

## ✨ المميزات الرئيسية

### 📑 1. أرشفة الكتب الرسمية (الصادرة والواردة)
* **بطاقة بيانات متكاملة للكتاب:** توثيق (اسم الكتاب/الموضوع، رقم الكتاب/العدد، تاريخ الإرسال/الحفظ التلقائي، الجهة المرسلة، والجهة المستلمة).
* **تسمية ذكية وتلقائية للملفات:** عند تصدير ملفات PDF أو الصور، يقوم النظام تلقائياً بتسمية الملف بالبيانات الرسمية الكاملة لسهولة الفهرسة والأرشفة.
* **إدارة المشاريع المسودة والمحفوظة:** حفظ جلسات العمل واسترجاعها في أي وقت مع عرض تفصيلي لبيانات كل معاملة.

### 🖨️ 2. محرك مسح ضوئي متقدم (Hardware WIA Bridge)
* **دعم كامل للسحب الآلي (ADF / Feeder) والمسطح (Flatbed):** متوافق مع طابعات وماسحات HP وكافة الأجهزة الداعمة لبروتوكول Windows Image Acquisition.
* **دعم السحب للوجهين (Duplex Scanning):** خوارزمية ذكية للتعامل مع الحساسات وسحب كافة الأوراق المتاحة بدقة تصل إلى 600 DPI.
* **استيراد متعدد الصيغ:** إمكانية دمج ملفات PDF وصور خارجية مع الأوراق المسحوبة ضوئياً في مشروع واحد.

### 🎨 3. معالجة وتحسين الوثائق
* **قص ذكي ويدوي رباعي النقاط (Perspective Crop):** تحديد زوايا الورقة بدقة وتعديل ميلان المستندات والهويات.
* **فلاتر وتحسينات بصرية:** التحكم بالسطوع، التباين، الحدة، التشبع، وميزة تنظيف الخلفية والظلال لتبييض خلفية الكتب الرسمية وجعلها جاهزة للطباعة.

### 📧 4. نظام إرسال بريدي مؤسسي ومشفر
* **إدارة الشُعَب والأقسام المستلمة:** إضافة، تعديل، وحذف الجهات المستلمة بواجهة عربية سهلة.
* **رسائل رسمية منسقة (RTL HTML):** إرسال الكتب الرسمية مع جدول تعريفي كامل ببيانات الكتاب داخل متن الرسالة وبمحاذاة عربية صحيحة 100%.
* **تشفير محلي عالي الأمان (DPAPI / safeStorage):** حفظ بيانات البريد الإلكتروني محلياً لكل جهاز بشكل مستقل ومشفر عبر نظام الحماية الخاص بالويندوز.

---

## 🛠️ التقنيات المستخدمة (Tech Stack)

| المكون | التقنية المستخدمة |
| :--- | :--- |
| **إطار العمل المكتبي** | Electron.js (Node.js + Chromium) |
| **واجهة المستخدم** | HTML5, Tailwind CSS, FontAwesome (تصميم عربي داكن RTL) |
| **معالجة الصور والـ PDF** | HTML5 Canvas API, jsPDF, PDF.js |
| **محرك السكانر** | Python (pywin32 / WIA COM), مجمع كملف تنفيذي عبر PyInstaller |
| **الإرسال والأمان** | Nodemailer, Electron safeStorage (Windows DPAPI) |

---

## 🚀 طريقة التشغيل والتطوير (Development)

    cd desktop/smart-scanner
    npm install
    pip install -r requirements.txt
    npm start

---

## 📦 بناء نسخة التنصيب النهائية (Setup.exe)

    cd desktop/smart-scanner
    python -m PyInstaller --onedir --noupx --noconsole --distpath . --name scanner scanner.py
    Copy-Item -Path "scanner" -Destination "scanner_bin" -Recurse -Force
    npm run build

---

## 👨‍💻 تطوير وتصميم
**عبد الرحمن سالم جاسم (Abdulrahman Salim)**  
هندسة البرمجيات – جامعة نينوى

</div>
