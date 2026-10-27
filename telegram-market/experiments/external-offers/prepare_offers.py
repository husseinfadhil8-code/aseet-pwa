"""Safely gate external offers behind explicit source authorization and freshness checks.
This is a local preparation utility; it never publishes offers.
"""
import argparse, datetime, json, pathlib, urllib.parse

def prepare(payload, policy, now=None):
    if not isinstance(policy,dict) or policy.get("approved_for_display") is not True:
        raise ValueError("Source display rights have not been approved")
    if not policy.get("source") or not policy.get("approved_by") or not policy.get("evidence_url"):
        raise ValueError("Missing verifiable source authorization metadata")
    evidence=urllib.parse.urlsplit(policy["evidence_url"])
    if evidence.scheme!="https" or not evidence.hostname:
        raise ValueError("Evidence must be an HTTPS URL")
    if not isinstance(payload,dict) or not isinstance(payload.get("offers"),list):
        raise ValueError("Expected structured offer data")
    now=now or datetime.datetime.now(datetime.timezone.utc)
    permitted=set(policy.get("allowed_hosts",[]))
    approved=[]
    seen=set()
    for offer in payload["offers"][:300]:
        if not isinstance(offer,dict):continue
        url=offer.get("url")
        if not isinstance(url,str):continue
        u=urllib.parse.urlsplit(url)
        if u.scheme!="https" or u.hostname not in permitted or u.username or u.password:continue
        if url in seen:continue
        seen.add(url)
        title=offer.get("title")
        if not isinstance(title,str) or not title.strip():continue
        # Optional age check requires source timestamp; unknown ages are never auto-approved.
        date=offer.get("published_at")
        if not isinstance(date,str):continue
        try:published=datetime.datetime.fromisoformat(date.replace("Z","+00:00"))
        except ValueError:continue
        if published.tzinfo is None:continue
        age=now-published.astimezone(datetime.timezone.utc)
        if age.total_seconds()<0 or age>datetime.timedelta(days=policy.get("max_age_days",7)):continue
        approved.append({"title":title.strip()[:180],"url":url,"source":policy["source"],
                         "category":offer.get("category","غير محدد"),"price_iqd":offer.get("price_iqd"),
                         "published_at":date,"external":True})
    return {"display_permission_verified_by_operator":True,"publicly_published":False,"offers":approved}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--input",required=True)
    p.add_argument("--policy",required=True)
    p.add_argument("--output",required=True)
    a=p.parse_args()
    inp=json.loads(pathlib.Path(a.input).read_text("utf-8"))
    policy=json.loads(pathlib.Path(a.policy).read_text("utf-8"))
    result=prepare(inp,policy)
    pathlib.Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Prepared {len(result['offers'])} authorized, recent offers; nothing published.")
if __name__=="__main__":main()
