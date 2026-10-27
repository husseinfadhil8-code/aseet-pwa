import datetime,pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from prepare_offers import prepare
NOW=datetime.datetime(2026,10,27,tzinfo=datetime.timezone.utc)
POLICY={"approved_for_display":True,"approved_by":"operator","evidence_url":"https://example.org/license","source":"test","allowed_hosts":["example.org"],"max_age_days":7}
DATA={"offers":[{"title":"ثلاجة","url":"https://example.org/offer/1","published_at":"2026-10-26T08:00:00Z","price_iqd":150000},{"title":"old","url":"https://example.org/offer/2","published_at":"2026-09-10T00:00:00Z"},{"title":"unsafe","url":"https://evil.example/offer/3","published_at":"2026-10-26T08:00:00Z"}]}
class PrepareTests(unittest.TestCase):
    def test_only_authorized_recent_hosts(self):
        out=prepare(DATA,POLICY,NOW)
        self.assertEqual(len(out["offers"]),1)
        self.assertFalse(out["publicly_published"])
    def test_requires_approval(self):
        with self.assertRaises(ValueError):prepare(DATA,{**POLICY,"approved_for_display":False},NOW)
    def test_requires_timestamp(self):
        self.assertEqual(prepare({"offers":[{"title":"X","url":"https://example.org/x"}]},POLICY,NOW)["offers"],[])
if __name__=="__main__":unittest.main()
