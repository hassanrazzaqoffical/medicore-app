// ============================================================
// Edge Function: admin-user-ops  (supabase/functions/admin-user-ops/index.ts)
// Super Admin user management for MediCore:
//   { action: "send_reset", user_id }            -> emails the user a Supabase
//                                                   password-reset link
//   { action: "delete_user",  user_id }          -> deletes Auth user + profile (+ staff rows)
//   { action: "set_active",   user_id, is_active } -> deactivate / reactivate (also bans the Auth user)
// NOTE: "set_password" was REMOVED on purpose (privacy lockdown):
// nobody sets another user's password directly any more; resets
// go through the user's own email. EVERY action taken here is
// written to audit_logs (server-side, via service_role).
// Caller must be super_admin or clinic_admin (checked from the
// caller's own JWT -> user_profiles). A clinic_admin may manage
// (send_reset / set_active / delete_user) users inside their OWN
// tenant only — the tenant check below enforces that for every
// action. service_role stays server-side only.
// v4 (= v3 + clinic_admin tenant-scoped resets/deletes): a super_admin caller must ALSO be in a TOTP-verified (aal2)
// session — service_role bypasses RLS, so that check lives here.
// Deploy: supabase functions deploy admin-user-ops
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Reads the 'aal' claim from the caller's access token. The token is
// validated with auth.getUser() before this is used, so decoding its
// payload only reads claims from an already-verified token.
function jwtAal(authHeader: string): string {
  try {
    const part = authHeader.replace(/^Bearer\s+/i, "").split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
    return String(claims.aal ?? "");
  } catch { return ""; }
}

// Writes one audit_logs row for a super-admin / clinic-admin action.
// Uses the service_role client on purpose: audit_logs is tenant-guarded
// and append-only for app users, so the log write must happen server-side.
// A logging failure never breaks the action itself.
async function logAudit(
  admin: ReturnType<typeof createClient>,
  caller: { id: string },
  target: { id: string; tenant_id: string | null; email: string; role: string },
  actionLabel: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await admin.from("audit_logs").insert({
      tenant_id: target.tenant_id ?? null,
      user_id: caller.id,
      table_name: "user_profiles",
      record_id: target.id,
      action: actionLabel,
      new_data: { email: target.email, role: target.role, ...(extra ?? {}) },
    });
  } catch { /* ignore: audit logging must not fail the action */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Server is not configured" }, 500);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(payload.action ?? "");
  const targetId = String(payload.user_id ?? "");
  if (!["send_reset", "delete_user", "set_active"].includes(action)) return json({ error: "Unknown action" }, 400);
  if (!targetId) return json({ error: "user_id is required" }, 400);

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: caller, error: callerErr } = await admin.from("user_profiles").select("id, tenant_id, role, is_active").eq("id", userData.user.id).single();
  if (callerErr || !caller || !caller.is_active) return json({ error: "Caller profile not found or inactive" }, 403);
  const isSuper = caller.role === "super_admin";
  if (!isSuper && caller.role !== "clinic_admin") return json({ error: "Insufficient role" }, 403);
  // v3 (aal2 enforcement): database RLS cannot see inside this function
  // (service_role bypasses RLS), so a super_admin caller must prove a
  // TOTP-verified session here as well. Clinic admins are unaffected.
  if (isSuper && jwtAal(authHeader) !== "aal2") {
    return json({ error: "Super Admin must complete 2FA (aal2 session) for user management" }, 403);
  }
  // v4: clinic_admins may also send resets and delete users, but ONLY
  // inside their own tenant — that scope is enforced by the tenant
  // check right after the target profile is loaded below.
  if (targetId === caller.id) return json({ error: "You cannot run this on your own account" }, 400);

  const { data: target, error: targetErr } = await admin.from("user_profiles").select("id, tenant_id, role, email").eq("id", targetId).single();
  if (targetErr || !target) return json({ error: "Target user not found" }, 404);
  if (!isSuper && target.tenant_id !== caller.tenant_id) return json({ error: "Target user is in another clinic" }, 403);
  if (target.role === "super_admin" && !isSuper) return json({ error: "Cannot modify a super_admin" }, 403);

  if (action === "send_reset") {
    // Sends the standard Supabase recovery email to the user's own inbox.
    // The link lands on the Auth Site URL configured in the Dashboard.
    const anon = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await anon.auth.resetPasswordForEmail(target.email);
    if (error) return json({ error: error.message }, 400);
    await logAudit(admin, caller, target, "user_password_reset_sent");
    return json({ ok: true, action, user_id: targetId, email: target.email });
  }
  if (action === "set_active") {
    const active = payload.is_active !== false;
    const { error: profErr } = await admin.from("user_profiles").update({ is_active: active }).eq("id", targetId);
    if (profErr) return json({ error: profErr.message }, 400);
    // Ban/unban at the Auth level too, so a deactivated user cannot refresh a session.
    await admin.auth.admin.updateUserById(targetId, { ban_duration: active ? "none" : "876000h" });
    await logAudit(admin, caller, target, active ? "user_reactivated" : "user_deactivated", { is_active: active });
    return json({ ok: true, action, user_id: targetId, is_active: active });
  }
  // delete_user: remove dependent rows first, then profile, then the Auth user.
  await admin.from("staff").update({ user_profile_id: null }).eq("user_profile_id", targetId);
  const { error: delProfErr } = await admin.from("user_profiles").delete().eq("id", targetId);
  if (delProfErr) return json({ error: "Profile delete failed: " + delProfErr.message }, 400);
  const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
  if (delErr) return json({ error: "Auth delete failed: " + delErr.message }, 400);
  await logAudit(admin, caller, target, "user_deleted");
  return json({ ok: true, action, user_id: targetId, email: target.email });
});
