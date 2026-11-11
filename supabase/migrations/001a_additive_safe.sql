-- 001a — ADDITIVE and SAFE. Run this FIRST, any time. It changes nothing the live site depends on.
-- Supabase dashboard → SQL Editor → paste → Run.

-- 1) Login attempt log (used by the renter-portal function to rate-limit PIN guessing).
--    RLS on with no policies = only the service role (Edge Functions) can touch it.
create table if not exists public.renter_login_attempts (
  id         bigserial primary key,
  phone_key  text        not null,
  ip         text,
  success    boolean     not null,
  created_at timestamptz not null default now()
);
create index if not exists renter_login_attempts_phone_idx on public.renter_login_attempts (phone_key, created_at desc);
create index if not exists renter_login_attempts_ip_idx    on public.renter_login_attempts (ip, created_at desc);
alter table public.renter_login_attempts enable row level security;

-- 2) PRIVATE bucket for renter driver's licenses, insurance cards and signed contracts.
--    (The existing public 'vehicle-photos' bucket stays for car photos on the marketplace.)
insert into storage.buckets (id, name, public)
values ('renter-private', 'renter-private', false)
on conflict (id) do update set public = false;

-- 3) Owners and their team members may READ files that belong to their own renters.
--    Object paths look like  renter-docs/<renter_id>/license/<file>  and  contracts/<renter_id>/signed.json
--    so the renter id is path segment 2. Renters themselves never touch storage directly:
--    the renter-portal function does that with the service role.
drop policy if exists "owners read renter files" on storage.objects;
create policy "owners read renter files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'renter-private'
    and exists (
      select 1
      from public.renters r
      where r.id::text = (storage.foldername(name))[2]
        and (
          r.owner_id = auth.uid()
          or r.owner_id in (select tm.owner_id from public.team_members tm where tm.user_id = auth.uid())
        )
    )
  );

-- 4) Safe public view for the marketplace (cars.html). Exposes ONLY listing fields:
--    no purchase price, plate, VIN, GPS ids, notes about condition/costs, etc.
create or replace view public.listed_cars as
  select id, owner_id, year, make, model, color, city, state, platforms,
         listing_weekly_rent, listing_protection_fee, notes, created_at
  from public.cars
  where listed = true and status = 'available';
grant select on public.listed_cars to anon, authenticated;

-- Optional housekeeping (needs pg_cron): purge old login attempts nightly.
-- select cron.schedule('purge-login-attempts', '30 3 * * *',
--   $$ delete from public.renter_login_attempts where created_at < now() - interval '7 days' $$);
