// Supabase Edge Function: create-setup-intent
// Creates a Stripe SetupIntent to save card without charging
// Deploy at: Supabase → Edge Functions → New Function → "create-setup-intent"

import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://gogofleet.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email } = await req.json()

    // Create or retrieve Stripe customer
    let customer
    const existing = await stripe.customers.list({ email, limit: 1 })
    if (existing.data.length > 0) {
      customer = existing.data[0]
    } else {
      customer = await stripe.customers.create({ email })
    }

    // Create SetupIntent — saves card without charging
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { email },
    })

    return new Response(
      JSON.stringify({
        client_secret: setupIntent.client_secret,
        customer_id: customer.id,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('SetupIntent error:', error)
    return new Response(
      JSON.stringify({ error: (error instanceof Error ? error.message : String(error)) }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
