# نسخة Waseet-Test من GitHub Actions — الآيفون فقط

هذا المسار مخصص لـ **Waseet-Test / beyrctbxojpuvhevfyok**، وليس الإنتاج. Workflow اسمه **Manual Waseet-Test encrypted backup** وملفه `.github/workflows/manual-waseet-test-backup.yml`. لا push أو pull_request أو schedule أو تشغيل تلقائي؛ التشغيل الوحيد workflow_dispatch من main. لا migrations ولا تغييرات مصدر ولا Management token جديد.

**حالة التجهيز:** دُمج PR #23 عند `e1f5160` بعد نجاح 182 اختباراً على الرأس المختبر `b40ed94`، وفحص actionlint. نجحت [بروفة workflow_dispatch الحقيقية على GitHub](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40176859974) مع صورة Supabase المثبتة: تصدير fixture محلي وتشفيره وفكّه واستعادته ومطابقته، ثم رفض صف مستعاد عُدّل عمداً. actual_hosted_backup=false وsource_tls_verified=false؛ مرحلة النسخ الحقيقي والرفع skipped، وأكدت Artifacts API أن العدد صفر. هذه شهادة تشغيل الأداة والبروفة فقط، وليست نسخة Test أو تحقق اتصالها.

## ما جرى تجهيزه

- تثبيت مضيف Session pooler و5432 واسم المستخدم `postgres.beyrctbxojpuvhevfyok` وقاعدة postgres. يُرفض URI آخر أو libpq overrides، وتُفرض TLS verify-full وشهادات النظام، وجلسات المصدر read-only مع قراءة علامة `waseet_test_ops.target`. لا fallback إلى رابط إنتاج أو اتصال Codex المرفوض.
- `pg_dump --format=custom --create` لكل القاعدة دون حذف مخططات أو ACL أو ownership أو RLS. تصدير الأدوار والعضويات بـ`pg_dumpall --roles-only --no-role-passwords`. لا تُنقل كلمات مرور أدوار PostgreSQL.
- لقطة معاملات مشتركة للتصدير وجرد الجداول؛ بصمات الصفوف والأعداد والتسلسلات والأدوار والعضويات وlarge objects تبقى داخل الأرشيف المشفر. الأدوار العامة والتسلسلات ليست MVCC transactional؛ تغيرها أثناء العملية قد يفشل المطابقة ولا يُعتبر نجاحاً كاذباً. الجداول الخارجية تتطلب مساراً منفصلاً ويُرفض تجاهل بياناتها.
- تشفير GPG/AES-256 مع salt وS2K، ثم فك تشفير الأرشيف نفسه واستعادته فعلياً في حاوية PostgreSQL منفصلة. صورة العميل وصورة PostgreSQL الرسمية من Supabase مثبتتان بـdigest. لا شبكة أو منافذ أو Docker socket أو ملف اتصال مصدر داخل حاوية الاستعادة. تشغيلها مستخدم postgres دون capabilities، بنظام ملفات read-only ومساحة مؤقتة وحدود موارد.
- الاستعادة تتوقف عند أول خطأ، وتطابق البيانات والمخطط والملكية وACL وRLS والسياسات والأدوار والتسلسلات وlarge objects. الاختلاف الوحيد المطبّع هو هوية grantor لعضويات أدوار pg_* الداخلية التي ينشئها initdb؛ تبقى أسماء تلك العضويات وأعلامها مقارنة. لا إسقاط ACL أو تخطي FK لإعلان نجاح.
- artifact لا يُرفع إلا بعد نجاح الاستعادة والمطابقة. يحتوي ciphertext وSHA256SUMS وverification.json غير الحساس فقط. لا SQL أو dumps مكشوفة أو محتوى صفوف أو أسرار في logs. فشل العملية يحذف الناتج غير المتحقق منه. وضع rehearsal لا يرفع artifact ولا يتلقى أسرار المصدر.

## خطوات Safari القصيرة بعد مراجعة التغيير

1. افتح [إعدادات أسرار Actions للمستودع](https://github.com/husseinfadhil8-code/aseet-pwa/settings/secrets/actions). اختر **New repository secret** وأضف `WASEET_TEST_DATABASE_URL`: رابط **Session pooler لـWaseet-Test** الحالي من Supabase Connect، بكلمة مرور قاعدة Test الحالية وترميز رموزها داخل URI. لا تستخدم Transaction pooler أو رابط الإنتاج، ولا ترسل القيمة بالمحادثة.
2. أضف `WASEET_BACKUP_PASSPHRASE`: عبارة عشوائية قوية لا تقل عن 24 حرفاً؛ يُفضل توليد 32 حرفاً أو أكثر وحفظها في Passwords. تختلف عن كلمة مرور القاعدة. لا تُدخلها في مدخلات Run workflow أو GitHub Variables أو الملفات.
3. افتح [Actions](https://github.com/husseinfadhil8-code/aseet-pwa/actions/workflows/manual-waseet-test-backup.yml) → **Run workflow** → branch **main**. ابدأ بـ`rehearsal` دون confirm أو أسرار؛ هذه بروفة ولا تنشئ نسخة Test. للتصدير الفعلي اختر `backup` واكتب `beyrctbxojpuvhevfyok` في `confirm_test_ref`، ثم Run workflow.
4. بعد نجاح التشغيل الحقيقي، افتح صفحته → **Artifacts** → `Waseet-Test-encrypted-...`، نزّل ZIP ثم Safari → مشاركة → **حفظ في الملفات** إلى iCloud Drive أو على الـiPhone. احتفظ بالـZIP كاملاً وبعبارة التشفير في Passwords منفصلة. مدة artifact **يوم واحد**؛ نزّله فوراً.
5. أعد إرفاق الـZIP المشفر من Files للتحقق من بصمته ونسختك المستقلة؛ لا ترسل عبارة التشفير أو SQL مفكوكاً. يمكن للوكيل مقارنة SHA-256 دون فك التشفير. لا تعتبر النسخة مستقلة عن GitHub حتى حفظها والتحقق منها خارج Actions.

إذا لم تظهر الإعدادات في Safari، استخدم طلب موقع سطح المكتب من قائمة الصفحة. إذا لم يظهر Run workflow، يلزم السماح بـActions وworkflow_dispatch لحسابك في المستودع. لا يلزم منح GITHUB_TOKEN صلاحية write؛ يحتاج هذا Workflow contents:read فقط، ورفع artifact يستخدم اعتماد Actions المؤقت. التكامل الحالي يستطيع قراءة تشغيلات Actions ودفع كود، لكنه تلقى 403 لقراءة إعدادات Actions والأسرار؛ لذلك لا يستطيع إضافة الأسرار أو تأكيد سياسات الإدارة نيابة عنك.

## حدود صريحة قبل أول تشغيل حقيقي

لم يُختبر اتصال Waseet-Test أو كلمة مروره من GitHub حتى إضافة السرّين وتشغيل backup. فشل TCP في Codex ليس فشل runner. لا توجد نسخة فعلية أو ملف Test قابل للتنزيل قبل نجاح التشغيل الحقيقي. البروفات الاصطناعية تثبت الأداة فقط.

استعادة Supabase إلى PostgreSQL منفصل قد تحتاج توافق الامتدادات وإعداداتها؛ الصورة الرسمية تحتوي امتدادات أكثر من vanilla PostgreSQL، لكن لم نثبت توافقها مع المخطط المستضاف قبل الوصول إليه. أي امتداد أو ملكية أو صلاحية غير قابلة للاستعادة ستفشل العملية دون artifact ودون ادعاء اكتمال. لا تعدّل المصدر تلقائياً لتجاوز الخطأ؛ تُراجع طبقة الاستعادة وحدها. المصادقة الفعلية وGoTrue وSMTP/OAuth/JWT وPush وEdge Functions لا تثبتها استعادة SQL.

ملفات Storage الفعلية ليست ضمن pg_dump؛ تدخل metadata فقط، ويصرح manifest بذلك. هذه نسخة PostgreSQL، وليست نسخة شاملة لكل خدمات Supabase. لا تثبت بها أن صور Storage قد نُسخت، ولا ترفع حظر migrations الإنتاج.

مفتاح التشفير الجذري لـVault/الأعمدة المشفرة وإعدادات JWT/OAuth/SMTP الخارجية ليست مضمونة داخل pg_dump؛ نسخ الصفوف المشفرة ومطابقة بصماتها لا يثبت إمكان فكها أو عمل الخدمة بعد الاستعادة.

اختير runner Linux قياسي في مستودع عام، دون تفعيل خدمة مدفوعة أو تغيير فوترة. يشترط توفر الحصة المجانية الحالية لـActions/artifacts. حدود الأداة: قاعدة حتى 1 GiB وciphertext حتى 100 MiB، واحتفاظ يوم واحد؛ لا توسعة مدفوعة تلقائية أو إخفاء خطأ quota. المستودع عام؛ تعامل مع ciphertext المرفوع كقابل للوصول لمن يملك صلاحية تنزيل artifact، واستخدم عبارة قوية. لا تشغل workflow من forks أو PRs ولا تضف الأسرار إلى بيئة تُنفّذ كوداً غير مراجع.
