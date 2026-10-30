// ============================================================
// Edge Function: admin-tenant-ops  (v1)
// Platform-level clinic management for the Super Admin.
// Actions (POST JSON):
//   { action: "delete_clinic", tenant_id, confirm_name }
//     -> PERMANENTLY deletes the whole clinic: every row in all
//        tenant-scoped tables, every login (Auth user) of the
//        clinic, and the tenant record itself. confirm_name
//        must match the clinic name exactly (typed in the UI).
// Caller must be super_admin AND in a TOTP-verified (aal2)
// session — the same rule as the other platform functions,
// because service_role bypasses RLS and this is the most
// destructive action in the system. Clinic admins can NEVER
// call this function.
// NOTE on audit: there is deliberately no audit_logs row for a
// clinic deletion — the clinic's own audit log is deleted with
// the clinic. The record of the action is this function's
// response and the platform function logs.
// Deploy: supabase functions deploy admin-tenant-ops
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
// The caller's session assurance level lives in the JWT ("aal1" =
// password only, "aal2" = TOTP challenge completed). The payload
// segment is base64url JSON; signature verification is Supabase's
// job on the getUser() call below — here we only read the claim.
function jwtAal(authHeader: string): string {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const part = token.split(".")[1];
    if (!part) return "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload?.aal === "string" ? payload.aal : "";
  } catch {
    return "";
  }
}

// Every tenant-scoped table, children before parents. The delete
// runs in passes, so a row blocked by a foreign key in one pass
// is retried after the rows referencing it are gone.
const TENANT_TABLES = [
  "prescription_items", "lab_results", "medication_administration", "nursing_notes",
  "payments", "stock_movements", "beds", "queue_events", "notifications",
  "audit_logs", "support_access_grants", "purchase_orders",
  "tokens", "consultations", "prescriptions", "lab_orders", "invoices",
  "expenses", "payroll", "attendance", "leave_requests", "duty_roster",
  "doctor_commissions", "staff_private", "operations",
  "medicine_batches", "medicines", "suppliers", "patients",
  "wards", "departments", "settings", "subscriptions", "role_permissions", "staff",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let payload: { action?: string; tenant_id?: string; confirm_name?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = payload?.action;
  const tenantId = payload?.tenant_id;
  if (action !== "delete_clinic") return json({ error: "Unknown action" }, 400);
  if (!tenantId) return json({ error: "tenant_id is required" }, 400);

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: caller } = await admin
    .from("user_profiles")
    .select("id, role")
    .eq("id", userData.user.id)
    .single();
  if (!caller || caller.role !== "super_admin") {
    return json({ error: "Only the Super Admin can delete a clinic" }, 403);
  }
  if (jwtAal(authHeader) !== "aal2") {
    return json({ error: "Super Admin must complete 2FA (aal2 session) for user management" }, 403);
  }

  const { data: tenant } = await admin
    .from("tenants")
    .select("id, name")
    .eq("id", tenantId)
    .single();
  if (!tenant) return json({ error: "Clinic not found" }, 404);
  if ((payload?.confirm_name ?? "") !== tenant.name) {
    return json({ error: "confirm_name must match the clinic name exactly" }, 400);
  }

  // Capture the clinic's login ids before their profiles are deleted.
  const { data: profiles } = await admin
    .from("user_profiles")
    .select("id")
    .eq("tenant_id", tenantId);
  const userIds = (profiles ?? []).map((p: { id: string }) => p.id);

  // Delete tenant data in passes; verify after each pass. If
  // anything is left after the last pass, stop and report it —
  // the tenant record itself is NOT deleted in that case.
  const leftovers: Record<string, number> = {};
  for (let pass = 0; pass < 3; pass++) {
    for (const t of TENANT_TABLES) {
      await admin.from(t).delete().eq("tenant_id", tenantId);
    }
    let remaining = 0;
    for (const t of TENANT_TABLES) {
      const { count } = await admin
        .from(t)
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId);
      if ((count ?? 0) > 0) {
        leftovers[t] = count ?? 0;
        remaining += count ?? 0;
      } else {
        delete leftovers[t];
      }
    }
    if (remaining === 0) break;
  }
  if (Object.keys(leftovers).length > 0) {
    return json({
      error: "Some clinic data could not be deleted; the clinic was NOT deleted",
      leftovers,
    }, 409);
  }

  // Profiles first, then the Auth users — the same order as the
  // proven delete_user flow in admin-user-ops.
  const { error: profErr } = await admin
    .from("user_profiles")
    .delete()
    .eq("tenant_id", tenantId);
  if (profErr) return json({ error: "Profile delete failed: " + profErr.message }, 400);

  let usersDeleted = 0;
  const warnings: string[] = [];
  for (const uid of userIds) {
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) warnings.push(`Auth user ${uid}: ${delErr.message}`);
    else usersDeleted++;
  }

  const { error: tenErr } = await admin.from("tenants").delete().eq("id", tenantId);
  if (tenErr) return json({ error: "Tenant delete failed: " + tenErr.message }, 400);

  return json({
    ok: true,
    action,
    clinic: tenant.name,
    tenant_id: tenantId,
    users_deleted: usersDeleted,
    warnings,
  });
});
