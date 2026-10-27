"""Read-only, offline adapter for ReefAPI OpenSooq Iraq search results.
Never fetches private data, sends messages, or republishes listings.
Only use output as a private technical preview pending source permission.
"""
import argparse, json, pathlib, urllib.parse, html

def convert(payload):
    if not isinstance(payload,dict) or payload.get("ok") is not True:
        raise ValueError("Expected successful ReefAPI response")
    data=payload.get("data")
    if not isinstance(data,dict): raise ValueError("Missing data object")
    # API wrappers may place search rows at either key; unexpected shapes fail closed.
    listings=data.get("listings",data.get("items"))
    if not isinstance(listings,list): raise ValueError("Missing listing array; inspect current API schema")
    results=[]
    for item in listings[:30]:
        if not isinstance(item,dict):continue
        url=item.get("url",item.get("listing_url"))
        if not isinstance(url,str):continue
        u=urllib.parse.urlsplit(url)
        if u.scheme!="https" or not u.hostname or not (u.hostname=="opensooq.com" or u.hostname.endswith(".opensooq.com")):continue
        title=item.get("title")
        if not isinstance(title,str) or not title.strip():continue
        # No seller names, phone numbers, photo URLs, or complete descriptions.
        results.append({"title":title.strip()[:180],"url":url,"source":"OpenSooq Iraq (technical preview only)","price":item.get("price") if isinstance(item.get("price"),(int,float,str)) else None,"location":item.get("city") if isinstance(item.get("city"),str) else None})
    return results

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--file",required=True,help="Authorized JSON test export; NEVER share private seller data")
    p.add_argument("--output",required=True)
    args=p.parse_args()
    raw=pathlib.Path(args.file).read_bytes()
    if len(raw)>2_000_000:raise ValueError("Input too large")
    results=convert(json.loads(raw))
    pathlib.Path(args.output).write_text(json.dumps({"preview_only":True,"country":"iq","offers":results},ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Validated {len(results)} public listing links for offline preview only.")
if __name__=="__main__":main()
