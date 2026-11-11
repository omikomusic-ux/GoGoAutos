# GOGO Fleet

Fleet management for gig-economy car rental operators — digital contracts, card payments, SMS
reminders, GPS tracking and a public marketplace. Live at **https://gogofleet.app**.

## Layout
| Path | What it is |
|---|---|
| `index.html` | Marketing landing page |
| `signup.html` | Owner signup (card on file via Stripe SetupIntent) |
| `app.html` | Owner / team app (PWA) |
| `renter.html` | Renter portal — phone + PIN, payments, contract signing, documents |
| `cars.html` | Public marketplace of available cars |
| `privacy.html`, `terms.html` | Legal |
| `sw.js`, `manifest.json` | PWA service worker and manifest |
| `supabase/functions/` | Edge Functions (backend source of truth) |
| `supabase/migrations/` | SQL to run in the Supabase SQL editor |
| `scripts/` | One-off maintenance scripts |
| `DEPLOY.md` | Deployment runbook + verification checklist |

## Stack
Static HTML on **GitHub Pages** · **Supabase** (Postgres + RLS, Auth, Storage, Edge Functions) ·
**Stripe** (payments) · **Twilio** (SMS) · **Resend** (email) · **Bouncie** (GPS).

## How access works
- **Owners/team** sign in with Supabase Auth. Row-level security (`owner_isolation`) scopes every table to their fleet.
- **Renters** never talk to the database. They sign in through the `renter-portal` function with phone + PIN
  (checked on the server, rate-limited) and get a 12-hour signed token. Their documents and signed contracts
  sit in the private `renter-private` storage bucket.
- **Payments**: `create-checkout` computes the amount from the renter's contract; `stripe-webhook` records
  what Stripe actually collected.
- **Marketplace** reads the `listed_cars` view, which exposes listing fields only.
- Secrets live in Supabase Edge Function secrets — **never in this repo or in page source**. The only keys in
  the pages are public by design (Supabase anon key, Stripe publishable key, a referrer-restricted Maps key).

See `DEPLOY.md` before changing any of the above.
