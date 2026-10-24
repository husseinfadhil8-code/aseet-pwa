# آلية Waseet-Test فقط — متابعة PR #7

هذا امتداد للعمل الموجود في PR #7 وPR #6، وليس مشروعاً جديداً أو ربطاً بالإنتاج. لم يُدمج أي منهما. يبقى config.toml المحلي ومشغّل local_database.py معزولين كما هما، ولم يتغير عنوان التطبيق الأصلي.

## الوجهة والتحقق

أكد المستخدم الرابط الصحيح بعد أن كان النص الأول يحتوي فراغاً:

`https://supabase.com/dashboard/project/beyrctbxojpuvhevfyok`

استُخرج المعرّف منه وفُحصت صيغته ذات العشرين حرفاً، وثُبّت مع الاسم Waseet-Test في `supabase/waseet-test.json`. هذا تحقق من الرابط المدخل، **وليس إثبات اتصال أو تحققاً من اسم المشروع على الخادم**. قبل أي SQL، يجب أن يعيد Management API نفس ref والاسم Waseet-Test والحالة ACTIVE_HEALTHY. المعرّف الأصلي auqxdtbvfonzrlilygjg محظور صراحةً، ولا توجد عودة إلى project-ref محلي أو متغيرات CLI أو DATABASE_URL. لا يُحذف فراغ من المدخل تلقائياً.

## إعدادات الاتصال التي أمكن فحصها

- لم توجد متغيرات SUPABASE/WASEET_TEST أو bindings أسرار في بيئة Codex المتاحة وقت الفحص.
- لا يوجد ملف CLI access-token أو project-ref مرتبط في الجهاز؛ فُحصت حالة الوجود فقط، دون قراءة أسرار.
- سمحت صلاحية GitHub بقراءة PR #6 وPR #7، لكنها رفضت حتى سرد أسماء repository secrets/variables بـ403. لذلك حالتها **غير معروفة**؛ لا نستنتج أنها فارغة.
- ربط Supabase بـGitHub وتعطيل Deploy to production لا يمنحان هذه الجلسة تفويض Management API، ولا يغنيان عن تثبيت الوجهة داخل المشغّل.

حُفظ لاحقاً **متطلب** WASEET_TEST_MANAGEMENT_TOKEN في مسودة إعداد بيئة Codex كقيمة شخصية مرتبطة بوجهة HTTPS api.supabase.com فقط، دون إدخال قيمة أو تطبيقها على الجلسة. تفعيلها يحتاج إدخالها الآمن ومراجعة الإعداد وحفظه ونشر نسخة بيئة Codex؛ هذا لا يعني نشر التطبيق أو دمج main، ولا يُعد تفويضاً تلقائياً لتنفيذ apply.

المطلوب عند السماح بالمرحلة المستضافة: binding آمن باسم `WASEET_TEST_MANAGEMENT_TOKEN` في إعدادات بيئة Codex، وليس قيمة في المحادثة أو ملف GitHub أو أمر shell. يجب أن يسمح الحساب/التفويض بالوصول إلى Waseet-Test فقط قدر الإمكان. حسب OpenAPI الرسمي، فحص المشروع يحتاج OAuth scope `projects:read`، واستدعاء database/query يحتاج `database:write` حتى مع read_only=true. لا ندعي أن كل نوع PAT يمكن تقييده بمشروع واحد؛ حدود الرمز نفسه تحتاج مراجعة، إضافةً إلى حظر الوجهات في البرنامج.

لا نطلب كلمة مرور مدير قاعدة البيانات أو مفتاح service_role/anon/publishable. يرفض المشغّل صيغ مفاتيح API/JWT المعروفة بدل استخدامها كرمز Management. ولا يقرأ أسرار GitHub أو ينسخها منه. لا تحفظ قيمة الرمز في GitHub. يمكن لربط الأسرار عبر وكيل HTTPS استبدال placeholder في Authorization إلى `api.supabase.com` فقط.

## المراحل والاعتماد

1. `plan` غير متصل: يثبت المرجع ومحتوى migrations بالـSHA-256، ويحفظ خطة غير سرية في `.local-database/waseet-test-plan.json` المستثنى من Git. لا ينشئ أي عميل شبكة.
2. `check` يتطلب خطة مطابقة وتفويضاً صريحاً للمرجع وبinding الرمز قبل أول طلب. يفحص هوية المشروع ثم metadata فقط عبر read_only=true، دون طباعة بيانات مستخدمين أو استجابات خام.
3. `apply` يتطلب فوق ذلك الموافقة على SHA-256 للخطة نفسها. يرفض الجداول العامة غير الفارغة عند baseline جديد، أو سجل CLI غير مُدار، أو اختلاف hashes أو ترتيب النسخ. لا ينفذ reset أو adoption أو migration repair أو حذف بيانات.
4. تُرسل الدفعة في **عبارة PostgreSQL DO واحدة**، مع قفل استشاري وإعادة فحص الحالة داخل المعاملة. تُزال BEGIN/COMMIT الخارجية من الملفات القديمة دون تفكيك أجسام الدوال. SQL الملفات المحسوبة بصمتها يُنفذ داخل المعاملة، ويُسجل في supabase_migrations ومع سجل hashes خاص لا يملكه عملاء التطبيق. فشل migration متأخر يعيد السلسلة وسجلاتها كلها. لا توجد إعادة محاولة تلقائية عند فشل اتصال/استجابة قد يكون نتيجته غير معروفة؛ يلزم check لتأكيد التاريخ أولاً.
5. `smoke` المستضاف المجهّز قراءة فقط: يطابق سجل النسخ ويفحص تفعيل RLS ودالة record_sale وحظر INSERT المباشر للمبيعات ومشغّل حماية صلاحيات الحساب وحدود RLS المقيدة. لا ينشئ مستخدمين أو أغراضاً أو مبيعات على الخادم. اختبارات الوظائف والرفض والتزامن تبقى في PostgreSQL المحلي إلى أن تُعتمد اختبارات مستضافة أوسع بصورة مستقلة.

لا يشغّل workflow أي خطوة مستضافة؛ جميع jobs في GitHub Actions محلية داخل حاويات اختبار. لا يؤدي push أو تعديل PR #7 إلى تطبيق Waseet-Test بواسطة هذا المشغّل. كما لم نغير إعدادات Supabase/GitHub integration؛ يجب مراجعة سلوك هذه الخدمة المستقلة قبل تفويض أي تشغيل مستضاف.

وفق [وثائق GitHub integration الرسمية](https://supabase.com/docs/guides/deployment/branching/github-integration)، يمكن لخيار Automatic branching أن ينشئ فروعاً مستضافة ويعيد تشغيل migrations عند كل push. تعطيل Deploy to production لا يثبت أن Automatic branching معطل. لذلك يُحفظ هذا التحضير محلياً دون دفع تحديث PR #7 حتى يُؤكد تعطيل التشغيل التلقائي أو يُمنح تفويض مستقل لتأثيره المستضاف. مجرد نجاح الاختبارات المحلية لا يجيز تجاوز هذه النقطة.

واجهة التشغيل موجودة كي ينفذها الوكيل بعد اكتمال التفويض، دون نسخ SQL أو تعديل ملفات يدوياً:

```bash
# آمن وغير متصل؛ نُفذ فعلياً في هذه المهمة.
PYTHONDONTWRITEBYTECODE=1 python3 scripts/waseet_test.py plan
# الأوامر التالية مجهزة فقط؛ لم تُشغّل على Waseet-Test في هذه المهمة.
PYTHONDONTWRITEBYTECODE=1 python3 scripts/waseet_test.py check --approve beyrctbxojpuvhevfyok
PYTHONDONTWRITEBYTECODE=1 python3 scripts/waseet_test.py apply --approve beyrctbxojpuvhevfyok --plan-sha <approved-plan-sha>
PYTHONDONTWRITEBYTECODE=1 python3 scripts/waseet_test.py smoke --approve beyrctbxojpuvhevfyok
```

إدخال --approve يعني تفويض الاتصال بالهدف المحدد، وإدخال --plan-sha يعني تفويض كتابة هذه الخطة بعينها. وجود الرمز وحده لا يُعد موافقة. لا تُستخدم هذه الأوامر لتجاوز توقف طلبه المستخدم قبل العمليات المستضافة.

واجهة Management API المستخدمة رسمية لكنها موصوفة Beta/experimental: [OpenAPI](https://api.supabase.com/api/v1-json). تعذر التحقق من تشغيلها على المشروع المستضاف دون التفويض؛ صحة الدفعة SQL والتحكم بالوجهة اختُبرا محلياً، وليست هذه دعوى بأن الاتصال المستضاف يعمل.

## الاختبارات

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 scripts/integration_waseet_test.py -v
PYTHONDONTWRITEBYTECODE=1 python3 scripts/integration_migrations.py -v
PYTHONDONTWRITEBYTECODE=1 python3 scripts/integration_rls_privileges.py -v
PYTHONDONTWRITEBYTECODE=1 python3 scripts/browser_app_security.py -v
```

اختبارات safety تمنع إنشاء عميل مستضاف قبل الاعتماد/الرمز، وتختبر حظر الإنتاج والروابط ذات الفراغات وredirects وتسرب الرمز واختلاف الهوية والخطة والتاريخ. اختبارات integration_waseet_test تنفذ **نفس دفعة SQL المجهّزة** على PostgreSQL داخل حاوية بلا شبكة، لا على API مستضاف، وتختبر التراجع المتأخر والتزامن وإعادة التنفيذ ورفض التاريخ غير المُدار والبيانات الموجودة وتغير المخطط بعد preflight.

## نقطة التوقف الحالية

الرابط مثبت من تأكيد المستخدم، والخطة جاهزة، لكن لا يوجد رمز متاح أو تفويض إضافي للعمليات المستضافة. لم نفحص بيانات Waseet-Test أو وجود جداول فيه، ولم نطبق عليه migration. إذا كانت GitHub integration قد أنشأت تاريخ migrations أو جداول مسبقاً، فسيرفض المشغّل adoption التلقائي ويتوقف للمراجعة بدلاً من تجاوز التاريخ. عند توفير binding آمن وتفويض check نستأنف من فحص الهوية والقراءة فقط، ثم نعرض الحالة قبل طلب اعتماد apply.
