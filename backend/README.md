# MediCore — Medical POS & Clinic Management (LIVE on Supabase)

## Connection status (honest)
- The app IS connected to the real Supabase project gpxtcbeovvjypwbsnlor.supabase.co.
  Sign-in is real Supabase Auth (email + password). After login the app reads
  user_profiles for role + tenant_id and routes by role. Logout, session
  refresh (refresh_token rotation) and forgot-password (Auth recover email)
  are wired. The old role picker / demo sign-in is REMOVED.
- ALL data access (tokens, patients, consultations, pharmacy POS, finance,
  HR, nursing, lab, settings) goes browser -> Supabase PostgREST with the
  user's JWT. The artifact's built-in database is no longer used by the app.
- RLS is the enforcement layer: tenant_id USING + WITH CHECK on every table,
  has_permission() default-DENY with the auto-seeded per-tenant matrix,
  delete = clinic_admin only, salary/CNIC only in staff_private
  (hr_manager / accountant / clinic_admin), same-tenant composite FKs,
  super_admin bypass policy.
- Token queue + TV board use Supabase Realtime (postgres_changes on tokens /
  queue_events / notifications) with a 4-second polling fallback. The TV
  screen signs in as the per-clinic "display" user (tv@<clinic>) — read-only
  queue access, NO anon access anywhere.
- Creating clinic users from the app must go through the create-clinic-user
  Edge Function (service_role server-side only). Its full source is in the
  Developer tab; deploy it before using Settings -> Add user in production.

## What YOU still need to run (one-time, in order)
1. Main schema SQL            — DONE (confirmed by Hassan)
2. Security hardening patch   — DONE (confirmed by Hassan)
3. Seed SQL (Developer tab)   — creates 2 clinics, 19 users, sample data
4. Deploy Edge Function       — supabase functions deploy create-clinic-user
5. Supabase Auth settings     — set Site URL to the app URL so password
   reset emails land back in the app (Auth -> URL Configuration).

## Live test report
Developer tab -> "Run live tests" executes the real checks against YOUR
project with YOUR signed-in session: tenant isolation (Clinic A session
querying Clinic B rows must return 0), nurse/token_operator finance +
payroll denial (permission matrix + RLS), pharmacy oversell (a stock
movement beyond batch quantity must be rejected by the DB and the batch
must be unchanged), and token -> OPD fee posting (today's tokens must each
have a matching paid OPD invoice in Finance). Results are pass/fail/skip
with the actual server response — nothing is faked.

## Still mock / incomplete (not hidden)
- Print views use the browser print dialog (Save as PDF) — no server-side
  PDF generator.
- Google Sheets sync: the Apps Script + sheets-sync Edge Function design
  from the earlier build still applies but is NOT deployed to this project
  yet; the in-app Developer tab carries the create-clinic-user function,
  which Hassan asked to prioritise.
- QR attendance uses a button that records method='qr' after the staff
  identity is chosen in the app; there is no camera scanner in this build.
- The seed "today's queue" is dated the day the seed SQL is run.

## Updates — 2026-10-29 (privacy lockdown + 2FA, all live)
- Privacy lockdown is LIVE in the Supabase project: super_admin has NO direct
  access to clinic data (restrictive tenant_isolation_guard policies).
  Support access works only through support_access_grants created by the
  clinic's own admin (max 7 days, revocable). The lockdown SQL was run live
  by Hassan together with his own add-ons, so it is intentionally NOT
  re-created as a file here (a re-typed copy could differ from production).
- Edge Functions are now v3 (full sources under supabase/functions/):
  create-clinic-user — super_admin creates ONLY clinic_admin; every creation
  is audit-logged. admin-user-ops — set_password REMOVED; send_reset added;
  delete / set_active / send_reset are all audit-logged. Both v3 functions
  additionally require an aal2 (TOTP-verified) session for super_admin
  callers, because service_role bypasses RLS. sheets-sync — unchanged,
  one-way Supabase -> Google Sheets.
- sql/04-aal2-super-admin.sql — the RLS half of the 2FA enforcement
  (tenants / plans / subscriptions require an aal2 super_admin session).
  Already run live; kept for reference / rebuilds.
- The standalone desktop app (medicore-app) is the primary client.
  Super Admin screens there: Platform Dashboard (counts only), Tenants
  (with Add clinic/hospital), Plans (add/edit), Subscriptions, Users
  (clinic_admin accounts only — clinic staff are managed by their own
  clinic admin).
