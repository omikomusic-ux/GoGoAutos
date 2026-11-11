// One-time: creates the three GOGO Fleet subscription prices in Stripe (idempotent via lookup keys).
// Usage:  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs   (needs Node 18+, no packages)
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Set STRIPE_SECRET_KEY'); process.exit(1); }
const PLANS = [
  ['gogo_starter_monthly', 'GOGO Fleet Starter (up to 5 vehicles)', 4900],
  ['gogo_growth_monthly', 'GOGO Fleet Growth (up to 15 vehicles)', 14900],
  ['gogo_scale_monthly', 'GOGO Fleet Scale (unlimited vehicles)', 114900],
];
const call = async (path, body) => {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || r.statusText);
  return d;
};
for (const [lookup, name, cents] of PLANS) {
  const found = await call(`prices?active=true&lookup_keys[]=${lookup}`);
  if (found.data.length) { console.log('exists ', lookup); continue; }
  const product = await call('products', { name });
  await call('prices', { product: product.id, unit_amount: String(cents), currency: 'usd', 'recurring[interval]': 'month', lookup_key: lookup });
  console.log('created', lookup);
}
