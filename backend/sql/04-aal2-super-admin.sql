-- ============================================================
-- MediCore: Super Admin platform tables require a TOTP-verified
-- session (aal2). A password-only (aal1) super admin session gets
-- NOTHING on tenants / plans / subscriptions, not even reads, so
-- the 2FA screen in the app cannot be bypassed through the API.
-- Clinic users are not affected: the rule only bites callers whose
-- profile role is super_admin. Run in the Supabase SQL Editor.
-- STATUS: already run live by Hassan on 2026-10-29 (verified:
-- aal1 reads return 0 rows, inserts fail 403 naming this policy).
-- Kept here for reference / rebuilds.
-- ============================================================

-- Helper 1: is the current caller a super_admin?
create or replace function public.caller_is_super_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and role = 'super_admin' and is_active
  );
$$;

-- Helper 2: non-super-admins always pass; a super_admin passes
-- only when the session JWT is at aal2 (TOTP challenge completed).
create or replace function public.super_admin_aal2_ok()
returns boolean
language sql
stable
as $$
  select (not public.caller_is_super_admin())
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- Restrictive policies: they are ANDed on top of the existing
-- policies, so nothing else about access changes.
drop policy if exists super_admin_requires_aal2 on public.tenants;
create policy super_admin_requires_aal2 on public.tenants
  as restrictive for all to authenticated
  using (public.super_admin_aal2_ok())
  with check (public.super_admin_aal2_ok());

drop policy if exists super_admin_requires_aal2 on public.plans;
create policy super_admin_requires_aal2 on public.plans
  as restrictive for all to authenticated
  using (public.super_admin_aal2_ok())
  with check (public.super_admin_aal2_ok());

drop policy if exists super_admin_requires_aal2 on public.subscriptions;
create policy super_admin_requires_aal2 on public.subscriptions
  as restrictive for all to authenticated
  using (public.super_admin_aal2_ok())
  with check (public.super_admin_aal2_ok());

-- Rollback (only if ever needed):
-- drop policy if exists super_admin_requires_aal2 on public.tenants;
-- drop policy if exists super_admin_requires_aal2 on public.plans;
-- drop policy if exists super_admin_requires_aal2 on public.subscriptions;
-- drop function if exists public.super_admin_aal2_ok();
-- drop function if exists public.caller_is_super_admin();
