# Public market browsing and 5,000 IQD boosts

- Anonymous visitors browse public listings, search and view details; auth is required to create/edit a listing, start conversations, save favorites or submit a promotion request.
- One paid promotion costs exactly **5,000 Iraqi dinars**. A pending order alone does NOT affect ranking, label the ad as promoted, or charge the user.
- SQL foundation: `supabase/public-market-promotion-phase1.sql` (not deployed). Authenticated users can request their own pending order and read it; neither buyers nor sellers can mark an order paid or activate a campaign.
- Production checkout requires a licensed/approved merchant account, its server-side API credentials, payment status validation via signed webhook or provider inquiry, idempotent activation, automatic duration expiry, refund reconciliation and clear public terms (duration fixed at seven days after verified payment).
- **A personal Mastercard number is not a merchant payment gateway.** Settlement to the owner's Mastercard is possible only if the selected acquirer explicitly supports that card/account as a beneficiary. Do not request, store or display PAN, CVV, OTP or PIN in Waseet.
- Confirm merchant account provider and settlement destination before building the payment checkout. Do not claim live payment support until a real sandbox and settlement contract are validated.

- A promoted badge and ranking must be sourced from a trusted public read-only projection after verified settlement; do not expose customer billing details. The private view in SQL is not yet a public API and is intentionally not granted to visitors.
- Settlement goal: a personal Rafidain Bank Mastercard. Confirm merchant-acquirer eligibility and settlement account with the payment provider first; a card number alone cannot act as a checkout destination.
