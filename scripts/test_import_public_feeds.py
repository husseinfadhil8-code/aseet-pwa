"""Offline parser tests for Waseet public-feed importer."""
import unittest
import json
import tempfile
from pathlib import Path
from import_public_feeds import extract_area, extract_price, parse_feed, approved_sources


class ImporterTests(unittest.TestCase):
    def test_price_with_arabic_digits(self):
        self.assertEqual(extract_price("السعر ٢٥٠٬٠٠٠ دينار عراقي"), 250000)

    def test_price_million(self):
        self.assertEqual(extract_price("مطلوب 1.5 مليون"), 1500000)

    def test_unknown_price_is_none(self):
        self.assertIsNone(extract_price("السعر قابل للتفاوض"))

    def test_area(self):
        self.assertEqual(extract_area("البيت موجود في بغداد"), "بغداد")
        self.assertIsNone(extract_area("مكان غير محدد"))

    def test_rss_and_atom_links(self):
        rss = '<rss version="2.0"><channel><item><title>للبيع موبايل</title><link>https://example.com/ad/1</link><description>السعر 250000 دينار</description></item></channel></rss>'.encode("utf-8")
        self.assertEqual(parse_feed(rss)[0][1], "https://example.com/ad/1")
        atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>للبيع جهاز</title><link href="https://example.com/ad/2" /><summary>بغداد</summary></entry></feed>'.encode("utf-8")
        self.assertEqual(parse_feed(atom)[0][1], "https://example.com/ad/2")

    def test_no_source_is_implicitly_approved(self):
        with self.assertRaises(ValueError):
            approved_sources(['https://example.invalid/feed'])

    def test_source_permissions_and_expiry_are_required(self):
        feed='https://example.invalid/feed'
        valid={'feed_url':feed,'source_name':'شريك اختبار','republication_allowed':True,
               'mediation_allowed':True,'permission_evidence':'Synthetic test evidence',
               'valid_until':'2026-12-31'}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'sources.json'
            def check(record):
                path.write_text(json.dumps({'sources':[record]}))
                return approved_sources([feed],path,today='2026-10-24')
            self.assertIn(feed,check(valid))
            for changes in ({'republication_allowed':False},{'mediation_allowed':False},
                            {'permission_evidence':''},{'valid_until':'2026-01-01'},
                            {'valid_until':'invalid'}):
                with self.subTest(changes=changes),self.assertRaises(ValueError):
                    check({**valid,**changes})


if __name__ == "__main__":
    unittest.main()
