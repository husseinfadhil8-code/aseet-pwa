#!/usr/bin/env python3
"""Import permitted public RSS/Atom feeds into Waseet external_listings."""
import os, json, urllib.request, urllib.parse, urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
FEEDS = [x.strip() for x in os.environ.get("FREE_RSS_FEEDS", "").split(",") if x.strip()]
MAX_PER_FEED = int(os.environ.get("MAX_ITEMS_PER_FEED", "30"))
SALE_WORDS = ("بيع", "للبيع", "مستعمل", "مستعملة", "شراء", "أثاث", "اثاث", "سيارة", "سيارات",
              "موبايل", "هاتف", "أجهزة", "اجهزة", "أغراض", "اغراض", "عقار", "شقة", "شقه",
              "بغداد", "العراق", "classified", "for sale", "used", "marketplace")

def request(url, method="GET", body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json", "Accept": "application/json",
        "Prefer": "return=minimal"
    })
    with urllib.request.urlopen(req, timeout=25) as response:
        return response.read()

def text_of(node, names):
    for name in names:
        found = node.find(name)
        if found is not None:
            value = "".join(found.itertext()).strip()
            if value:
                return value
    return ""

def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = root.findall(".//item")
    if not items:
        items = [el for el in root.iter() if el.tag.rsplit("}", 1)[-1] == "entry"]
    parsed = []
    for item in items[:MAX_PER_FEED]:
        title = text_of(item, ["title", "{http://www.w3.org/2005/Atom}title"])
        link = text_of(item, ["link"])
        if not link:
            for el in item:
                if el.tag.rsplit("}", 1)[-1] == "link":
                    link = el.attrib.get("href", "")
                    if link: break
        description = text_of(item, ["description", "summary", "content",
                                      "{http://www.w3.org/2005/Atom}summary",
                                      "{http://www.w3.org/2005/Atom}content"])
        parsed.append((title, link, description))
    return parsed

ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
AREA_WORDS = ("بغداد", "البصرة", "بصره", "الموصل", "نينوى", "اربيل", "أربيل", "السليمانية",
              "كركوك", "النجف", "كربلاء", "الحلة", "بابل", "الرمادي", "الأنبار", "ديالى",
              "واسط", "العمارة", "ميسان", "ذي قار", "الناصرية", "الديوانية", "المثنى", "دهوك",
              "الدورة", "الكرادة", "المنصور", "زيونة", "الشعلة", "مدينة الصدر", "الغزالية")

def extract_price(text):
    """Conservatively parse an explicit Iraqi dinar price; unknown formats stay null."""
    normalized = (text or "").translate(ARABIC_DIGITS).replace(",", "").replace("٬", "")
    import re
    patterns = [
        r"(?<!\d)(\d{1,3}(?:[.]\d{3})+|\d{4,})(?:\s*)(?:د\\.?ع|دينار(?:\s+عراقي)?|IQD)\\b?",
        r"(?:السعر|مطلوب|البيع|بـ)\s*[:：]?\s*(\d+(?:[.]\d+)?)\s*(مليون|الف|ألف|آلاف)?"
    ]
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, normalized, re.IGNORECASE)
        if not match:
            continue
        try:
            if index == 0:
                raw = match.group(1).replace(".", "")
                return int(raw) if int(raw) <= 10_000_000_000 else None
            amount = float(match.group(1))
            unit = match.group(2) or ""
            multiplier = 1_000_000 if unit == "مليون" else 1000 if unit in ("الف", "ألف", "آلاف") else 1
            value = int(amount * multiplier)
            return value if 0 <= value <= 10_000_000_000 else None
        except (ValueError, OverflowError):
            return None
    return None

def extract_area(text):
    normalized = text or ""
    for area in AREA_WORDS:
        if area.casefold() in normalized.casefold():
            return area
    return None

def main():
    if not SUPABASE_URL or not SERVICE_KEY:
        raise SystemExit("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY GitHub secret.")
    if not FEEDS:
        print("No RSS feeds configured. Add permitted feed URLs to repository variable FREE_RSS_FEEDS; no listings imported.")
        return
    inserted = skipped = errors = 0
    for feed_url in FEEDS:
        try:
            req = urllib.request.Request(feed_url, headers={"User-Agent": "WaseetPublicFeedImporter/1.0"})
            with urllib.request.urlopen(req, timeout=25) as response:
                items = parse_feed(response.read())
            for title, source_url, description in items:
                title = " ".join(title.split())[:180]
                source_url = source_url.strip()
                if len(title) < 2 or not source_url.startswith(("https://", "http://")):
                    skipped += 1; continue
                if not any(word.casefold() in (title + " " + description).casefold() for word in SALE_WORDS):
                    skipped += 1; continue
                query = urllib.parse.urlencode({"select": "id", "source_url": "eq." + source_url, "limit": "1"})
                existing = json.loads(request(f"{SUPABASE_URL}/rest/v1/external_listings?{query}") or b"[]")
                if existing:
                    skipped += 1; continue
                combined_text = title + " " + description
                row = {
                    "title": title,
                    "description": description[:4000] or None,
                    "asking_price": extract_price(combined_text),
                    "area": extract_area(combined_text),
                    "source_url": source_url,
                    "source_name": urllib.parse.urlparse(feed_url).netloc[:100] or "RSS",
                    "status": "active"
                }
                request(f"{SUPABASE_URL}/rest/v1/external_listings", "POST", row)
                inserted += 1
        except Exception as exc:
            errors += 1
            print(f"Feed failed ({urllib.parse.urlparse(feed_url).netloc}): {type(exc).__name__}: {exc}")
    print(f"Waseet feed import finished at {datetime.now(timezone.utc).isoformat()}: inserted={inserted}, skipped={skipped}, feed_errors={errors}")
    if errors == len(FEEDS):
        raise SystemExit("All configured feeds failed. Check feed URLs and workflow logs.")

if __name__ == "__main__":
    main()
