# GET جاهز للتحقق من Meta — 21 نوفمبر 2026

أكد المستخدم حفظ Secret. تحقق الاسم META_VERIFY_TOKEN ونوع secret_text من metadata دون قراءة قيمته. نُشر GET فقط على Worker Mandob الحالي، بالنسخة 53dbfe10-5580-4f3e-8479-3557d39c1cd2.

نتائج السحابة:
- ALLOW_META_WEBHOOK_VERIFY=true وSecret باقٍ بعد النشر.
- GET بـmode صحيح وقيمة اختبار خاطئة رُفض 403.
- POST رُفض 503 قبل معالجة الرسائل.
- /api/items بلا جلسة رُفض 401.
- صفوف اعتماد المالك وجلساته مطابقة قبل/بعد.
- الاستقبال العام/التجريبي والإدارة في Messenger وكل الإرسال والذكاء الاصطناعي والصور وتسجيل مسؤول جديد ما زالت false؛ FREE_ONLY=true. لا موارد أو اشتراكات أو AI/Meta send calls جديدة.

الرابط الجاهز: https://mandob-baghdad-api.husseinfadhil8.workers.dev/webhooks/meta/messenger

المتبقي: يدخل المستخدم الرابط في Callback URL داخل Meta Messenger API Setup، ويلصق القيمة التي يحتفظ بها على هاتفه في Verify Token، ثم Verify and save. لا يرسل القيمة للمشغّل أو المحادثة ولا يضعها في URL المتصفح. لا يُفعّل اشتراكات messages أو يضغط اختبار إرسال أو يغير الاستقبال.

التحقق الإيجابي الصحيح مع Meta لم يجرِ بعد؛ لا نعرف قيمة Secret ولا نحتاجها. يؤكد المستخدم نجاح Meta بعد الحفظ. نجاح GET ليس تفعيل استقبال رسائل أو إرسالها، ولا اعتماد App Review أو صلاحيات الصفحة.
