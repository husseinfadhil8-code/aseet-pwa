# تجربة استيراد عروض خارجية لوسيط — غير منشورة
هذه تجربة منفصلة بالكامل عن Worker الحالي، وليست سحباً من فيسبوك. لا توجد بيانات عملاء أو أرقام هواتف ولا إرسال رسائل ولا نشر إعلانات.
تقبل RSS/Atom من مصدر وافق على عرض الملخصات والروابط ضمن شروطه، أو ملفاً محلياً للتجربة.
تستخرج الاسم والوصف والسعر إن وُجد والقسم التقريبي والرابط الأصلي وتحفظها محلياً بـSQLite مع منع التكرار.

```bash
python telegram-market/experiments/external-offers/importer.py --source partner --file authorized-feed.xml
python -m unittest discover -s telegram-market/experiments/external-offers -p 'test_*.py'
```

للقراءة من مصدر متاح ومرخّص:
```bash
python telegram-market/experiments/external-offers/importer.py --source partner --url https://example.org/approved.xml --approved-host example.org
```

* لا تزوّد رابط فيسبوك أو مصدر يشترط تسجيل دخول.
* لا يعيد نشر الصور أو كامل المنشورات ولا يتصل بالبائعين.
* قبل دمجه بواجهة السوق نحتاج مصدراً عراقياً موثوقاً وترخيص عرض واضح، واختبار جلب عروض فعلية.
* لا تغييرات على DB أو main أو البيئة المنشورة.

## معاينة خاصة لبطاقات العروض
بعد استيراد خلاصة مسموحة إلى قاعدة محلية:
```bash
python telegram-market/experiments/external-offers/preview.py --db offers.sqlite3 --output external-preview.html
```
يفتح الملف محلياً ويعرض بطاقات بالعربية مع المصدر والسعر ورابط الإعلان الأصلي؛ لا يرفع الملف إلى Cloudflare أو القناة. لا تُرسل صور أو هواتف. اختبارات `test_preview.py` تتأكد من ترميز النصوص الخارجية ورفض الروابط غير الآمنة.
