// Supabase Edge Function: send-sms — v3 (authenticated)
//
// SECURITY: this used to accept requests carrying only the public anon key, which let
// anyone send arbitrary texts from your Twilio number. It now requires either
//   - a signed-in GOGO Fleet user's access token (owner app), or
//   - the service role key (internal callers such as payment-reminders).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { safeEqual } from "../_shared/util.ts";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", SERVICE_KEY, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const isInternal = SERVICE_KEY.length > 0 && safeEqual(bearer, SERVICE_KEY);
  if (!isInternal) {
    const { data, error } = await sb.auth.getUser(bearer);
    if (error || !data?.user) return json(req, { error: "Unauthorized" }, 401);
  }

  try {
    const { to, message } = await req.json();

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const messagingService = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") ?? "";
    const fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER") ?? "";
    if (!accountSid || !authToken) throw new Error("Missing Twilio credentials");

    const toClean = String(to ?? "").replace(/\D/g, "");
    if (toClean.length < 10 || toClean.length > 11) return json(req, { error: "Invalid phone number" }, 400);
    const text = String(message ?? "").trim();
    if (!text || text.length > 480) return json(req, { error: "Invalid message" }, 400);
    const toFormatted = toClean.startsWith("1") && toClean.length === 11 ? "+" + toClean : "+1" + toClean.slice(-10);

    // Messaging Service SID is required for A2P 10DLC; fall back to the direct number until approved.
    const body = new URLSearchParams({
      To: toFormatted,
      Body: text,
      ...(messagingService ? { MessagingServiceSid: messagingService } : { From: fromNumber }),
    });

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Twilio error:", data);
      throw new Error(data.message || `Twilio error ${data.code}`);
    }
    return json(req, { success: true, sid: data.sid });
  } catch (error) {
    console.error("send-sms error:", error);
    return json(req, { error: (error instanceof Error ? error.message : String(error)) }, 400);
  }
});
