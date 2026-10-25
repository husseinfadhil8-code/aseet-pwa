"""Static guardrails for proposed public market SQL; not a live RLS test."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / "supabase"

class MarketSecurityContractTests(unittest.TestCase):
    def test_public_boost_is_priced_and_cannot_self_activate(self):
        sql = (ROOT / "public-market-promotion-phase1.sql").read_text().lower()
        js = (ROOT.parent / "public-market.js").read_text()
        self.assertIn("check(amount_iqd=5000)", sql)
        self.assertIn("ends_at = starts_at + interval '7 days'", sql)
        self.assertIn("grant select on public.market_promotions,public.market_promotion_events to authenticated", sql)
        self.assertNotIn("grant update on public.market_promotions to authenticated", sql)
        self.assertIn("window.WaseetMarketPayments.order(item)", js)
        self.assertIn("market_review_promotion", sql)

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

    def test_hidden_listings_block_new_chat_messages(self):
        sql = (ROOT / "public-market-chat-phase1.sql").read_text().lower()
        rule = sql.split('create policy "market messages sender insert"', 1)[1].split('-- no policy exposes', 1)[0]
        self.assertIn("join public.market_listings l on l.id=t.listing_id", rule)
        self.assertIn("l.status = 'active'", rule)
        self.assertIn("sender_id=(select auth.uid())", rule)

    def test_chat_participants_and_listing_cannot_change(self):
        sql = (ROOT / "public-market-chat-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_thread_reassignment_guard", sql)
        for field in ("listing_id", "buyer_id", "seller_id"):
            with self.subTest(field=field):
                self.assertIn(f"new.{field} is distinct from old.{field}", sql)

    def test_reports_require_active_public_listing(self):
        sql = (ROOT / "public-market-engagement-phase1.sql").read_text().lower()
        insert_policy = sql.split('create policy "market reports own insert"', 1)[1].split('-- admin report', 1)[0]
        self.assertIn("reporter_id=(select auth.uid())", insert_policy)
        self.assertIn("l.id=listing_id and l.status='active'", insert_policy)

    def test_moderated_listing_cannot_be_republished_by_seller(self):
        sql = (ROOT / "public-market-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_moderation_guard", sql)
        self.assertIn("old.status = 'hidden'", sql)
        self.assertIn("moderated listing cannot be modified by its seller", sql)
        self.assertIn("public.market_is_admin()", sql)

    def test_trigger_functions_have_valid_dollar_quotes(self):
        sql = (ROOT / "public-market-phase1.sql").read_text()
        delimiter = chr(36) * 2
        self.assertNotIn("as " + chr(36) + "\nbegin", sql)
        self.assertNotIn("\n" + chr(36) + ";\ndrop trigger", sql)
        self.assertEqual(sql.count("returns trigger language plpgsql set search_path = '' as " + delimiter), 4)
        self.assertEqual(sql.count("\n" + delimiter + ";\ndrop trigger"), 4)

    def test_moderated_listing_cannot_be_deleted_by_seller(self):
        sql = (ROOT / "public-market-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_moderation_delete_guard", sql)
        self.assertIn("before delete on public.market_listings", sql)
        self.assertIn("old.status = 'hidden'", sql)
        self.assertIn("return old;", sql)

    def test_listing_owner_cannot_be_reassigned(self):
        sql = (ROOT / "public-market-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_listing_owner_guard", sql)
        self.assertIn("new.seller_id is distinct from old.seller_id", sql)
        self.assertIn("before update on public.market_listings", sql)

    def test_listing_image_urls_use_https_and_matching_owner(self):
        sql = (ROOT / "public-market-phase1.sql").read_text().lower()
        self.assertIn("create trigger market_listing_image_guard", sql)
        self.assertIn("image_url !~ '^https://'", sql)
        self.assertIn("position(owner_prefix in image_url) = 0", sql)

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
