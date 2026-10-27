"""Produce a deterministic JSON import package for a future Waseet review endpoint.

Does NOT call the Worker, Supabase or Telegram. Requires prepared, rights-reviewed offers.
"""
import argparse, hashlib, json, pathlib, urllib.parse

def package(prepared):
    if not isinstance(prepared,dict) or prepared.get("display_permission_verified_by_operator") is not True or prepared.get("publicly_published") is not False:
        raise ValueError("Offers must pass private source-review preparation")
    offers=prepared.get("offers")
    if not isinstance(offers,list):raise ValueError("Invalid offer list")
    output=[]
    used=set()
    for row in offers:
        if not isinstance(row,dict) or row.get("external") is not True:continue
        url=row.get("url")
        if not isinstance(url,str):continue
        p=urllib.parse.urlsplit(url)
        if p.scheme!="https" or not p.hostname or p.username or p.password:continue
        key=hashlib.sha256(url.encode()).hexdigest()
        if key in used:continue
        used.add(key)
        title=row.get("title")
        if not isinstance(title,str) or not title.strip():continue
        output.append({"external_id":key,"title":title[:180],"source":str(row.get("source",""))[:100],
                       "source_url":url,"category":str(row.get("category","غير محدد"))[:80],
                       "price_iqd":row.get("price_iqd") if isinstance(row.get("price_iqd"),int) and row["price_iqd"]>=0 else None,
                       "published_at":row.get("published_at"),"status":"pending_review"})
    return {"schema_version":1,"destination":"admin_review_only","auto_publish":False,"items":output}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--input",required=True)
    parser.add_argument("--output",required=True)
    a=parser.parse_args()
    data=json.loads(pathlib.Path(a.input).read_text(encoding="utf-8"))
    result=package(data)
    pathlib.Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Prepared {len(result['items'])} records for future admin review. No upload performed.")
if __name__=="__main__":main()
