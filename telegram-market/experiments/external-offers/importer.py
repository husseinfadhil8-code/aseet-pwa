"""Waseet experimental external-offers RSS/Atom importer. Preview only; never publishes."""
import argparse, json, sqlite3, re, datetime, urllib.parse, urllib.request, xml.etree.ElementTree as ET

def import_feed(data, database, source):
    root=ET.fromstring(data)
    items=root.findall(".//item") if root.tag.endswith(("rss","RDF")) else [x for x in root if x.tag.endswith("entry")]
    database.execute("CREATE TABLE IF NOT EXISTS offers(source TEXT,url TEXT,title TEXT,description TEXT,price_iqd INTEGER,category TEXT,seen TEXT, PRIMARY KEY(source,url))")
    new=0
    for entry in items:
        def field(name):
            return next((x for x in entry if x.tag.rsplit("}",1)[-1]==name),None)
        title, link, desc=field("title"),field("link"),field("description")
        if desc is None: desc=field("summary")
        url=(link.get("href") or link.text or "") if link is not None else ""
        p=urllib.parse.urlsplit(url)
        if p.scheme!="https" or not p.hostname or p.username or p.password:continue
        name=re.sub(r"<[^>]+>","",title.text or "").strip() if title is not None else ""
        if not name:continue
        if not p.hostname.endswith((".example", ".invalid")) and p.hostname in ("localhost", "127.0.0.1"):continue
        details=re.sub(r"<[^>]+>","",desc.text or "").strip() if desc is not None else ""
        price=re.search(r"(\d[\d,]{2,})\s*(?:دينار|د\.?ع|IQD)",name+" "+details,re.I)
        category=next((c for c,words in {"سيارات":"سيار|دراجة","عقارات":"عقار|بيت|أرض|شقة","أثاث":"تخم|أثاث|طاولة","أجهزة":"ثلاجة|غسالة|موبايل"}.items() if re.search(words,name+" "+details,re.I)),"غير محدد")
        cur=database.execute("INSERT OR IGNORE INTO offers VALUES (?,?,?,?,?,?,?)",(source,url,name[:180],details[:1000],int(price.group(1).replace(",","")) if price else None,category,datetime.datetime.now(datetime.timezone.utc).isoformat()))
        new+=cur.rowcount
    database.commit()
    return {"examined":len(items),"new":new,"duplicates_or_invalid":len(items)-new}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source",required=True)
    p.add_argument("--file")
    p.add_argument("--url")
    p.add_argument("--approved-host")
    p.add_argument("--db",default="offers.sqlite3")
    a=p.parse_args()
    if bool(a.file)==bool(a.url):p.error("Choose exactly one of --file and --url")
    if a.url:
        u=urllib.parse.urlsplit(a.url)
        if not a.approved_host or u.scheme!="https" or u.hostname!=a.approved_host or u.port not in (None,443):p.error("Approved HTTPS host required")
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):raise ValueError("Redirect refused")
        with urllib.request.build_opener(NoRedirect).open(a.url,timeout=12) as response: data=response.read(2000001)
    else:
        with open(a.file,"rb") as stream:data=stream.read(2000001)
    if len(data)>2000000:raise ValueError("Feed too large")
    with sqlite3.connect(a.db) as db:
        outcome=import_feed(data,db,a.source)
        outcome["preview"]=[dict(zip(("title","price_iqd","category","url"),row)) for row in db.execute("SELECT title,price_iqd,category,url FROM offers WHERE source=? LIMIT 10",(a.source,))]
    print(json.dumps(outcome,ensure_ascii=False,indent=2))
if __name__=="__main__":main()
