# Deploying the security hardening

Do this in one sitting at a quiet time (≈30 min). The order matters: steps 4–6 switch the site
and backend over together, so renters may see a brief hiccup between them.

## 0. Before anything — rotate secrets
These were pasted into chats/notes, so treat them as exposed:
- **Bouncie**: developer portal → generate a new client secret (the old one was in this public repo's history).
- **Stripe**: Dashboard → Developers → API keys → roll the secret key. Re-add the webhook signing secret if it changes.
- **Twilio**: Console → Account → API keys & tokens → rotate the Auth Token.
- **Google Maps key** (it's in the page source, which is normal — so restrict it instead):
  Google Cloud Console → Credentials → the key → *Application restrictions: Websites* →
  `https://gogofleet.app/*` and `https://www.gogofleet.app/*`; *API restrictions*: only the Maps APIs you use.

## 1. Supabase secrets
Dashboard → Edge Functions → Secrets (or `supabase secrets set ...`):

| Secret | Value |
|---|---|
| `RENTER_SESSION_SECRET` | 32+ random chars — e.g. `openssl rand -hex 32` |
| `BOUNCIE_CLIENT_ID` | `gogo-autos` |
| `BOUNCIE_CLIENT_SECRET` | the **new** Bouncie secret |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | rotated values |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | rotated values |
| `TWILIO_MESSAGING_SERVICE_SID` | when A2P is approved |
| `RESEND_API_KEY` | as before |

## 2. Run `supabase/migrations/001a_additive_safe.sql`
SQL Editor → paste → Run. Safe any time; adds the rate-limit table, the private `renter-private`
bucket + owner read policy, and the `listed_cars` view.

## 3. Copy existing renter files into the private bucket (if any)
```bash
SUPABASE_URL=https://pbglpxipzidwhaxganzx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
node scripts/migrate-renter-files.mjs            # copy
node scripts/migrate-renter-files.mjs --delete   # then remove the public copies
```
Run the copy now; run `--delete` after step 6 once you've confirmed documents still open in the owner app.

## 4. Deploy the functions
```bash
supabase functions deploy renter-portal bouncie-token create-checkout send-sms \
  payment-reminders send-welcome-email create-setup-intent owner-billing
supabase functions deploy stripe-webhook sms-optout --no-verify-jwt   # called by Stripe / Twilio
```
(`supabase/config.toml` already records which functions skip JWT verification.)

## 5. Merge the PR
GitHub Pages rebuilds in about a minute. Hard-refresh the site / reinstall the PWA if it looks stale.

## 6. Run `supabase/migrations/001b_lockdown.sql`
This removes anonymous access to renter data. Read the *Messages* pane: it lists every policy it
dropped. Then run the checks below.

## 7. Verify
- [ ] Renter login with a real phone + PIN works; a wrong PIN fails; 6 wrong PINs → "Too many attempts".
- [ ] Renter can upload a license (appears as "Uploaded") and sign a contract.
- [ ] **Pay Now** opens Stripe for exactly weekly rent + protection fee; after paying, the payment shows in the owner app with the right amount.
- [ ] Owner app → Car → Renter Docs shows the renter's license; Signed Contract opens.
- [ ] `gogofleet.app/cars.html` still lists available cars.
- [ ] Anonymous check — in a private window's console this must return `[]` or an error, never renter rows:
  `fetch('https://pbglpxipzidwhaxganzx.supabase.co/rest/v1/renters?select=name,phone', {headers:{apikey:'<anon key>'}}).then(r=>r.json()).then(console.log)`
- [ ] Bouncie → Tracking → Connect works.
- [ ] New owner signup creates the account; the owner lands in the app with their own fleet.

## 8. Billing & payouts (PR #2: `billing-and-onboarding`)
Do this after steps 1–7 are working.

1. **Plans (decide prices first; Stripe prices can't be edited).** Starter $49 (≤5 cars), Growth $149 (≤15), Scale $279 (unlimited), set in `scripts/stripe-setup.mjs`, `PLAN_INFO` in `app.html` and `index.html`.
   `STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs` (safe to re-run).
2. Run `supabase/migrations/002_billing.sql`. Check `select * from owner_billing;` shows you as `comped`.
3. Stripe dashboard → **Connect** → enable, choose **Express** accounts, finish the platform profile.
4. Stripe → Settings → Billing → **Customer portal**: turn on; allow cancel + plan switching.
5. Stripe → Webhooks → your endpoint: keep `checkout.session.completed`; add
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   (No separate Connect webhook is needed.)
6. Optional secrets: `RENT_APPLICATION_FEE_PERCENT` (default 2.9), `RENT_APPLICATION_FEE_FLAT_CENTS` (default 30), `SITE_URL`.
7. Test in Stripe **test mode** first (separate keys/project): operator onboarding → renter pays a week → payment shows in the app, money reaches the operator's balance, your fee appears.

### Comp / extend a client (SQL editor)
```sql
update owner_billing set status='comped', plan='growth'
 where owner_id=(select id from auth.users where email='client@example.com');
update owner_billing set status='trialing', trial_end=now()+interval '30 days'
 where owner_id=(select id from auth.users where email='client@example.com');
```

### Verify billing
- [ ] New signup → Team tab shows "14 days left in your free trial".
- [ ] Adding a 6th car on Starter shows the plan-limit message and is blocked server-side.
- [ ] Choose plan → Stripe Checkout → returns to app; status becomes Active.
- [ ] Set up payouts → Stripe form → returns; status shows payouts enabled; renter then sees **Pay Now**.
- [ ] Renter of an operator without payouts sees "Pay your operator directly", not Pay Now.
- [ ] Contract and portal show the operator's business name (set in Team → Business Profile).

## Known follow-ups (not changed here)
- Renter PINs default to the **last 4 digits of the phone number**. The server now rate-limits guesses,
  but give each renter a unique PIN (`renters.pin`) when you can.
- The public `vehicle-photos` bucket may still allow anonymous uploads — see the query at the bottom of `001b_lockdown.sql`.
- `sms-optout` should verify Twilio's request signature.
- Removing a team member deletes their team row (so they lose access) but not their auth login. Move full deletion to a function.
- Real server-sent push (app closed) needs VAPID keys + a subscriptions table.
