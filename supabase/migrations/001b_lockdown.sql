-- 001b — LOCKDOWN. Run this ONLY at cutover, i.e. right when you merge the PR that switches the
-- site over to the new functions (see DEPLOY.md). Running it earlier breaks the OLD renter portal,
-- the old marketplace and the old signup, because they depend on the open access removed here.

begin;

-- 1) New owner signup: create the owner's team_members row inside the database.
--    Previously signup.html inserted it from the browser using the public anon key, which forced an
--    anonymous INSERT policy on team_members — meaning anyone could add themselves to another
--    owner's team (and so read that owner's cars, renters and payments).
create or replace function public.handle_new_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data->>'role', '') = 'owner'
     and not exists (select 1 from public.team_members where user_id = new.id) then
    insert into public.team_members (user_id, email, name, role, owner_id, biz_name, city, state, contact_phone, last_seen)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data->>'name', ''),
      'owner',
      new.id,                                   -- an owner is always their own owner_id
      new.raw_user_meta_data->>'biz_name',
      coalesce(new.raw_user_meta_data->>'city', 'Houston'),
      coalesce(new.raw_user_meta_data->>'state', 'TX'),
      new.raw_user_meta_data->>'phone',
      now()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_owner on auth.users;
create trigger on_auth_user_created_owner
  after insert on auth.users
  for each row execute function public.handle_new_owner();

-- 2) Remove every extra permissive policy on the sensitive tables.
--    Your 'owner_isolation' policies have no TO clause, so they apply to the public role — they must
--    be kept. Anything else that doesn't tie access to auth.uid() is what let anonymous visitors read.
--    Dropped policy names are printed in the "Messages" pane so you can see exactly what was removed.
do $$
declare p record;
begin
  for p in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('renters','payments','cars','maintenance','expenses','damage_reports','team_members')
      and policyname <> 'owner_isolation'
      and coalesce(qual, '')       !~* 'auth\.uid\(\)'
      and coalesce(with_check, '') !~* 'auth\.uid\(\)'
  loop
    raise notice 'Dropping permissive policy "%" on %', p.policyname, p.tablename;
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- 3) Belt and braces: the anonymous role gets no direct access to these tables at all.
--    (The marketplace reads public.listed_cars instead; renters go through the renter-portal function.)
revoke all on public.renters, public.payments, public.cars, public.maintenance,
              public.expenses, public.damage_reports, public.team_members
  from anon;

commit;

-- ── After running, sanity-check what's left ───────────────────────────────────────────────────
-- select tablename, policyname, roles, cmd from pg_policies
--  where schemaname = 'public' order by tablename, policyname;
--
-- ── Follow-up (not done automatically — could break car-photo uploads if run blindly) ─────────
-- The PUBLIC 'vehicle-photos' bucket likely still has policies letting the anon key upload/overwrite
-- files. Inspect them, then restrict writes to authenticated users:
-- select policyname, roles, cmd, qual, with_check from pg_policies
--  where schemaname = 'storage' and tablename = 'objects';
