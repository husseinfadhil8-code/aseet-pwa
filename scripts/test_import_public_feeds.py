"""Offline parser tests for Waseet public-feed importer."""
import unittest
from import_public_feeds import extract_area, extract_price, parse_feed

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
        rss = b'<rss version="2.0"><channel><item><title>للبيع موبايل</title><link>https://example.com/ad/1</link><description>السعر 250000 دينار</description></item></channel></rss>'
        self.assertEqual(parse_feed(rss)[0][1], "https://example.com/ad/1")
        atom = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>للبيع جهاز</title><link href="https://example.com/ad/2" /><summary>بغداد</summary></entry></feed>'
        self.assertEqual(parse_feed(atom)[0][1], "https://example.com/ad/2")

if __name__ == "__main__":
    unittest.main()
