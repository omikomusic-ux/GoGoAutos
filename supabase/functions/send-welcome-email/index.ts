// Supabase Edge Function: send-welcome-email
// Deploy at: Supabase → Edge Functions → New Function → "send-welcome-email"
// Called automatically after new owner signup

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://gogofleet.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // SECURITY: only send to the signed-in user, at the address on their account.
    // (Previously any caller could email any address with any name.)
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    )
    const { data: authData, error: authError } = await authClient.auth.getUser(jwt)
    if (authError || !authData?.user?.email) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const email = authData.user.email
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const rawName = String(authData.user.user_metadata?.name || email)
    const firstName = escapeHtml(rawName.trim().split(' ')[0].slice(0, 40))

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to GOGO Fleet</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#F0F0F0; padding:40px 20px; }
  .container { max-width:560px; margin:0 auto; }
  .card { background:#FFFFFF; border-radius:16px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  .header { background:#080808; padding:32px; text-align:center; }
  .logo-text { color:#F2F2F2; font-size:20px; font-weight:900; letter-spacing:2px; }
  .body { padding:32px; }
  .greeting { font-size:22px; font-weight:800; color:#111111; margin-bottom:8px; }
  .intro { font-size:15px; color:#555555; line-height:1.6; margin-bottom:24px; }
  .cta-btn { display:block; background:#080808; color:#FFFFFF; text-decoration:none; text-align:center; padding:14px 24px; border-radius:12px; font-size:15px; font-weight:700; margin-bottom:32px; }
  .steps-title { font-size:13px; font-weight:700; color:#111111; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:16px; }
  .step { display:flex; gap:14px; margin-bottom:16px; align-items:flex-start; }
  .step-num { width:28px; height:28px; background:#F0F0F0; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; color:#111111; flex-shrink:0; }
  .step-text { font-size:14px; color:#555555; line-height:1.5; padding-top:4px; }
  .step-text strong { color:#111111; }
  .divider { height:1px; background:#EEEEEE; margin:24px 0; }
  .features { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px; }
  .feature { background:#F8F8F8; border-radius:10px; padding:14px; }
  .feature-title { font-size:13px; font-weight:700; color:#111111; margin-bottom:4px; }
  .feature-desc { font-size:12px; color:#888888; line-height:1.5; }
  .footer { padding:20px 32px; background:#F8F8F8; text-align:center; }
  .footer-text { font-size:12px; color:#AAAAAA; line-height:1.7; }
  .footer-link { color:#555555; text-decoration:none; }
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <div class="header">
      <svg width="160" height="64" viewBox="0 0 280 112" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:0 auto;">
  <style>.ls{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;}.wl{font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,sans-serif;font-weight:800;font-size:16px;dominant-baseline:central;text-anchor:middle;fill:currentColor;}</style>
  <path class="ls" d="M52 62 L56 62 L64 50 L74 43 L108 40 L132 36 L158 35 L174 37 L186 43 L194 51 L196 62 L178 62"/>
  <path class="ls" d="M52 62 L48 62 L44 58 L43 54 L45 49 L50 46 L56 45 L64 50"/>
  <path class="ls" d="M196 58 L199 53 L200 49 L197 44 L192 42 L186 43"/>
  <path class="ls" d="M82 40 L88 26 L100 22 L152 21 L166 24 L175 31 L180 40"/>
  <path class="ls" d="M89 27 L97 24 L112 22 L124 23 L125 40 L88 40 Z"/>
  <path class="ls" d="M128 23 L152 22 L164 24 L172 29 L177 38 L128 38 Z"/>
  <line class="ls" x1="126" y1="23" x2="126" y2="62" stroke-width="1" stroke-dasharray="2,3"/>
  <circle class="ls" cx="72" cy="62" r="18"/>
  <circle class="ls" cx="72" cy="62" r="11" stroke-width="1" stroke-dasharray="1.5,2.5"/>
  <text class="wl" x="65" y="63">G</text>
  <text class="wl" x="79" y="63">O</text>
  <circle class="ls" cx="178" cy="62" r="18"/>
  <circle class="ls" cx="178" cy="62" r="11" stroke-width="1" stroke-dasharray="1.5,2.5"/>
  <text class="wl" x="171" y="63">G</text>
  <text class="wl" x="185" y="63">O</text>
  <line x1="38" y1="80" x2="218" y2="80" stroke="#F2F2F2" stroke-width="0.5" stroke-opacity="0.25"/>
  <text style="font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,sans-serif;font-weight:800;font-size:12px;letter-spacing:5px;fill:currentColor;dominant-baseline:auto;" x="94" y="98">GOGO</text>
  <text style="font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,sans-serif;font-weight:300;font-size:7px;letter-spacing:3.5px;fill:currentColor;opacity:.55;dominant-baseline:auto;" x="77" y="110">FLEET MANAGER</text>
</svg>
      <div style="color:#7A7A7A;font-size:13px;margin-top:10px;">Fleet management for gig-economy rentals</div>
    </div>
    <div class="body">
      <div class="greeting">Welcome, ${firstName}!</div>
      <div class="intro">
        Your GOGO Fleet account is ready. You can now manage your rental cars, 
        sign contracts digitally, collect payments, and track your fleet — all from your phone.
      </div>

      <a href="https://gogofleet.app/app" class="cta-btn">Go to My Fleet Dashboard →</a>

      <div class="steps-title">Get started in 4 steps</div>

      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text"><strong>Add your first vehicle</strong> — tap the + button on your dashboard and enter the car details. Takes 2 minutes.</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text"><strong>List it on the marketplace</strong> — on the car detail page, tap "List on Marketplace" so renters at gogofleet.app/cars can find it.</div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text"><strong>Assign a renter</strong> — enter their info and tap Start Contract. They'll get a welcome text with their portal link automatically.</div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text"><strong>Collect payments</strong> — renters pay weekly by card from their portal at gogofleet.app/renter. Payments record in your app automatically.</div>
      </div>

      <div class="divider"></div>

      <div class="steps-title">What's included</div>
      <div class="features">
        <div class="feature">
          <div class="feature-title">Digital Contracts</div>
          <div class="feature-desc">Renters sign with their finger. Stored securely forever.</div>
        </div>
        <div class="feature">
          <div class="feature-title">Card Payments</div>
          <div class="feature-desc">Stripe-powered. Payments auto-record when renters pay.</div>
        </div>
        <div class="feature">
          <div class="feature-title">SMS Reminders</div>
          <div class="feature-desc">Automated payment reminders fire daily. Set it and forget it.</div>
        </div>
        <div class="feature">
          <div class="feature-title">GPS Tracking</div>
          <div class="feature-desc">Connect Bouncie devices to see your fleet live on a map.</div>
        </div>
        <div class="feature">
          <div class="feature-title">Renter Portal</div>
          <div class="feature-desc">English, Spanish, and Vietnamese. Renters see their balance and contract.</div>
        </div>
        <div class="feature">
          <div class="feature-title">Fleet Calendar</div>
          <div class="feature-desc">Visual month view of contracts, expirations, and maintenance.</div>
        </div>
      </div>

      <div class="divider"></div>

      <div style="font-size:13px;color:#888888;line-height:1.7;">
        Questions? Reply to this email or reach us at 
        <a href="mailto:omikomusic@gmail.com" style="color:#111111;">omikomusic@gmail.com</a>.<br>
        Your renter portal link: <a href="https://gogofleet.app/renter" style="color:#111111;">gogofleet.app/renter</a><br>
        Marketplace: <a href="https://gogofleet.app/cars" style="color:#111111;">gogofleet.app/cars</a>
      </div>
    </div>
    <div class="footer">
      <div class="footer-text">
        GOGO Fleet · Houston, TX<br>
        <a href="https://gogofleet.app/privacy" class="footer-link">Privacy Policy</a> · 
        <a href="https://gogofleet.app/terms" class="footer-link">Terms</a>
      </div>
    </div>
  </div>
</div>
</body>
</html>`

    const text = `
Welcome to GOGO Fleet, ${firstName}!

Your account is ready. Go to your fleet dashboard:
https://gogofleet.app/app

Get started in 4 steps:
1. Add your first vehicle on the dashboard
2. List it on the marketplace at gogofleet.app/cars
3. Assign a renter — they get a welcome text automatically
4. Collect card payments from gogofleet.app/renter

Questions? Email omikomusic@gmail.com

GOGO Fleet · gogofleet.app
    `.trim()

    // Send via Supabase Auth Admin API (uses your project's email settings)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    // Use Resend if configured, otherwise fall back to Supabase SMTP
    const resendKey = Deno.env.get('RESEND_API_KEY')

    if (resendKey) {
      // Send via Resend (recommended — free tier: 3000 emails/month)
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'GOGO Fleet <noreply@gogofleet.app>',
          to: [email],
          subject: `Welcome to GOGO Fleet, ${firstName}! 🚗`,
          html,
          text,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Resend error')
      console.log(`Welcome email sent to ${email} via Resend: ${data.id}`)
    } else {
      // Fallback: log that email would be sent (configure Resend to actually send)
      console.log(`Welcome email would be sent to ${email} — configure RESEND_API_KEY to enable`)
    }

    return new Response(
      JSON.stringify({ success: true, email }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('send-welcome-email error:', error)
    return new Response(
      JSON.stringify({ error: (error instanceof Error ? error.message : String(error)) }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
