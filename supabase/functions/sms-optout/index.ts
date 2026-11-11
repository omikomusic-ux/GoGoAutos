// Supabase Edge Function: sms-optout
// Deploy at: Supabase → Edge Functions → New Function → "sms-optout"
// Then set this as your Twilio incoming message webhook URL:
// https://pbglpxipzidwhaxganzx.supabase.co/functions/v1/sms-optout

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  try {
    const body = await req.text()
    const params = new URLSearchParams(body)
    const from = params.get('From') ?? ''
    const message = (params.get('Body') ?? '').trim().toUpperCase()

    // Handle STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT
    const stopWords = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']

    if (stopWords.includes(message)) {
      // Clean the phone number — strip +1 prefix for matching
      const cleanPhone = from.replace(/\D/g, '').slice(-10)

      // Find renter by phone and mark opted out
      const { data: renters } = await supabase
        .from('renters')
        .select('id, name, phone')
        .ilike('phone', `%${cleanPhone}%`)
        .eq('active', true)

      if (renters && renters.length > 0) {
        for (const renter of renters) {
          await supabase
            .from('renters')
            .update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString() })
            .eq('id', renter.id)
        }
        console.log(`Opted out: ${renters.map(r => r.name).join(', ')} (${from})`)
      } else {
        console.log(`STOP from unknown number: ${from}`)
      }

      // Twilio expects TwiML response
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>You have been unsubscribed from GOGO Fleet notifications. Reply START to resubscribe.</Message></Response>`,
        { headers: { 'Content-Type': 'text/xml' } }
      )
    }

    // Handle START / UNSTOP — re-subscribe
    if (message === 'START' || message === 'UNSTOP') {
      const cleanPhone = from.replace(/\D/g, '').slice(-10)
      await supabase
        .from('renters')
        .update({ sms_opted_out: false })
        .ilike('phone', `%${cleanPhone}%`)

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>You have been resubscribed to GOGO Fleet notifications.</Message></Response>`,
        { headers: { 'Content-Type': 'text/xml' } }
      )
    }

    // Any other incoming message — no reply
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { headers: { 'Content-Type': 'text/xml' } }
    )

  } catch (error) {
    console.error('sms-optout error:', error)
    return new Response('Error', { status: 500 })
  }
})
