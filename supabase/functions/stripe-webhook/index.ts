// Supabase Edge Function: stripe-webhook — v2
//
// SECURITY: records the amount Stripe actually collected (session.amount_total),
// not a number carried in metadata. Also resolves the car's owner so the payment
// row is visible to that owner under row-level security.
//
// Deploy with --no-verify-jwt (Stripe calls this, not a signed-in user); the
// Stripe signature below is the authentication.

import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const jsonHeaders = { "Content-Type": "application/json" };

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature ?? "", webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", (err instanceof Error ? err.message : String(err)));
    return new Response("Webhook Error", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { car_id, week_num, amount, renter_name } = session.metadata ?? {};

    if (session.payment_status !== "paid") {
      console.log("Session not paid yet, ignoring:", session.id);
      return new Response(JSON.stringify({ received: true, ignored: "unpaid" }), { headers: jsonHeaders });
    }
    if (!car_id) {
      console.error("Missing metadata in session:", session.id);
      return new Response("Missing metadata", { status: 400 });
    }

    // The amount Stripe really charged, in dollars.
    const charged = (session.amount_total ?? 0) / 100;
    if (Math.abs(charged - Number(amount)) > 0.01) {
      // Should be impossible now that create-checkout sets both from the database.
      console.error(`Amount mismatch on ${session.id}: charged ${charged}, metadata ${amount}`);
      return new Response("Amount mismatch", { status: 400 });
    }

    // Idempotency: never record the same session twice.
    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("stripe_session_id", session.id)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { headers: jsonHeaders });
    }

    const { data: car } = await supabase.from("cars").select("owner_id").eq("id", car_id).maybeSingle();
    if (!car) {
      console.error("Unknown car for session:", session.id);
      return new Response("Unknown car", { status: 400 });
    }

    const { error } = await supabase.from("payments").insert({
      car_id,
      amount: charged,
      method: "Card (Stripe)",
      week_num: parseInt(week_num ?? "1"),
      date: new Date().toISOString().slice(0, 10),
      note: `Online card payment — Stripe session ${session.id}`,
      recorded_by: "Stripe (automatic)",
      stripe_session_id: session.id,
      owner_id: car.owner_id,
    });

    if (error) {
      console.error("Payment insert error:", error);
      return new Response("Database error", { status: 500 });
    }
    console.log(`Payment recorded: ${renter_name} week ${week_num} $${charged}`);
  }

  return new Response(JSON.stringify({ received: true }), { headers: jsonHeaders });
});
