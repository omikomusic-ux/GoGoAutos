// Supabase Edge Function: create-checkout — v4 (server-side pricing)
//
// SECURITY: the payment amount is computed here from the renter's contract in the
// database. The browser only says which week it wants to pay and proves who it is
// with the renter-portal session token (x-renter-token). It can no longer choose
// the price, the renter, or the car.

import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { verifyRenterToken } from "../_shared/renter-token.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const sb = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const CONTRACT_WEEKS = 4;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const body = await req.json();

    const renterId = await verifyRenterToken(req.headers.get("x-renter-token") ?? body.token);
    if (!renterId) return json(req, { error: "Session expired. Please sign in again." }, 401);

    const week = Number(body.week_num);
    if (!Number.isInteger(week) || week < 1 || week > CONTRACT_WEEKS) {
      return json(req, { error: "Invalid week" }, 400);
    }

    const { data: renter } = await sb
      .from("renters")
      .select("*")
      .eq("id", renterId)
      .eq("active", true)
      .maybeSingle();
    if (!renter) return json(req, { error: "No active rental found" }, 404);

    const weekly = Number(renter.weekly_rent) + Number(renter.protection_fee);
    if (!Number.isFinite(weekly) || weekly <= 0 || weekly > 5000) {
      return json(req, { error: "Rental terms are not set up for online payment" }, 400);
    }

    // Don't take money for a week that's already covered.
    let q = sb.from("payments").select("amount, week_num").eq("car_id", renter.car_id);
    if (renter.contract_start) q = q.gte("date", renter.contract_start);
    const { data: paid } = await q;
    const totalPaid = (paid ?? []).reduce((s, p) => s + Number(p.amount), 0);
    const weekPaid = (paid ?? [])
      .filter((p) => Number(p.week_num) === week)
      .reduce((s, p) => s + Number(p.amount), 0);
    if (totalPaid >= weekly * CONTRACT_WEEKS) {
      return json(req, { error: "This rental is already paid in full" }, 409);
    }
    if (weekPaid >= weekly) {
      return json(req, { error: `Week ${week} is already paid` }, 409);
    }

    // Rent goes to the OPERATOR's connected Stripe account (destination charge); we keep a small
    // application fee that roughly covers Stripe's processing cost so the platform isn't out of pocket.
    const { data: car } = await sb.from("cars").select("owner_id").eq("id", renter.car_id).maybeSingle();
    const { data: ob } = car?.owner_id
      ? await sb.from("owner_billing").select("stripe_account_id, payouts_enabled").eq("owner_id", car.owner_id).maybeSingle()
      : { data: null };
    if (!ob?.stripe_account_id || !ob.payouts_enabled) {
      return json(req, { error: "Online payment isn't available yet for this rental. Please pay your operator directly." }, 409);
    }
    const cents = Math.round(weekly * 100);
    const pct = Number(Deno.env.get("RENT_APPLICATION_FEE_PERCENT") ?? "2.9");
    const flat = Number(Deno.env.get("RENT_APPLICATION_FEE_FLAT_CENTS") ?? "30");
    const fee = Math.min(cents - 1, Math.max(0, Math.round(cents * pct / 100) + flat));

    const session = await stripe.checkout.sessions.create({
      payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: ob.stripe_account_id } },
      // Card only: wallet methods need domain verification.
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Rental — Week ${week} Payment`,
            description: `Rental payment for ${renter.name}`,
          },
          unit_amount: Math.round(weekly * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: "https://gogofleet.app/renter.html?payment=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://gogofleet.app/renter.html?payment=cancelled",
      payment_method_options: { card: { request_three_d_secure: "automatic" } },
      metadata: {
        renter_id: String(renter.id),
        car_id: String(renter.car_id),
        week_num: String(week),
        amount: String(weekly),
        renter_name: String(renter.name ?? ""),
      },
    });

    return json(req, { url: session.url, session_id: session.id });
  } catch (error) {
    console.error("Checkout error:", error);
    return json(req, { error: "Could not start payment. Try again." }, 400);
  }
});
