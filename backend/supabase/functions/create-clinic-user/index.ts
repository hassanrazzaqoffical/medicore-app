// ============================================================
// Edge Function: create-clinic-user  (supabase/functions/create-clinic-user/index.ts)
// Creates a clinic user (Supabase Auth + user_profiles + optional
// staff / staff_private rows). service_role stays server-side only.
// Caller must be super_admin or clinic_admin (checked from the
// caller's own JWT -> user_profiles). clinic_admin can only create
// non-admin roles inside their own tenant.
// PRIVACY LOCKDOWN: a super_admin can create ONLY a clinic_admin
// (he onboards the clinic's owner; the clinic's own admin creates
// its staff). Every successful creation is written to audit_logs.
// v3: a super_admin caller must ALSO be in a TOTP-verified (aal2)
// session — service_role bypasses RLS, so that check lives here.
// Deploy: supabase functions deploy create-clinic-user
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CREATABLE_BY_CLINIC_ADMIN = ["doctor","nurse","pharmacist","token_operator","accountant","hr_manager","lab_operator","display"];
// Privacy lockdown: the Super Admin onboards ONLY the clinic_admin of a
// clinic. Clinic staff accounts are created by the clinic's own admin.
const CREATABLE_BY_SUPER_ADMIN = ["clinic_admin"];
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

// Writes one audit_logs row for a user creation (server-side, service_role).
// A logging failure never breaks the creation itself.
async function logAudit(
  admin: ReturnType<typeof createClient>,
  callerId: string,
  row: { tenant_id: string; user_id_new: string; email: string; role: string },
): Promise<void> {
  try {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      user_id: callerId,
      table_name: "user_profiles",
      record_id: row.user_id_new,
      action: "user_created",
      new_data: { email: row.email, role: row.role },
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
  const email = String(payload.email ?? "").trim().toLowerCase();
  const password = String(payload.password ?? "");
  const fullName = String(payload.full_name ?? "").trim();
  const role = String(payload.role ?? "");
  const phone = payload.phone ? String(payload.phone) : null;
  const staff = (payload.staff ?? null) as Record<string, unknown> | null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email" }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
  if (!fullName) return json({ error: "full_name is required" }, 400);

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: callerProfile, error: profileError } = await admin
    .from("user_profiles").select("id, tenant_id, role, is_active").eq("id", userData.user.id).single();
  if (profileError || !callerProfile || !callerProfile.is_active) return json({ error: "Caller profile not found or inactive" }, 403);

  const isSuper = callerProfile.role === "super_admin";
  const isClinicAdmin = callerProfile.role === "clinic_admin";
  if (!isSuper && !isClinicAdmin) return json({ error: "Insufficient role" }, 403);
  // v3 (aal2 enforcement): database RLS cannot see inside this function
  // (service_role bypasses RLS), so a super_admin caller must prove a
  // TOTP-verified session here as well. Clinic admins are unaffected.
  if (isSuper && jwtAal(authHeader) !== "aal2") {
    return json({ error: "Super Admin must complete 2FA (aal2 session) for user management" }, 403);
  }
  const allowedRoles = isSuper ? CREATABLE_BY_SUPER_ADMIN : CREATABLE_BY_CLINIC_ADMIN;
  if (!allowedRoles.includes(role)) return json({ error: "Role cannot be created by this caller" }, 403);

  const tenantId = isSuper ? String(payload.tenant_id ?? "") : callerProfile.tenant_id;
  if (!tenantId) return json({ error: "tenant_id is required" }, 400);
  if (!isSuper && payload.tenant_id && String(payload.tenant_id) !== callerProfile.tenant_id) {
    return json({ error: "Cannot create users for another tenant" }, 403);
  }
  const { data: tenant, error: tenantError } = await admin.from("tenants").select("id, status").eq("id", tenantId).single();
  if (tenantError || !tenant) return json({ error: "Tenant not found" }, 404);
  if (tenant.status === "suspended") return json({ error: "Tenant is suspended" }, 409);

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: fullName, role, tenant_id: tenantId },
  });
  if (createError || !created.user) return json({ error: createError?.message ?? "User creation failed" }, 400);

  const newUserId = created.user.id;
  const rollback = async (message: string, status: number) => { await admin.auth.admin.deleteUser(newUserId); return json({ error: message }, status); };

  const { error: insertProfileError } = await admin.from("user_profiles").insert({
    id: newUserId, tenant_id: tenantId, role, full_name: fullName, email, phone,
  });
  if (insertProfileError) return rollback(insertProfileError.message, 400);

  let staffId: string | null = null;
  if (staff) {
    const { data: staffRow, error: staffError } = await admin.from("staff").insert({
      tenant_id: tenantId, user_profile_id: newUserId, department_id: staff.department_id ?? null,
      full_name: fullName, role, designation: staff.designation ?? null, phone, email,
    }).select("id").single();
    if (staffError || !staffRow) return rollback(staffError?.message ?? "Staff creation failed", 400);
    staffId = staffRow.id;
    if (staff.cnic != null || staff.basic_salary != null || staff.doctor_share_percent != null) {
      const { error: privateError } = await admin.from("staff_private").insert({
        staff_id: staffId, tenant_id: tenantId, cnic: staff.cnic ?? null,
        basic_salary: staff.basic_salary ?? 0, doctor_share_percent: staff.doctor_share_percent ?? 0,
      });
      if (privateError) return rollback(privateError.message, 400);
    }
  }
  await logAudit(admin, callerProfile.id, { tenant_id: tenantId, user_id_new: newUserId, email, role });
  return json({ user_id: newUserId, staff_id: staffId, tenant_id: tenantId, role, email }, 201);
});
