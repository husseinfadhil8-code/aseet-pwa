import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from reefapi_iraq_preview import convert
class ReefPreviewTests(unittest.TestCase):
    def test_only_public_source_links_and_no_personal_fields(self):
        data={"ok":True,"data":{"listings":[{"title":"ثلاجة للبيع","url":"https://iq.opensooq.com/ar/listing/123","price":125000,"city":"بغداد","seller_phone":"07700000000"},{"title":"bad","url":"https://evil.example/1","seller_phone":"07700000000"}]}}
        result=convert(data)
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]["title"],"ثلاجة للبيع")
        self.assertNotIn("seller_phone",str(result))
    def test_unknown_schema_rejected(self):
        with self.assertRaises(ValueError):convert({"ok":True,"data":{"strange":[]}})
    def test_error_rejected(self):
        with self.assertRaises(ValueError):convert({"ok":False,"data":{"listings":[]}})
if __name__=="__main__":unittest.main()
