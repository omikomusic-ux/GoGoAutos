// Supabase Edge Function: bouncie-token
//
// Exchanges a Bouncie OAuth code (or refresh token) for an access token.
// The Bouncie client secret lives here as a Supabase secret and never reaches the browser.
// Only a signed-in GOGO Fleet owner/team member may call it.
//
// Secrets required: BOUNCIE_CLIENT_ID, BOUNCIE_CLIENT_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsFor, json, preflight } from "../_shared/cors.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const BOUNCIE_TOKEN_URL = "https://auth.bouncie.dev/oauth/token";
// Must match the redirect URI registered in the Bouncie developer portal.
const ALLOWED_REDIRECTS = new Set(["https://gogofleet.app/", "https://gogofleet.app/app.html"]);

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  // Require a real signed-in user (not just the public anon key).
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !auth?.user) return json(req, { error: "Unauthorized" }, 401);

  const clientId = Deno.env.get("BOUNCIE_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("BOUNCIE_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) return json(req, { error: "Bouncie is not configured" }, 500);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid request" }, 400);
  }

  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  if (body.code) {
    if (!ALLOWED_REDIRECTS.has(body.redirect_uri)) {
      return json(req, { error: "Invalid redirect_uri" }, 400);
    }
    params.set("grant_type", "authorization_code");
    params.set("code", body.code);
    params.set("redirect_uri", body.redirect_uri);
  } else if (body.refresh_token) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", body.refresh_token);
  } else {
    return json(req, { error: "code or refresh_token required" }, 400);
  }

  const res = await fetch(BOUNCIE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Bouncie token error:", res.status);
    return json(req, { error: "Bouncie token exchange failed" }, 400);
  }
  // Pass Bouncie's token response straight through (access_token, expires_in, ...).
  return new Response(text, {
    status: 200,
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
});
