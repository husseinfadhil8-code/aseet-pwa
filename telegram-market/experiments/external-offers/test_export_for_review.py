import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from export_for_review import package
class ExportTests(unittest.TestCase):
    def test_review_only_and_dedup(self):
        x={"display_permission_verified_by_operator":True,"publicly_published":False,"offers":[{"external":True,"title":"ثلاجة","url":"https://example.org/1","source":"Test","price_iqd":120000},{"external":True,"title":"ثلاجة","url":"https://example.org/1","source":"Test"}]}
        a=package(x)
        self.assertEqual(len(a["items"]),1)
        self.assertFalse(a["auto_publish"])
        self.assertEqual(a["items"][0]["status"],"pending_review")
    def test_requires_private_review(self):
        with self.assertRaises(ValueError):package({"offers":[]})
    def test_blocks_unsafe_link(self):
        x={"display_permission_verified_by_operator":True,"publicly_published":False,"offers":[{"external":True,"title":"X","url":"javascript:alert(1)"}]}
        self.assertEqual(package(x)["items"],[])
if __name__=="__main__":unittest.main()
