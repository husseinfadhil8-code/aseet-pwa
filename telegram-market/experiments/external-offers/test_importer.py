import sys, pathlib, sqlite3, unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from importer import import_feed
RSS=b'<rss><channel><item><title>Bike</title><link>https://example.org/item/1</link><description>175000 IQD</description></item></channel></rss>'
class ImporterTests(unittest.TestCase):
    def test_dedup(self):
        db=sqlite3.connect(':memory:')
        self.assertEqual(import_feed(RSS,db,'approved')['new'],1)
        self.assertEqual(import_feed(RSS,db,'approved')['new'],0)
    def test_reject_http(self):
        db=sqlite3.connect(':memory:')
        self.assertEqual(import_feed(RSS.replace(b'https:',b'http:'),db,'approved')['new'],0)
if __name__=='__main__':unittest.main()
