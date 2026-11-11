-- 002 — Subscription billing, operator payouts (Stripe Connect), plan limits, per-renter PINs.
-- Run AFTER 001a and 001b. Safe to re-run.

-- ── 1) Per-renter PIN ──────────────────────────────────────────────────────────────────────
-- New renters get a random 4-digit PIN (set by the app). Existing renters without one keep
-- the old default (last 4 digits of their phone) until the owner assigns one.
alter table public.renters add column if not exists pin text;

-- ── 2) One billing row per operator ────────────────────────────────────────────────────────
create table if not exists public.owner_billing (
  owner_id               uuid primary key references auth.users(id) on delete cascade,
  plan                   text        not null default 'starter' check (plan in ('starter','growth','scale')),
  -- trialing = in-app free trial (no card needed) OR a Stripe trial; comped = free (you grant it)
  status                 text        not null default 'trialing'
                         check (status in ('trialing','active','past_due','canceled','unpaid','incomplete','comped')),
  trial_end              timestamptz not null default (now() + interval '14 days'),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean     not null default false,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  stripe_account_id      text unique,            -- Stripe Connect account that receives this operator's rent
  payouts_enabled        boolean     not null default false,
  updated_at             timestamptz not null default now()
);

alter table public.owner_billing enable row level security;

-- Owners and their team can READ the row. Nobody can write it from a browser: only Edge
-- Functions (service role) change plan, status and Stripe ids.
drop policy if exists "owner reads own billing" on public.owner_billing;
create policy "owner reads own billing" on public.owner_billing
  for select to authenticated
  using (
    owner_id = auth.uid()
    or owner_id in (select tm.owner_id from public.team_members tm where tm.user_id = auth.uid())
  );
revoke all on public.owner_billing from anon;
revoke insert, update, delete on public.owner_billing from authenticated;
grant select on public.owner_billing to authenticated;

-- ── 3) Every new owner starts a 14-day trial automatically ────────────────────────────────
create or replace function public.handle_new_owner_billing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data->>'role', '') = 'owner' then
    insert into public.owner_billing (owner_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_billing on auth.users;
create trigger on_auth_user_created_billing
  after insert on auth.users
  for each row execute function public.handle_new_owner_billing();

-- Existing owners (you, today) are grandfathered as 'comped' on the biggest plan. Change per owner
-- with the statements at the bottom of this file.
insert into public.owner_billing (owner_id, plan, status)
select tm.owner_id, 'scale', 'comped'
from public.team_members tm
where tm.role = 'owner' and tm.owner_id is not null
on conflict (owner_id) do nothing;

-- ── 4) Plan limits enforced on the SERVER (the browser cannot skip this) ──────────────────
--   starter: 5 vehicles · growth: 15 · scale: unlimited
--   An operator can add vehicles only while in good standing:
--     comped · active · trialing (trial not expired) · past_due for up to 7 days
--   Existing vehicles, renters and payments are never locked — only adding NEW vehicles.
create or replace function public.enforce_car_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b   public.owner_billing%rowtype;
  lim int;
  n   int;
  ok  boolean;
begin
  if new.owner_id is null then return new; end if;

  select * into b from public.owner_billing where owner_id = new.owner_id;
  if not found then return new; end if;          -- legacy owner without a row: don't block

  ok := b.status in ('active', 'comped')
     or (b.status = 'trialing' and b.trial_end > now())
     or (b.status = 'past_due' and b.updated_at > now() - interval '7 days');
  if not ok then
    raise exception 'SUBSCRIPTION_REQUIRED: Your free trial or subscription has ended. Choose a plan in Team → Plan & Billing to add vehicles.';
  end if;

  lim := case b.plan when 'starter' then 5 when 'growth' then 15 else null end;
  if lim is not null then
    select count(*) into n from public.cars where owner_id = new.owner_id;
    if n >= lim then
      raise exception 'PLAN_LIMIT: Your % plan includes % vehicles. Upgrade in Team → Plan & Billing to add more.', b.plan, lim;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cars_enforce_limit on public.cars;
create trigger cars_enforce_limit
  before insert on public.cars
  for each row execute function public.enforce_car_limit();

-- ── 5) Handy statements (run manually in the SQL editor, edit the email) ──────────────────
-- Give a first client free access (no Stripe needed):
--   update public.owner_billing set status = 'comped', plan = 'growth'
--    where owner_id = (select id from auth.users where email = 'client@example.com');
-- Extend someone's trial 30 days:
--   update public.owner_billing set trial_end = now() + interval '30 days', status = 'trialing'
--    where owner_id = (select id from auth.users where email = 'client@example.com');
-- See everyone:
--   select u.email, b.plan, b.status, b.trial_end, b.payouts_enabled
--     from public.owner_billing b join auth.users u on u.id = b.owner_id order by b.updated_at desc;
