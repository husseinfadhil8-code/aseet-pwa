# نتيجة إصلاح الاتصال والاختبار الوحيد — 20 نوفمبر 2026

## النتيجة

نجح اتصال المعاينة ومصادقتها، ثم نجح استدعاء واحد فقط لـGemma عبر env.AI.run وأعاد HTTP 200 مع usage. لم يرجع نص جواب نهائي: content فارغ وfinish_reason=length؛ حد 32 output tokens استُهلك في التوليد/الاستدلال قبل النص النهائي. لا إعادة محاولة ولا رفع للحد أو تغيير للنموذج.

## ما عُزل وأُصلح

- البيئة تحتاج وسيط HTTP/HTTPS؛ المرور المباشر خارجها مرفوض. لم نحذف proxy أو NO_PROXY ولم نعطل TLS أو نغيّر الشهادات.
- اختبار مضبوط على workerd المحلي نفسه، بلا AI ولا موارد سحابية: المسار الافتراضي أعاد Network connection lost؛ نفس الطلب مع outboundService يمر عبر Undici EnvHttpProxyAgent أعاد HTTP 200 وcf-ray. هذا يثبت خلل المسار الافتراضي في هذه البيئة، لا مشكلة النموذج.
- فحص مصدر Wrangler 4.166.0 أظهر أن Worker الوسيط الداخلي لا يضبط outboundService لتمرير fetch عبر وسيط Node. لذلك لا يكفي تحذير Wrangler العام بأنه اكتشف proxy؛ قد تعمل طلبات control-plane من Node بينما يفشل fetch داخل workerd.
- استُخدم hook النقل الموثق في Miniflare على نسخة اختبارية منفصلة من bundle لنفس Wrangler 4.166.0. لم تُعدّل الحزمة الأصلية أو تثبيت عام أو ملفات الإنتاج. حُذفت النسخة بعد الاختبار.
- الناقل يستعمل EnvHttpProxyAgent ليحترم HTTP_PROXY/HTTPS_PROXY/NO_PROXY، ويحافظ على CA وTLS. يقبل HTTPS لنطاق preview workers.dev فقط، ولا يتبع redirect آلياً ولا يسجل Authorization أو Cookie أو preview tokens أو URL query.
- remote-proxy API يتوقع بنية auth داخلية تختلف عن string token الخام؛ ظهر خطأ تهيئة محلي قبل أي طلب جلسة في المحاولة الأولى وصُحح باستخدام auth الافتراضي لـWrangler. ليس فشل صلاحية من Cloudflare، ولم ينتج عنه استدعاء AI أو جلسة سحابية إضافية ناجحة.

الملف transport-overlay.cjs يحفظ الإصلاح المحلي المقيد بالإصدار مع اختبارات. ليس تحديثاً رسمياً من Cloudflare، ولا يُطبّق تلقائياً على أي إصدار آخر. البلاغ #14848 يتناول keep-alive race لكن الإصلاح موجود بالفعل في النسخة المثبتة؛ لم نغير نسخة عشوائياً أو ننسب هذا الفشل لذلك البلاغ. ولا يوجد دليل حظر Access في الجلسة الناجحة.

## فصل المراحل

1. قراءة control-plane وقائمة Workers: HTTP 200.
2. قراءة الحصة: لا استهلاك AI مسجّل ظاهر، مع هامش 1000 Neurons قبل التنفيذ. Workers Free مؤكدة من صاحب الحساب. التحليلات قد تتأخر ولا تمثل رصيداً محجوزاً.
3. جلسة Proxy/edge-preview واحدة ناجحة، بلا D1 أو R2 أو خدمات إضافية. GET بلا MF-Binding يعيد من كود ProxyServer في Cloudflare رسالة Binding not found المتوقعة وHTTP 400؛ هذه ليست مشكلة مصادقة، بل دليل وصول الطلب إلى الـproxy الصحيح دون أي استدلال. cf-ray: a5da50c3bd918732-WAW.
4. قراءة الحصة مرة أخرى، ثم استدعاء واحد فقط عبر env.AI.run('@cf/google/gemma-4-26b-a4b-it', ...)، بنص المستخدم «گول هلا فقط»، max_tokens=32، temperature=0، دون retry أو Gateway.
5. طلب الاستدلال POST أعاد HTTP 200، cf-ray: a5da50c67845eec3-WAW. زمن الاستجابة المحلي 1625ms.

## الناتج والاستهلاك الفعليان

نص الجواب النهائي حرفياً:

```json
""
```

finish_reason: length. توجد بيانات استدلال داخلية في النتيجة الخام، لا نعرضها كجواب للمستخدم ولا نختلق «هلا». هذا يثبت الاتصال والاستدلال، ولا يكفي لتقييم جودة اللهجة.

usage الصادر في استجابة الخدمة:
- prompt_tokens: 20
- completion_tokens: 32
- total_tokens: 52
- cached_tokens: 0
- neurons: 1.0545454025268555

هذه Neurons مقاسة ومبلّغة في الاستجابة، وليست الحساب التقديري السابق ولا كشف فاتورة نهائياً. التحليلات اليومية بعد التنفيذ لم تلحق بالطلب وقت القراءة، فلا نستنتج منها صفراً. عدّل usageOf للحفاظ على usage.neurons كقيمة فعلية منفصلة عن neurons_estimated.

## الإغلاق والحدود

أُغلقت Miniflare وجلسة remote proxy باستخدام dispose، وانتهت العملية. قائمة Workers الدائمة مطابقة للّقطة السابقة، وGET للـscript المؤقت mandob-ai-network-check أعاد 404، ونسخة SDK الاختبارية أزيلت. لا يثبت ذلك حذف كل بيانات Cloudflare الداخلية فورياً قبل انتهاء صلاحية edge-preview.

لا نشر إنتاجي أو تفعيل Paid أو Gateway أو Messenger أو إنشاء D1/R2. لم تُستخدم بيانات زبائن أو OAuth تفاعلي أو تُطلب مفاتيح من المستخدم. سجل المراحل المنقح لا يحتوي أي أسرار، والسجل الخام يبقى خارج المستودع في مجلد خاص.

55 اختبار كود محلياً نجح بعد التغيير. ثلاثة منها تغطي حواجز إصلاح النقل، واختبار إضافي يحفظ Neurons الفعلية. هذا منفصل عن الاستدعاء الحي الوحيد أعلاه. أي اختبار أكبر أو زيادة output tokens يحتاج نطاقاً معتمداً جديداً؛ لم يُنفذ ضمن هذه المهمة.

مراجع:
- https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md — outboundService
- https://github.com/cloudflare/workers-sdk/issues/14848 — keep-alive issue
- https://github.com/cloudflare/workers-sdk/issues/13642 — Access/remote bindings
