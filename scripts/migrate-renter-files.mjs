#!/usr/bin/env node
// One-time migration: copy renter documents and signed contracts from the PUBLIC 'vehicle-photos'
// bucket into the PRIVATE 'renter-private' bucket.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-renter-files.mjs
//   ... node scripts/migrate-renter-files.mjs --delete    # also remove the public copies
//
// Run it on your own machine. The service role key must never go in the repo or a web page.

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DELETE = process.argv.includes('--delete');
const FROM = 'vehicle-photos';
const TO = 'renter-private';
const ROOTS = ['renter-docs', 'contracts'];

if (!URL_ || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// The storage list API is not recursive: folders come back with id === null.
async function walk(prefix) {
  const files = [];
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`${URL_}/storage/v1/object/list/${FROM}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 100, offset }),
    });
    if (!r.ok) throw new Error(`list ${prefix}: ${r.status} ${await r.text()}`);
    const items = await r.json();
    for (const it of items) {
      if (it.id === null) files.push(...(await walk(`${prefix}/${it.name}`)));
      else files.push(`${prefix}/${it.name}`);
    }
    if (items.length < 100) break;
  }
  return files;
}

const all = [];
for (const root of ROOTS) all.push(...(await walk(root)));
console.log(`Found ${all.length} file(s) to move.`);

const copied = [];
for (const path of all) {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  const down = await fetch(`${URL_}/storage/v1/object/${FROM}/${enc}`, { headers: H });
  if (!down.ok) { console.error(`  ✗ download ${path}: ${down.status}`); continue; }
  const body = Buffer.from(await down.arrayBuffer());
  const up = await fetch(`${URL_}/storage/v1/object/${TO}/${enc}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': down.headers.get('content-type') || 'application/octet-stream', 'x-upsert': 'true' },
    body,
  });
  if (!up.ok) { console.error(`  ✗ upload ${path}: ${up.status} ${await up.text()}`); continue; }
  copied.push(path);
  console.log(`  ✓ ${path}`);
}
console.log(`Copied ${copied.length}/${all.length}.`);

if (DELETE && copied.length) {
  const r = await fetch(`${URL_}/storage/v1/object/${FROM}`, {
    method: 'DELETE',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: copied }),
  });
  console.log(r.ok ? `Deleted ${copied.length} public cop${copied.length === 1 ? 'y' : 'ies'}.` : `Delete failed: ${r.status} ${await r.text()}`);
} else if (copied.length) {
  console.log('Public copies left in place. Re-run with --delete once everything checks out.');
}
