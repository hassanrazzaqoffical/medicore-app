// ============================================================
// Edge Function: sheets-sync  (supabase/functions/sheets-sync/index.ts)
// One-way sync: Supabase -> Google Sheet (via Apps Script Web App).
// Caller must be super_admin or clinic_admin (checked from the
// caller's own JWT -> user_profiles).
//   - clinic_admin: syncs ONLY their own tenant (tenant_id in the
//     body is ignored / forced to their tenant).
//   - super_admin: pass { tenant_id } to sync one tenant, or omit
//     it to sync ALL active tenants one by one.
// Body (all optional): { tenant_id?: string, tables?: string[] }
// Required secrets (Edge Functions -> Secrets):
//   SHEETS_WEBAPP_URL  - the Apps Script Web App URL (.../exec)
//   SHEETS_SECRET      - must match SECRET in Code.gs
// service_role stays server-side only, as in the other functions.
// Deploy: supabase functions deploy sheets-sync
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

const DEFAULT_TABLES = [
  "patients",
  "tokens",
  "invoices",
  "payments",
  "expenses",
  "medicines",
  "medicine_batches",
  "lab_orders",
  "staff",
];
const MAX_ROWS_PER_TABLE = 1000;

// Flatten one row for Sheets: objects/arrays become JSON strings.
function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === "object") {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const sheetsUrl = Deno.env.get("SHEETS_WEBAPP_URL") ?? "";
  const sheetsSecret = Deno.env.get("SHEETS_SECRET") ?? "";
  if (!sheetsUrl || !sheetsSecret) {
    return json({ error: "Sheets sync is not configured (set SHEETS_WEBAPP_URL and SHEETS_SECRET secrets)" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);

  let payload: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) payload = JSON.parse(text);
  } catch { return json({ error: "Invalid JSON body" }, 400); }

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: caller, error: callerErr } = await admin
    .from("user_profiles").select("id, tenant_id, role, is_active").eq("id", userData.user.id).single();
  if (callerErr || !caller || !caller.is_active) return json({ error: "Caller profile not found or inactive" }, 403);

  const isSuper = caller.role === "super_admin";
  if (!isSuper && caller.role !== "clinic_admin") return json({ error: "Insufficient role" }, 403);

  // Which tables to sync: requested ones, restricted to the known list.
  const requested = Array.isArray(payload.tables) ? payload.tables.map((t) => String(t)) : null;
  const tables = (requested ?? DEFAULT_TABLES).filter((t) => DEFAULT_TABLES.includes(t));
  if (tables.length === 0) return json({ error: "No valid tables requested" }, 400);

  // Which tenants to sync.
  let tenantIds: string[] = [];
  if (!isSuper) {
    if (!caller.tenant_id) return json({ error: "Caller has no tenant" }, 400);
    tenantIds = [caller.tenant_id];
  } else if (payload.tenant_id) {
    tenantIds = [String(payload.tenant_id)];
  } else {
    const { data: tenants, error: tenantsErr } = await admin
      .from("tenants").select("id").eq("status", "active").order("created_at");
    if (tenantsErr) return json({ error: "Could not list tenants: " + tenantsErr.message }, 500);
    tenantIds = (tenants ?? []).map((t) => t.id as string);
  }
  if (tenantIds.length === 0) return json({ ok: true, results: [] });

  const results: Record<string, unknown>[] = [];

  for (const tenantId of tenantIds) {
    const tenantResult: Record<string, unknown> = { tenant_id: tenantId };

    // Tenant slug is used as the Sheet tab prefix.
    const { data: tenant, error: tenantErr } = await admin
      .from("tenants").select("id, slug, name").eq("id", tenantId).single();
    if (tenantErr || !tenant) {
      tenantResult.error = "Tenant not found";
      results.push(tenantResult);
      continue;
    }
    const clinicSlug = String(tenant.slug ?? tenantId);
    tenantResult.clinic = clinicSlug;

    // Fetch rows per table; a failing table is recorded, not fatal.
    const batch: Record<string, Record<string, unknown>[]> = {};
    const tableInfo: Record<string, unknown> = {};
    for (const table of tables) {
      const { data, error } = await admin
        .from(table).select("*").eq("tenant_id", tenantId).limit(MAX_ROWS_PER_TABLE);
      if (error) {
        tableInfo[table] = { error: error.message };
        continue;
      }
      const rows = (data ?? []).map((r) => flattenRow(r as Record<string, unknown>));
      batch[table] = rows;
      tableInfo[table] = { rows: rows.length };
    }
    tenantResult.tables = tableInfo;

    // Send ONE batch per tenant to the Apps Script Web App.
    // Body shape must match Code.gs doPost: { secret, clinic, tables }.
    try {
      const resp = await fetch(sheetsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: sheetsSecret, clinic: clinicSlug, tables: batch }),
      });
      const respText = await resp.text();
      if (!resp.ok) {
        tenantResult.error = "Apps Script returned HTTP " + resp.status + ": " + respText;
      } else {
        try {
          tenantResult.sheets = JSON.parse(respText);
        } catch {
          tenantResult.sheets = respText;
        }
        const parsed = tenantResult.sheets as Record<string, unknown>;
        if (parsed && parsed.ok === false) {
          tenantResult.error = "Apps Script error: " + String(parsed.error ?? respText);
        }
      }
    } catch (e) {
      tenantResult.error = "Could not reach Apps Script: " + (e instanceof Error ? e.message : String(e));
    }

    results.push(tenantResult);
  }

  return json({ ok: true, results });
});
