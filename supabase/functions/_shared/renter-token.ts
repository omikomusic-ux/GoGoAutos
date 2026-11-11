// Short-lived, HMAC-signed session token for the renter portal.
// Issued only after a successful server-side phone + PIN check.
// Secret: set RENTER_SESSION_SECRET (>= 32 random chars) in Supabase secrets.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(str: string) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("RENTER_SESSION_SECRET") ?? "";
  if (secret.length < 32) throw new Error("RENTER_SESSION_SECRET is missing or too short");
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signRenterToken(renterId: string): Promise<string> {
  const payload = { rid: renterId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const body = b64uEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body));
  return `${body}.${b64uEncode(new Uint8Array(sig))}`;
}

/** Returns the renter id if the token is authentic and unexpired, otherwise null. */
export async function verifyRenterToken(token: string | null | undefined): Promise<string | null> {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      b64uDecode(parts[1]),
      enc.encode(parts[0]),
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64uDecode(parts[0])));
    if (typeof payload.rid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.rid;
  } catch {
    return null;
  }
}
