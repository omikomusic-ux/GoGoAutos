// Supabase Edge Function: renter-portal
//
// The ONLY way the renter portal reaches the database and storage.
// The browser never holds a database key with access to renter data: it sends a
// phone + PIN here, gets back a short-lived signed token, and uses that token for
// everything else. PINs are verified on the server and never sent to the browser.
//
// Actions (POST JSON { action, ... }):
//   login          { phone, pin }                -> { token, renter, car, payments, contract_signed, docs }
//   data           { token }                     -> { renter, car, payments }
//   docs           { token }                     -> { docs }
//   upload-doc     { token, docType, data }      -> { ok }        (data = base64 file, <= 8 MB)
//   sign-contract  { token, signature }          -> { ok }        (signature = PNG data URL)
//
// Secrets required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), RENTER_SESSION_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signRenterToken, verifyRenterToken } from "../_shared/renter-token.ts";
import { decodeBase64, safeEqual, sniff } from "../_shared/util.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

const BUCKET = "renter-private";
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_PHONE = 5;
const MAX_FAILS_PER_IP = 30;
const DOC_TYPES = ["license", "insurance"];
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_SIG_BYTES = 400 * 1024;

const enc = new TextEncoder();

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : null;
}

// Fields a renter is allowed to see. Never return pin or owner_id.
function safeRenter(row: Record<string, unknown>) {
  // deno-lint-ignore no-unused-vars
  const { pin, owner_id, ...rest } = row;
  return rest;
}

async function loadPortalData(renter: Record<string, any>) {
  const { data: car } = await sb
    .from("cars")
    .select("id, make, model, year, color, plate")
    .eq("id", renter.car_id)
    .maybeSingle();

  let q = sb.from("payments").select("*").eq("car_id", renter.car_id);
  // Only this contract's payments: a car may have had earlier renters.
  if (renter.contract_start) q = q.gte("date", renter.contract_start);
  const { data: payments } = await q.order("date", { ascending: true });

  return {
    renter: safeRenter(renter),
    car: car ?? null,
    payments: (payments ?? []).map((p: Record<string, unknown>) => {
      // deno-lint-ignore no-unused-vars
      const { owner_id, ...rest } = p;
      return rest;
    }),
  };
}

async function contractSigned(renter: Record<string, any>): Promise<boolean> {
  const { data, error } = await sb.storage.from(BUCKET).download(`contracts/${renter.id}/signed.json`);
  if (error || !data) return false;
  try {
    const meta = JSON.parse(await data.text());
    return meta.contract_start === renter.contract_start;
  } catch {
    return false;
  }
}

async function docStatus(renterId: string) {
  const out: Record<string, { uploaded: boolean; url: string | null }> = {};
  for (const type of DOC_TYPES) {
    const prefix = `renter-docs/${renterId}/${type}`;
    const { data } = await sb.storage.from(BUCKET).list(prefix, {
      limit: 20,
      sortBy: { column: "created_at", order: "desc" },
    });
    const files = (data ?? []).filter((f) => f.name && f.id);
    if (files.length) {
      const { data: signed } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(`${prefix}/${files[0].name}`, 3600);
      out[type] = { uploaded: true, url: signed?.signedUrl ?? null };
    } else {
      out[type] = { uploaded: false, url: null };
    }
  }
  return out;
}

async function getActiveRenter(renterId: string) {
  const { data } = await sb.from("renters").select("*").eq("id", renterId).eq("active", true).maybeSingle();
  return data as Record<string, any> | null;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid request" }, 400);
  }

  try {
    // ── LOGIN ────────────────────────────────────────────────
    if (body.action === "login") {
      const digits = String(body.phone ?? "").replace(/\D/g, "").slice(-10);
      const pin = String(body.pin ?? "");
      if (digits.length !== 10 || !/^\d{4}$/.test(pin)) {
        return json(req, { error: "Invalid phone or PIN" }, 400);
      }
      const ip = clientIp(req);
      const since = new Date(Date.now() - WINDOW_MS).toISOString();

      const phoneFails = await sb
        .from("renter_login_attempts")
        .select("id", { count: "exact", head: true })
        .eq("phone_key", digits)
        .eq("success", false)
        .gte("created_at", since);
      const ipFails = ip
        ? await sb
          .from("renter_login_attempts")
          .select("id", { count: "exact", head: true })
          .eq("ip", ip)
          .eq("success", false)
          .gte("created_at", since)
        : { count: 0 };

      if ((phoneFails.count ?? 0) >= MAX_FAILS_PER_PHONE || (ipFails.count ?? 0) >= MAX_FAILS_PER_IP) {
        return json(req, { error: "Too many attempts. Try again in 15 minutes." }, 429);
      }

      // Phone numbers may be stored with formatting, so narrow by the last 4 digits
      // and then compare the full 10 digits.
      const last4 = digits.slice(-4);
      const { data: candidates } = await sb
        .from("renters")
        .select("*")
        .eq("active", true)
        .ilike("phone", `%${last4}%`)
        .order("created_at", { ascending: false })
        .limit(25);

      const match = (candidates ?? []).find(
        (r: Record<string, any>) => String(r.phone ?? "").replace(/\D/g, "").slice(-10) === digits,
      );
      // Existing behavior: if no custom PIN is set, the PIN is the last 4 digits of the phone.
      const expected = match ? String(match.pin ?? last4) : "0000";
      const pinOk = safeEqual(pin, expected);
      const ok = !!match && pinOk;

      await sb.from("renter_login_attempts").insert({ phone_key: digits, ip, success: ok });

      if (!ok) return json(req, { error: "Invalid phone or PIN" }, 401);

      const token = await signRenterToken(match.id);
      const [portal, signed, docs] = await Promise.all([
        loadPortalData(match),
        contractSigned(match),
        docStatus(match.id),
      ]);
      return json(req, { token, ...portal, contract_signed: signed, docs });
    }

    // ── EVERYTHING ELSE NEEDS A VALID TOKEN ──────────────────
    const renterId = await verifyRenterToken(body.token ?? req.headers.get("x-renter-token"));
    if (!renterId) return json(req, { error: "Session expired. Please sign in again." }, 401);
    const renter = await getActiveRenter(renterId);
    if (!renter) return json(req, { error: "Session expired. Please sign in again." }, 401);

    if (body.action === "data") {
      return json(req, await loadPortalData(renter));
    }

    if (body.action === "docs") {
      return json(req, { docs: await docStatus(renter.id) });
    }

    if (body.action === "upload-doc") {
      const type = String(body.docType ?? "");
      if (!DOC_TYPES.includes(type)) return json(req, { error: "Invalid document type" }, 400);
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(String(body.data ?? ""));
      } catch {
        return json(req, { error: "Invalid file" }, 400);
      }
      if (bytes.length < 100 || bytes.length > MAX_DOC_BYTES) {
        return json(req, { error: "File must be under 8 MB" }, 400);
      }
      const kind = sniff(bytes);
      if (!kind) return json(req, { error: "Upload a photo (JPG, PNG, HEIC, WebP) or PDF" }, 400);

      const path = `renter-docs/${renter.id}/${type}/${Date.now()}.${kind.ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, bytes, {
        contentType: kind.mime,
        upsert: false,
      });
      if (error) {
        console.error("upload-doc error:", error.message);
        return json(req, { error: "Upload failed" }, 500);
      }
      return json(req, { ok: true });
    }

    if (body.action === "sign-contract") {
      // Idempotent: a signed contract is never overwritten.
      if (await contractSigned(renter)) return json(req, { ok: true, already_signed: true });

      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.signature ?? ""));
      if (!m) return json(req, { error: "Invalid signature" }, 400);
      let png: Uint8Array;
      try {
        png = decodeBase64(m[1]);
      } catch {
        return json(req, { error: "Invalid signature" }, 400);
      }
      if (png.length < 200 || png.length > MAX_SIG_BYTES || sniff(png)?.mime !== "image/png") {
        return json(req, { error: "Invalid signature" }, 400);
      }

      const sigPath = `contracts/${renter.id}/signature_${renter.contract_start}.png`;
      const up = await sb.storage.from(BUCKET).upload(sigPath, png, {
        contentType: "image/png",
        upsert: true,
      });
      if (up.error) return json(req, { error: "Could not save signature" }, 500);

      // Contract terms are copied from the database, never from the browser.
      const meta = {
        renter_id: renter.id,
        renter_name: renter.name,
        car_id: renter.car_id,
        contract_start: renter.contract_start,
        contract_end: renter.contract_end,
        signed_at: new Date().toISOString(),
        signed_by: renter.name,
        weekly_rent: renter.weekly_rent,
        protection_fee: renter.protection_fee,
        deposit: renter.deposit,
        signature_path: sigPath,
        signed_from_ip: clientIp(req),
        user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
      };
      const metaUp = await sb.storage
        .from(BUCKET)
        .upload(`contracts/${renter.id}/signed.json`, enc.encode(JSON.stringify(meta)), {
          contentType: "application/json",
          upsert: true,
        });
      if (metaUp.error) return json(req, { error: "Could not save contract" }, 500);
      return json(req, { ok: true });
    }

    return json(req, { error: "Unknown action" }, 400);
  } catch (e) {
    console.error("renter-portal error:", e);
    return json(req, { error: "Something went wrong. Try again." }, 500);
  }
});
