"""Static guardrails for proposed public market SQL; not a live RLS test."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / "supabase"

class MarketSecurityContractTests(unittest.TestCase):
    def test_thread_identity_enforced_in_database(self):
        sql = (ROOT / "public-market-chat-phase1.sql").read_text()
        self.assertIn("create trigger market_thread_identity_guard", sql.lower())
        self.assertIn("l.seller_id = new.seller_id", sql)
        self.assertIn("l.status = 'active'", sql)
        self.assertIn("buyer_id=(select auth.uid())", sql)
        self.assertIn("sender_id=(select auth.uid())", sql)

    def test_inbox_uses_rls_scoped_listing_titles(self):
        js = (ROOT.parent / "public-market.js").read_text()
        inbox = js.split("async function inbox(){", 1)[1].split("async function conversation(", 1)[0]
        self.assertIn("from('market_listings').select('id,title').in('id',ids)", inbox)
        self.assertIn("titles.get(thread.listing_id)||'إعلان غير متاح'", inbox)
        self.assertNotIn("thread.listing_id.slice(0,8)", inbox)

    def test_client_prevalidates_entire_photo_batch(self):
        js = (ROOT.parent / "public-market.js").read_text()
        section = js.split("form.addEventListener('submit',async e=>{", 1)[1].split("async function startThread", 1)[0]
        preflight = section.index("for(const file of selected){")
        second_pass = section.index("for(const file of selected){", preflight + 1)
        first_upload = section.index(".upload(path,file", second_pass)
        self.assertLess(preflight, second_pass)
        self.assertLess(second_pass, first_upload)
        self.assertIn("uploadedPaths.push(path)", section)
        self.assertIn("if(!saved&&uploadedPaths.length)", section)

    def test_chat_participants_and_listing_cannot_change(self):
        sql = (ROOT / "public-market-chat-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_thread_reassignment_guard", sql)
        for field in ("listing_id", "buyer_id", "seller_id"):
            with self.subTest(field=field):
                self.assertIn(f"new.{field} is distinct from old.{field}", sql)

    def test_listing_owner_cannot_be_reassigned(self):
        sql = (ROOT / "public-market-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_listing_owner_guard", sql)
        self.assertIn("new.seller_id is distinct from old.seller_id", sql)
        self.assertIn("before update on public.market_listings", sql)

    def test_market_tables_have_rls(self):
        cases = {
            "public-market-phase1.sql": ["market_members", "market_listings"],
            "public-market-chat-phase1.sql": ["market_threads", "market_messages"],
            "public-market-engagement-phase1.sql": ["market_favorites", "market_reports"],
        }
        for filename, tables in cases.items():
            sql = (ROOT / filename).read_text().lower()
            for table in tables:
                with self.subTest(table=table):
                    self.assertIn(f"alter table public.{table} enable row level security", sql)
                    self.assertIn(f"public.{table}", sql)

if __name__ == "__main__":
    unittest.main()
