// Supabase Edge Function: owner-billing
//
// Everything an operator does about money lives here, behind their Supabase login:
//   status           → plan, status, trial days left, cars used / limit, payouts state
//   checkout         → Stripe Checkout for a GOGO Fleet subscription (plan: starter|growth|scale)
//   portal           → Stripe Customer Portal (change card, switch plan, cancel, invoices)
//   connect-onboard  → Stripe Connect Express onboarding link (so renter rent lands in THEIR bank)
//   connect-status   → re-reads the Connect account from Stripe and stores payouts_enabled
//   connect-dashboard→ one-time login link to the operator's Stripe Express dashboard
// Only the account owner may use it (team members get 403). Prices are looked up by key, never sent by the browser.

import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const sb = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const SITE = Deno.env.get("SITE_URL") ?? "https://gogofleet.app";
export const PLANS: Record<string, { lookup: string; cars: number | null; label: string }> = {
  starter: { lookup: "gogo_starter_monthly", cars: 5, label: "Starter" },
  growth: { lookup: "gogo_growth_monthly", cars: 15, label: "Growth" },
  scale: { lookup: "gogo_scale_monthly", cars: null, label: "Scale" },
};

async function currentOwner(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const user = data.user;
  const { data: tm } = await sb.from("team_members").select("owner_id, role").eq("user_id", user.id).maybeSingle();
  if (tm && tm.owner_id && tm.owner_id !== user.id) return { user, ownerId: String(tm.owner_id), isOwner: false };
  return { user, ownerId: user.id, isOwner: true };
}

async function getBilling(ownerId: string) {
  const { data } = await sb.from("owner_billing").select("*").eq("owner_id", ownerId).maybeSingle();
  return data;
}
async function save(ownerId: string, patch: Record<string, unknown>) {
  const { error } = await sb.from("owner_billing").upsert({ owner_id: ownerId, ...patch, updated_at: new Date().toISOString() });
  if (error) throw new Error("db: " + error.message);
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const me = await currentOwner(req);
    if (!me) return json(req, { error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    let b = await getBilling(me.ownerId);

    if (action === "status") {
      const { count } = await sb.from("cars").select("id", { count: "exact", head: true }).eq("owner_id", me.ownerId);
      const plan = String(b?.plan ?? "starter");
      const trialEnd = b?.trial_end ? new Date(b.trial_end).getTime() : 0;
      return json(req, {
        plan,
        plan_label: PLANS[plan]?.label ?? plan,
        status: b?.status ?? "none",
        trial_days_left: b?.status === "trialing" ? Math.max(0, Math.ceil((trialEnd - Date.now()) / 86400000)) : 0,
        current_period_end: b?.current_period_end ?? null,
        cancel_at_period_end: !!b?.cancel_at_period_end,
        cars_used: count ?? 0,
        cars_limit: PLANS[plan]?.cars ?? null,
        has_subscription: !!b?.stripe_subscription_id,
        payouts_enabled: !!b?.payouts_enabled,
        has_connect_account: !!b?.stripe_account_id,
        is_owner: me.isOwner,
      });
    }

    if (!me.isOwner) return json(req, { error: "Only the account owner can manage billing." }, 403);

    if (action === "checkout") {
      const plan = PLANS[String(body.plan)];
      if (!plan) return json(req, { error: "Unknown plan" }, 400);
      if (b?.status === "comped") return json(req, { error: "Your account is complimentary — no subscription needed." }, 409);
      if (b?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(String(b.status))) {
        return json(req, { error: "You already have a subscription. Use Manage billing to change plans." }, 409);
      }
      const prices = await stripe.prices.list({ lookup_keys: [plan.lookup], active: true, limit: 1 });
      const price = prices.data[0];
      if (!price) return json(req, { error: "Plan not available yet. Contact support." }, 503);

      let customer = b?.stripe_customer_id as string | undefined;
      if (!customer) {
        const c = await stripe.customers.create({ email: me.user.email ?? undefined, metadata: { owner_id: me.ownerId } });
        customer = c.id;
        await save(me.ownerId, { stripe_customer_id: customer });
      }
      // Carry any unused free-trial days over (Stripe needs ≥ 2 days ahead).
      const trialEndSec = b?.trial_end ? Math.floor(new Date(b.trial_end).getTime() / 1000) : 0;
      const carry = b?.status === "trialing" && trialEndSec - Math.floor(Date.now() / 1000) > 2 * 86400 + 600;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        line_items: [{ price: price.id, quantity: 1 }],
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { owner_id: me.ownerId, plan: String(body.plan) },
          ...(carry ? { trial_end: trialEndSec } : {}),
        },
        metadata: { owner_id: me.ownerId, kind: "subscription" },
        success_url: `${SITE}/app.html?billing=success`,
        cancel_url: `${SITE}/app.html?billing=cancelled`,
      });
      return json(req, { url: session.url });
    }

    if (action === "portal") {
      if (!b?.stripe_customer_id) return json(req, { error: "No billing account yet — choose a plan first." }, 409);
      const s = await stripe.billingPortal.sessions.create({ customer: b.stripe_customer_id, return_url: `${SITE}/app.html` });
      return json(req, { url: s.url });
    }

    if (action === "connect-onboard") {
      let acct = b?.stripe_account_id as string | undefined;
      if (!acct) {
        const a = await stripe.accounts.create({
          type: "express",
          country: "US",
          email: me.user.email ?? undefined,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_type: "individual",
          metadata: { owner_id: me.ownerId },
        });
        acct = a.id;
        await save(me.ownerId, { stripe_account_id: acct });
      }
      const link = await stripe.accountLinks.create({
        account: acct,
        type: "account_onboarding",
        refresh_url: `${SITE}/app.html?connect=refresh`,
        return_url: `${SITE}/app.html?connect=return`,
      });
      return json(req, { url: link.url });
    }

    if (action === "connect-status") {
      if (!b?.stripe_account_id) return json(req, { payouts_enabled: false, has_connect_account: false });
      const a = await stripe.accounts.retrieve(b.stripe_account_id);
      const enabled = !!(a.charges_enabled && a.payouts_enabled);
      if (enabled !== !!b.payouts_enabled) await save(me.ownerId, { payouts_enabled: enabled });
      return json(req, {
        payouts_enabled: enabled,
        has_connect_account: true,
        details_submitted: !!a.details_submitted,
        needs: a.requirements?.currently_due ?? [],
      });
    }

    if (action === "connect-dashboard") {
      if (!b?.stripe_account_id) return json(req, { error: "Set up payouts first." }, 409);
      const l = await stripe.accounts.createLoginLink(b.stripe_account_id);
      return json(req, { url: l.url });
    }

    return json(req, { error: "Unknown action" }, 400);
  } catch (err) {
    console.error("owner-billing error:", err instanceof Error ? err.message : String(err));
    return json(req, { error: "Something went wrong. Please try again." }, 500);
  }
});
