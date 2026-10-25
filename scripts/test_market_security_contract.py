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
