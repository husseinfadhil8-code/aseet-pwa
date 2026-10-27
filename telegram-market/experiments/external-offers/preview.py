"""Generate an OFFLINE preview of approved-feed offers; never publishes to Waseet."""
import argparse, html, pathlib, sqlite3, urllib.parse

def render(offers):
    cards=[]
    for title,price,category,url,source in offers:
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.password:
            continue
        safe=lambda v:html.escape(str(v or ""),quote=True)
        price_text=f"{int(price):,} د.ع" if price is not None else "السعر لدى المصدر"
        cards.append(f'<article class="offer"><span class="tag">عرض خارجي · {safe(source)}</span><h2>{safe(title)}</h2><p>{safe(category)} · {safe(price_text)}</p><a href="{safe(url)}" rel="noopener noreferrer" target="_blank">فتح الإعلان الأصلي</a></article>')
    return '''<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>معاينة عروض خارجية | وسيط</title><style>body{font-family:system-ui;background:#f4f6f7;color:#132b35;max-width:750px;margin:0 auto;padding:20px}h1{font-size:24px}.note{background:#fff4dc;padding:12px;border-radius:12px}.offer{background:white;border:1px solid #e1e5e8;border-radius:16px;padding:18px;margin:12px 0}h2{font-size:18px}.tag{color:#526e64;font-size:13px}a{color:#08695e;font-weight:bold}p{line-height:1.6}</style></head><body><h1>عروض خارجية — معاينة خاصة</h1><p class="note">هذه معاينة محلية فقط. الإعلانات تأتي من مصادر مستقلة، وليست معتمدة أو مباعة بواسطة وسيط. تحقق من حالة الغرض وسعره عند المصدر. لا تُنشر هذه الصفحة للعامة تلقائياً.</p>'''+"".join(cards)+('</body></html>' if cards else '<p>لا توجد عروض مستوردة بعد.</p></body></html>')

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--db",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    with sqlite3.connect(args.db) as db:
        rows=db.execute("SELECT title,price_iqd,category,url,source FROM offers ORDER BY seen DESC LIMIT 40").fetchall()
    pathlib.Path(args.output).write_text(render(rows),encoding="utf-8")
    print(f"Generated private preview with {len(rows)} candidate offers; not published.")
if __name__=="__main__":main()
