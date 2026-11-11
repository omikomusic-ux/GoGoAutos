// Supabase Edge Function: payment-reminders
// Runs daily via cron at 8am Houston time (UTC-5 = 13:00 UTC)
// Deploy at: Supabase → Edge Functions → New Function → "payment-reminders"
// Then schedule at: Supabase → Database → Extensions → enable pg_cron
// SQL: select cron.schedule('daily-payment-reminders', '0 13 * * *', 'select net.http_post(''https://pbglpxipzidwhaxganzx.supabase.co/functions/v1/payment-reminders'', ''{}'', ''{"Authorization": "Bearer YOUR_ANON_KEY"}'')');

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

const FUNCTIONS_URL = 'https://pbglpxipzidwhaxganzx.supabase.co/functions/v1'
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''  // send-sms now requires a real credential

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function sendSMS(to: string, message: string) {
  const res = await fetch(`${FUNCTIONS_URL}/send-sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SB_KEY}`,
    },
    body: JSON.stringify({ to, message }),
  })
  return res.json()
}

function daysUntil(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((due.getTime() - today.getTime()) / 86400000)
}

function weeklyDueDates(contractStart: string): string[] {
  const dates: string[] = []
  const start = new Date(contractStart + 'T00:00:00')
  for (let week = 0; week < 4; week++) {
    const due = new Date(start)
    due.setDate(due.getDate() + week * 7)
    dates.push(due.toISOString().slice(0, 10))
  }
  return dates
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const results = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: [] as string[],
  }

  try {
    // Get all active renters who have consented and not opted out
    const { data: renters, error } = await supabase
      .from('renters')
      .select('*, cars:car_id(year, make, model, plate)')
      .eq('active', true)
      .eq('sms_consent', true)
      .eq('sms_opted_out', false)
      .not('phone', 'is', null)

    if (error) throw error
    if (!renters || renters.length === 0) {
      return new Response(JSON.stringify({ message: 'No eligible renters', ...results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    for (const renter of renters) {
      results.processed++
      const firstName = renter.name.split(' ')[0]
      const weeklyTotal = +renter.weekly_rent + +renter.protection_fee
      const dueDates = weeklyDueDates(renter.contract_start)

      // Get payments already made
      const { data: payments } = await supabase
        .from('payments')
        .select('week_num, date, amount')
        .eq('car_id', renter.car_id)
        .gte('date', renter.contract_start)

      const paidWeeks = new Set((payments || []).map((p: any) => +p.week_num))

      // Check each unpaid week
      for (let weekIdx = 0; weekIdx < dueDates.length; weekIdx++) {
        const weekNum = weekIdx + 1
        if (paidWeeks.has(weekNum)) continue // already paid

        const dueDate = dueDates[weekIdx]
        const daysLeft = daysUntil(dueDate)
        let message = ''

        if (daysLeft === 1) {
          // Due tomorrow
          message = `Hi ${firstName}! Your GOGO Fleet payment of $${weeklyTotal} (Week ${weekNum}) is due tomorrow ${new Date(dueDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}. Pay at gogofleet.app/renter. Reply STOP to opt out.`
        } else if (daysLeft === 0) {
          // Due today
          message = `Hi ${firstName}, your GOGO Fleet payment of $${weeklyTotal} (Week ${weekNum}) is due TODAY. Pay now at gogofleet.app/renter to avoid late fees. Reply STOP to opt out.`
        } else if (daysLeft === -1) {
          // 1 day overdue
          message = `Hi ${firstName}, your GOGO Fleet payment of $${weeklyTotal} was due yesterday. Please pay at gogofleet.app/renter — a $50 late fee applies after 3 days overdue. Reply STOP to opt out.`
        } else if (daysLeft === -3) {
          // 3 days overdue — late fee now applies
          message = `Hi ${firstName}, your GOGO Fleet account is 3 days past due. A $50 late fee has been added. Total now owed: $${weeklyTotal + 50}. Pay at gogofleet.app/renter or call us immediately. Reply STOP to opt out.`
        } else if (daysLeft === -7) {
          // 7 days overdue — urgent
          message = `URGENT: Hi ${firstName}, your GOGO Fleet account is 7 days past due. Please contact your fleet manager immediately to avoid contract termination. Reply STOP to opt out.`
        }

        if (message) {
          try {
            const smsResult = await sendSMS(renter.phone, message)
            if (smsResult.error) {
              results.errors.push(`${renter.name} (Week ${weekNum}): ${smsResult.error}`)
              results.skipped++
            } else {
              results.sent++
              console.log(`✓ Reminder sent: ${renter.name} Week ${weekNum} daysLeft=${daysLeft}`)
            }
          } catch(e: any) {
            results.errors.push(`${renter.name}: ${e.message}`)
            results.skipped++
          }
          break // Only send one reminder per renter per day
        }
      }
    }

    console.log(`Payment reminders: ${results.sent} sent, ${results.skipped} skipped, ${results.errors.length} errors`)

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('payment-reminders error:', error)
    return new Response(
      JSON.stringify({ error: error.message, ...results }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
