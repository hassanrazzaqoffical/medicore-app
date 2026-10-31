import { createContext, useCallback, useContext, useEffect, useRef, useState, useMemo } from "react";
import { supabase, SUPABASE_URL } from "./supabaseClient.js";
import QRCode from "qrcode";
import jsQR from "jsqr";
import {
  HOSPITAL_TYPES, departmentsForTypes, BUILTIN_LAB_PRICES, STANDARD_LAB_FEE, labPriceInfo,
  specialtyTemplateFor,
} from "./catalog.js";

/* ---------------- helpers ---------------- */
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const rs = (n) => "Rs " + Number(n ?? 0).toLocaleString("en-PK");

/* ---- Phase 3: module gating. The OPTIONAL modules a clinic can switch
   off (settings key 'enabled_modules', per tenant, booleans keyed by the
   app's module ids). Core modules (Dashboard, Tokens, Live Queue/TV,
   Patients, Doctor, Pharmacy, Finance, Reports, Settings, Display) are
   never gated. DEFAULT RULE: the settings key absent, or a module
   missing from the saved object, means that module is ENABLED — a
   clinic never loses a screen because the key was never saved. Used by
   the Settings "Modules on/off" card (below) and by App.jsx nav gating. */
export const OPTIONAL_MODULES = [
  { key: "lab", label: "Lab" },
  { key: "nursing", label: "Nursing" },
  { key: "hr", label: "HR & Attendance" },
  { key: "operations", label: "Operations (OT)" },
];
export const moduleEnabled = (value, key) => value?.[key] !== false;

export function useLoad(fn, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setData(await fn()); }
    catch (e) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, err, loading, reload: load };
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

/* Create a patient row and return it. Random MR numbers can collide with
   the unique constraint — retry with a fresh number a few times. Shared by
   the Patients screen and the one-step Patient+Token flow on Tokens. */
export async function createPatientRecord(tid, fields) {
  let mr = "MRN-" + Math.floor(100000 + Math.random() * 900000);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await q(supabase.from("patients").insert({ tenant_id: tid, mr_number: mr, ...fields }).select().single());
    } catch (e) {
      lastErr = e;
      if (!/duplicate|unique/i.test(e.message)) throw e;
      mr = "MRN-" + Math.floor(100000 + Math.random() * 900000);
    }
  }
  throw lastErr;
}

/* ---------------- Toast popups ----------------
   Every screen reports save / delete / edit results through <Notice>;
   Notice now ALSO pops the same message as a floating toast, so the
   result is visible wherever the user is on the page — no scrolling
   back to the top needed (same idea as the token slip popup). */
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.kind === "err" ? "⚠ " : "✅ "}{t.text}</span>
            <button className="toast-x" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>✕</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Notice({ err, ok }) {
  const toast = useToast();
  const shown = useRef("");
  // Friendlier wording for Supabase Auth's reset-email cooldown error.
  const friendly = (x) => (x && /only request this after/i.test(x)
    ? "Already requested a moment ago — please wait a minute and try once. For a password reset, the email may already be in the inbox (check Spam too)."
    : x);
  const e2 = friendly(err);
  const o2 = friendly(ok);
  useEffect(() => {
    const text = e2 || o2 || "";
    if (text && text !== shown.current) { shown.current = text; toast?.(text, e2 ? "err" : "ok"); }
    if (!text) shown.current = "";
  }, [e2, o2]);
  if (e2) return <div className="err" style={{ marginBottom: 12 }}>{e2}</div>;
  if (o2) return <div className="ok" style={{ marginBottom: 12 }}>{o2}</div>;
  return null;
}

/* ---- Tiny dependency-free ZIP writer (stored entries) + CSV helpers,
   used by the clinic backup export in Settings. ---- */
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const data = enc.encode(f.content); const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}
function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function GenericTable({ rows }) {
  if (!rows || rows.length === 0) return <p className="muted">No records yet.</p>;
  const cols = Object.keys(rows[0]).filter((c) => !["tenant_id", "updated_at"].includes(c));
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead><tr>{cols.map((c) => <th key={c}>{c.replaceAll("_", " ")}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {cols.map((c) => <td key={c}>{typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Receipt / printing ----------------
   Branding lives in the settings table (same as the hosted app):
   - key 'clinic_branding' per tenant: { logo, tagline, address, phone,
     email, website, end_note, paper, show_footer }
   - key 'saas_footer' per tenant: { name, tagline, phone, email, website }
   Clinic name comes from the tenants row. */
const PrintCtx = createContext(null);
export const usePrint = () => useContext(PrintCtx);

/* The receipt slip itself — used by PrintProvider for the printed copy
   and by screens (e.g. Tokens) for an on-screen preview, so what the
   user sees is exactly what prints. */
export function ReceiptSlip({ brand, doc }) {
  const b = brand ?? { clinicName: "Clinic", tenant: null, clinic: {}, footer: {} };
  const clinic = b.clinic ?? {};
  const tenant = b.tenant ?? {};
  const paper = ["80mm", "58mm", "A4"].includes(doc?.paper) ? doc.paper : ["80mm", "58mm", "A4"].includes(clinic.paper) ? clinic.paper : "80mm";
  const headerContact = [clinic.phone || tenant.phone, clinic.email || tenant.email, clinic.website].filter(Boolean).join(" · ");
  const headerAddress = clinic.address || tenant.address || "";
  const f = b.footer ?? {};
  const footerRest = [f.tagline, f.phone, f.email, f.website].filter(Boolean).join(" · ");
  const showFooter = clinic.show_footer !== false && Boolean(f.name || footerRest);
  if (!doc) return null;
  return (
    <div className={`receipt ${paper === "A4" ? "a4" : paper === "58mm" ? "w58" : "w80"}`}>
      <div className="r-head">
        {clinic.logo && <img className="r-logo" src={clinic.logo} alt="" />}
        <div className="r-clinic">{b.clinicName}</div>
        {clinic.tagline && <div className="r-sub">{clinic.tagline}</div>}
        {headerAddress && <div className="r-sub">{headerAddress}</div>}
        {headerContact && <div className="r-sub">{headerContact}</div>}
      </div>
      <div className="r-rule" />
      {doc.title && <div className="r-title">{doc.title}</div>}
      {doc.big && <div className="r-big">{doc.big}</div>}
      <div className="r-lines">
        {(doc.lines ?? []).map((l, i) => (
          <div className="r-line" key={i}><span>{l.k}</span><span className="r-val">{String(l.v ?? "")}</span></div>
        ))}
      </div>
      {doc.note && <div className="r-note">{doc.note}</div>}
      {clinic.end_note && <div className="r-note">{clinic.end_note}</div>}
      {showFooter && (
        <>
          <div className="r-rule" />
          <div className="r-foot">
            {f.name && <div className="r-footname">{f.name}</div>}
            {footerRest && <div>{footerRest}</div>}
          </div>
        </>
      )}
    </div>
  );
}

export function PrintProvider({ tenantId, children }) {
  const [doc, setDoc] = useState(null);
  const [brand, setBrand] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!tenantId) { if (live) setBrand({ clinicName: "MediCore", tenant: null, clinic: {}, footer: {} }); return; }
      try {
        const [tenant, cb, sf] = await Promise.all([
          q(supabase.from("tenants").select("*").eq("id", tenantId).maybeSingle()),
          q(supabase.from("settings").select("value").eq("tenant_id", tenantId).eq("key", "clinic_branding").maybeSingle()),
          q(supabase.from("settings").select("value").eq("tenant_id", tenantId).eq("key", "saas_footer").maybeSingle()),
        ]);
        if (live) setBrand({ clinicName: tenant?.name ?? "Clinic", tenant, clinic: cb?.value ?? {}, footer: sf?.value ?? {} });
      } catch { if (live) setBrand({ clinicName: "Clinic", tenant: null, clinic: {}, footer: {} }); }
    })();
    return () => { live = false; };
  }, [tenantId]);

  const printReceipt = useCallback((d) => setDoc({ ...d, _at: Date.now() }), []);
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => window.print(), 80);
    return () => clearTimeout(t);
  }, [doc]);

  const b = brand ?? { clinicName: "Clinic", tenant: null, clinic: {}, footer: {} };
  const paper = ["80mm", "58mm", "A4"].includes(doc?.paper) ? doc.paper : ["80mm", "58mm", "A4"].includes((b.clinic ?? {}).paper) ? (b.clinic ?? {}).paper : "80mm";

  return (
    <PrintCtx.Provider value={{ printReceipt, brand: b }}>
      {children}
      {doc && (
        <div className="receipt-print-area" aria-hidden="true">
          <style>{`@page { size: ${paper === "A4" ? "A4" : paper + " auto"}; margin: ${paper === "A4" ? "12mm" : "4mm"}; }`}</style>
          <ReceiptSlip brand={b} doc={doc} />
        </div>
      )}
    </PrintCtx.Provider>
  );
}

/* Stat cards row — every role's home screen opens with a summary
   of ITS OWN work (never clinic-wide or other departments' data). */
export function StatCards({ items }) {
  return (
    <div className="grid cols-4" style={{ marginBottom: 14 }}>
      {items.map((it, i) => (
        <div className="stat" key={i}><div className={`ic ${it.tone ?? ""}`}>{it.icon}</div><div><div className="lb">{it.label}</div><div className="vl">{it.value}</div></div></div>
      ))}
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
export function Dashboard({ profile }) {
  const tid = profile.tenant_id;
  const { data } = useLoad(async () => {
    const day = todayStr();
    const [patientsCount, tokens, invoices, batches, medicines] = await Promise.all([
      // head:true returns data:null — the count lives on the response, not in data.
      supabase.from("patients").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0),
      q(supabase.from("tokens").select("id,status").eq("token_date", day)),
      q(supabase.from("invoices").select("total_amount,status,created_at").eq("status", "paid")),
      q(supabase.from("medicine_batches").select("id,quantity,expiry_date,medicine_id,batch_no")),
      q(supabase.from("medicines").select("id,name,reorder_level")),
    ]);
    const revenueToday = (invoices ?? []).filter((i) => String(i.created_at).slice(0, 10) === day)
      .reduce((s, i) => s + Number(i.total_amount || 0), 0);
    const medMap = Object.fromEntries((medicines ?? []).map((m) => [m.id, m]));
    const low = (batches ?? []).filter((b) => Number(b.quantity) <= Number(medMap[b.medicine_id]?.reorder_level ?? 10));
    const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const expired = (batches ?? []).filter((b) => b.expiry_date && b.expiry_date < day && Number(b.quantity) > 0);
    const expiring = (batches ?? []).filter((b) => b.expiry_date && b.expiry_date >= day && b.expiry_date <= in30 && Number(b.quantity) > 0);
    return {
      patients: patientsCount,
      tokens: tokens ?? [], revenueToday, low, expired, expiring, medMap,
    };
  }, [tid]);
  const t = data?.tokens ?? [];
  return (
    <div>
      <h2>Welcome, {profile.full_name}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{profile.role.replaceAll("_", " ")} · {todayStr()}</p>
      <div className="grid cols-4">
        <div className="card"><div className="muted">Patients (clinic)</div><div className="big">{data ? (data.patients ?? 0) : "—"}</div></div>
        <div className="card"><div className="muted">Tokens today</div><div className="big">{t.length}</div></div>
        <div className="card"><div className="muted">Waiting now</div><div className="big">{t.filter((x) => x.status === "waiting").length}</div></div>
        <div className="card"><div className="muted">Revenue today</div><div className="big">{data ? rs(data.revenueToday) : "—"}</div></div>
      </div>
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>⚠ Low stock</h3>
          {data && data.low.length === 0 && <p className="muted">No batch is low on stock.</p>}
          {data && data.low.map((b) => <div key={b.id}>• {data.medMap?.[b.medicine_id]?.name ?? "Medicine"} — batch {b.batch_no ?? "—"} · stock {b.quantity}</div>)}
        </div>
        <div className="card">
          <h3>⏰ Expiry alerts</h3>
          {data && data.expired.length === 0 && data.expiring.length === 0 && <p className="muted">No batch is expired or expiring soon.</p>}
          {data && data.expired.map((b) => <div key={b.id} style={{ color: "#b91c1c" }}>⛔ EXPIRED — {data.medMap?.[b.medicine_id]?.name ?? "Medicine"} · batch {b.batch_no ?? "—"} · exp {b.expiry_date} · qty {b.quantity}</div>)}
          {data && data.expiring.map((b) => <div key={b.id}>• {data.medMap?.[b.medicine_id]?.name ?? "Medicine"} · batch {b.batch_no ?? "—"} · exp {b.expiry_date} · qty {b.quantity}</div>)}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Tokens ---------------- */
export function Tokens({ profile, tvMode = false }) {
  const tid = profile.tenant_id;
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [form, setForm] = useState({ patient_id: "", department_id: "", doctor_id: "" });
  /* One-step Patient + Token: mode 'new' shows a small patient form inside
     the issue card; one click creates the patient and issues the token. */
  const [mode, setMode] = useState("new");
  const [np, setNp] = useState({ full_name: "", phone: "", age_years: "", gender: "male" });
  const [dupList, setDupList] = useState(null);
  /* Phase 2A: the optional specialty for the chosen department. It comes
     from the clinic's specialty_catalog (Settings) and is SESSION-ONLY —
     it is shown on the receipt and the "abhi issue hua" bar, never stored
     on the token row. */
  const [specialty, setSpecialty] = useState("");
  const setNpF = (k) => (e) => setNp({ ...np, [k]: e.target.value });
  const { printReceipt, brand } = usePrint() ?? {};
  const { data, reload } = useLoad(async () => {
    const day = todayStr();
    const [tokens, patients, depts, doctors, staffDocs, settings, specCatRow, docAssignRow] = await Promise.all([
      q(supabase.from("tokens").select("*").eq("token_date", day).order("token_number")),
      q(supabase.from("patients").select("id,full_name,mr_number").eq("is_active", true).order("full_name")),
      q(supabase.from("departments").select("id,name").eq("is_active", true).order("name")),
      q(supabase.from("user_profiles").select("id,full_name").eq("role", "doctor").eq("is_active", true)),
      /* tokens.doctor_id is a FOREIGN KEY to the staff table, NOT to
         user_profiles — so the picked doctor's profile id must be mapped
         to their staff row id before inserting. The link lives on
         staff.user_profile_id. We read the staff_directory VIEW (same
         columns) because the staff table itself is only readable by
         admin roles; the view is readable by every clinic role. */
      q(supabase.from("staff_directory").select("id,user_profile_id,full_name").eq("tenant_id", tid).eq("role", "doctor").eq("is_active", true)),
      q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "fee_setup").maybeSingle()),
      q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "specialty_catalog").maybeSingle()),
      q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "doctor_assignments").maybeSingle()),
    ]);
    return {
      tokens: tokens ?? [], patients: patients ?? [], depts: depts ?? [], doctors: doctors ?? [], staffDocs: staffDocs ?? [],
      fee: settings?.value?.opd_fee ?? 800,
      specCat: specCatRow?.value ?? {}, docAssign: docAssignRow?.value ?? {},
    };
  }, [tid]);
  useEffect(() => { const i = setInterval(reload, 5000); return () => clearInterval(i); }, [reload]);
  const [lastIssued, setLastIssued] = useState(null);
  /* The just-issued token's receipt doc — drives the instant preview
     popup; the same doc is sent to the printer automatically. */
  const [slip, setSlip] = useState(null);
  /* Set when a token was issued WITHOUT its doctor because the picked
     doctor has no staff row (tokens.doctor_id must be a staff id). */
  const [docSkipNote, setDocSkipNote] = useState("");

  /* One receipt doc for a token — used by the auto-print, the preview
     popup and the manual Print buttons, so all three always match. */
  const tokenDoc = (tok, inv, spec) => ({
    title: "OPD Token", big: "#" + tok.token_number,
    lines: [
      { k: "Patient", v: pName(tok.patient_id) },
      { k: "Department", v: dName(tok.department_id) },
      { k: "Doctor", v: docName(tok.doctor_id) },
      ...(spec ? [{ k: "Specialty", v: spec }] : []),
      { k: "Fee", v: rs(tok.fee_pkr) },
      ...(inv ? [{ k: "Invoice", v: inv.invoice_number }] : []),
      { k: "Date", v: tok.token_date ?? todayStr() },
    ],
  });

  /* Issue a token for a known patient id. The token insert ALWAYS sends
     priority: 0 (integer) — the tokens.priority column is an integer, and
     sending the text "normal" is what produced the database error
     'invalid input syntax for type integer: "normal"'. */
  async function issueTokenFor(patientId) {
    setMsg({ err: "", ok: "" }); setDocSkipNote("");
    try {
      if (!patientId) throw new Error("Select a patient.");
      if (!form.department_id) throw new Error("Select a department.");
      const fee = Number(data.fee ?? 0);
      /* The dropdown selection is a user_profiles id (Phase 2A assignments
         are keyed by profile id), but tokens.doctor_id references STAFF —
         sending the profile id fails with a 409 FK violation. Map
         profile -> staff id via staff_directory.user_profile_id. A doctor
         with no staff row cannot be stored: issue the token WITHOUT the
         doctor (never block the queue) and show a note instead. */
      let staffDoctorId = null;
      if (form.doctor_id) {
        staffDoctorId = (data?.staffDocs ?? []).find((s) => s.user_profile_id === form.doctor_id)?.id ?? null;
        if (!staffDoctorId) {
          const docLabel = (data?.doctors ?? []).find((d) => d.id === form.doctor_id)?.full_name ?? "Selected doctor";
          setDocSkipNote(`Note: no staff record found for ${docLabel} — the token was issued without a doctor. Add the doctor's staff entry in HR so the name appears on tokens.`);
        }
      }
      const token = await q(supabase.from("tokens").insert({
        tenant_id: tid, patient_id: patientId, department_id: form.department_id,
        doctor_id: staffDoctorId, fee_pkr: fee, status: "waiting", priority: 0,
        issued_by: profile.id,
      }).select().single());
      // IMPORTANT: the OPD fee invoice + cash payment are created by the
      // database trigger (post_opd_fee_for_token) in the same transaction as
      // this token insert. The app must NOT insert its own invoice here, or
      // Finance will double-count every token fee. Below we only READ BACK
      // the trigger-created invoice, for the message and the receipt.
      let inv = null;
      if (fee > 0) {
        const { data: invs } = await supabase.from("invoices")
          .select("id,invoice_number,total_amount,status,created_at")
          .eq("tenant_id", tid).eq("patient_id", patientId).eq("invoice_type", "opd")
          .eq("total_amount", fee).gte("created_at", todayStr())
          .order("created_at", { ascending: false }).limit(1);
        inv = invs?.[0] ?? null;
      }
      setLastIssued({ token, inv, specialty: specialty || null });
      const doc = tokenDoc(token, inv, specialty || null);
      setSlip(doc);
      printReceipt?.(doc);
      setMsg({ err: "", ok: fee > 0
        ? `Token #${token.token_number} issued — ${rs(fee)} OPD fee posted to Finance${inv ? ` (${inv.invoice_number})` : ""}.`
        : `Token #${token.token_number} issued — fee is 0, so no invoice was created.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function issue() {
    if (!form.patient_id || !form.department_id) { setMsg({ err: "Patient and department are required.", ok: "" }); return; }
    await issueTokenFor(form.patient_id);
  }
  /* One-step flow: create the patient, then issue. If the phone number
     already belongs to a patient, warn first and let the user pick the
     existing record (or explicitly create a duplicate anyway). */
  async function createAndIssue() {
    const patient = await createPatientRecord(tid, {
      full_name: np.full_name.trim(), gender: np.gender,
      age_years: np.age_years ? Number(np.age_years) : null, phone: np.phone.trim() || null,
    });
    setDupList(null);
    setNp({ full_name: "", phone: "", age_years: "", gender: "male" });
    await issueTokenFor(patient.id);
  }
  async function issueNew() {
    setMsg({ err: "", ok: "" }); setDupList(null);
    try {
      if (!np.full_name.trim()) throw new Error("Patient name is required.");
      if (!form.department_id) throw new Error("Select a department.");
      const phone = np.phone.trim();
      if (phone) {
        const existing = await q(supabase.from("patients")
          .select("id,full_name,mr_number,phone")
          .eq("phone", phone).eq("is_active", true).order("created_at"));
        if (existing && existing.length) { setDupList(existing); return; }
      }
      await createAndIssue();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function createAnyway() {
    setMsg({ err: "", ok: "" });
    try { await createAndIssue(); } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  /* Token edit (waiting tokens): change department / doctor. The doctor
     is picked as a login profile and mapped to the staff id, exactly
     like at issue time. */
  const [editTok, setEditTok] = useState(null);
  const [etf, setEtf] = useState({ department_id: "", doctor_id: "" });
  function openEditTok(t) {
    setEditTok(t);
    setEtf({
      department_id: t.department_id ?? "",
      doctor_id: (data?.staffDocs ?? []).find((sd) => sd.id === t.doctor_id)?.user_profile_id ?? "",
    });
  }
  async function saveEditTok() {
    setMsg({ err: "", ok: "" });
    try {
      const staffId = etf.doctor_id ? ((data?.staffDocs ?? []).find((sd) => sd.user_profile_id === etf.doctor_id)?.id ?? null) : null;
      await q(supabase.from("tokens").update({ department_id: etf.department_id || null, doctor_id: staffId }).eq("id", editTok.id));
      setMsg({ err: "", ok: `Token #${editTok.token_number} updated.` });
      setEditTok(null); reload();
    } catch (e) {
      setMsg({
        err: String(e.message).includes("token_number_key")
          ? "That department already has a token with this number today — the token keeps its number, so it cannot move there. Issue a fresh token in that department instead."
          : e.message, ok: "",
      });
    }
  }
  /* Token delete (Clinic Admin): also removes the token's fee invoice
     and its payment, so Finance stays clean. The trigger invoice number
     embeds the token id without dashes, which is how we find it. */
  async function deleteToken(t) {
    if (!window.confirm(`Delete token #${t.token_number}? Its fee invoice and payment will also be removed from Finance.`)) return;
    setMsg({ err: "", ok: "" });
    try {
      const invs = await q(supabase.from("invoices").select("id,invoice_number").eq("invoice_type", "opd").like("invoice_number", `%${t.id.replaceAll("-", "")}%`));
      for (const inv of invs ?? []) {
        await q(supabase.from("payments").delete().eq("invoice_id", inv.id));
        await q(supabase.from("invoices").delete().eq("id", inv.id));
      }
      await q(supabase.from("tokens").delete().eq("id", t.id));
      setMsg({ err: "", ok: `Token #${t.token_number} deleted${invs?.length ? " — fee invoice removed from Finance" : ""}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function setStatus(token, status) {
    try {
      await q(supabase.from("tokens").update({ status }).eq("id", token.id));
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const pName = (id) => data?.patients.find((p) => p.id === id)?.full_name ?? "—";
  const dName = (id) => data?.depts.find((d) => d.id === id)?.name ?? "—";
  /* Token rows store STAFF ids in doctor_id — resolve the name from the
     staff doctors first, then fall back to profiles (defensive). */
  const docName = (id) => data?.staffDocs.find((s) => s.id === id)?.full_name
    ?? data?.doctors.find((d) => d.id === id)?.full_name ?? "—";
  const pill = (s) => s === "waiting" ? "amber" : s === "in_consultation" ? "blue" : s === "completed" ? "green" : "red";
  /* Phase 2A: specialties of the chosen department, and the Doctor list
     filtered by Settings' doctor_assignments. If at least one doctor is
     assigned to the department, only those doctors are offered; if none
     is assigned, ALL doctors are shown (never an empty dead-end). */
  const deptSpecs = form.department_id ? (data?.specCat?.[form.department_id]?.specialties ?? []) : [];
  const assignedDocIds = form.department_id
    ? Object.entries(data?.docAssign ?? {})
      .filter(([, a]) => (a?.departments ?? []).includes(form.department_id))
      .map(([id]) => id)
    : [];
  const doctorOptions = assignedDocIds.length
    ? (data?.doctors ?? []).filter((d) => assignedDocIds.includes(d.id))
    : (data?.doctors ?? []);
  function onDeptChange(e) {
    const deptId = e.target.value;
    const ids = Object.entries(data?.docAssign ?? {})
      .filter(([, a]) => (a?.departments ?? []).includes(deptId))
      .map(([id]) => id);
    setSpecialty("");
    setForm((f) => ({
      ...f, department_id: deptId,
      // A previously picked doctor who is not assigned to the new
      // department (when it has assignments) must not stay selected.
      doctor_id: ids.length && f.doctor_id && !ids.includes(f.doctor_id) ? "" : f.doctor_id,
    }));
  }
  return (
    <div>
      <h2>Token / OPD Queue</h2>
      <Notice err={msg.err} ok={msg.ok} />
      {!tvMode && <StatCards items={[
        { icon: "🎫", label: "Tokens today", value: (data?.tokens ?? []).length },
        { icon: "⏳", label: "Waiting", value: (data?.tokens ?? []).filter((t) => t.status === "waiting").length, tone: "amber" },
        { icon: "🩺", label: "In consultation", value: (data?.tokens ?? []).filter((t) => t.status === "in_consultation").length, tone: "blue" },
        { icon: "💰", label: "Token fees today", value: rs((data?.tokens ?? []).filter((t) => t.status !== "skipped").reduce((a, t) => a + (Number(t.fee_pkr) || 0), 0)), tone: "violet" },
      ]} />}
      {docSkipNote && <div className="notice" style={{ border: "1px solid #f59e0b", background: "#fffbeb", borderRadius: 10, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>{docSkipNote}</div>}
      {!tvMode && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Issue token — fee {data ? rs(data.fee) : ""}</h3>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className={`btn small ${mode === "new" ? "" : "ghost"}`} onClick={() => { setMode("new"); setDupList(null); }}>New patient — one step</button>
            <button className={`btn small ${mode === "existing" ? "" : "ghost"}`} onClick={() => { setMode("existing"); setDupList(null); }}>Existing patient</button>
          </div>
          {mode === "existing" ? (
            <div style={{ marginBottom: 10 }}><label>Patient</label>
              <select value={form.patient_id} onChange={(e) => setForm({ ...form, patient_id: e.target.value })}>
                <option value="">— choose —</option>
                {data?.patients.map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.mr_number})</option>)}
              </select></div>
          ) : (
            <div className="grid cols-4" style={{ marginBottom: 10 }}>
              <div><label>Patient name *</label><input value={np.full_name} onChange={setNpF("full_name")} placeholder="e.g. Muhammad Ali" /></div>
              <div><label>Phone</label><input value={np.phone} onChange={setNpF("phone")} placeholder="03xx-xxxxxxx" /></div>
              <div><label>Age (years)</label><input type="number" min="0" value={np.age_years} onChange={setNpF("age_years")} /></div>
              <div><label>Gender</label><select value={np.gender} onChange={setNpF("gender")}><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></div>
            </div>
          )}
          <div className="grid cols-3">
            <div><label>Department</label>
              <select value={form.department_id} onChange={onDeptChange}>
                <option value="">— choose —</option>
                {data?.depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></div>
            <div><label>Doctor (optional)</label>
              <select value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}>
                <option value="">— any —</option>
                {doctorOptions.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select>
              {assignedDocIds.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Sirf is department ke assigned doctors (Settings → Doctor assignments).</div>}</div>
            <div><label>Specialty (optional)</label>
              <select value={specialty} onChange={(e) => setSpecialty(e.target.value)} disabled={!form.department_id || deptSpecs.length === 0}>
                <option value="">— any —</option>
                {deptSpecs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              {form.department_id && deptSpecs.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>No specialties are set for this department — add them in Settings → Specialties &amp; Services.</div>}</div>
          </div>
          <div style={{ marginTop: 12 }}>
            {mode === "existing"
              ? <button className="btn" onClick={issue}>Issue Token</button>
              : <button className="btn" onClick={issueNew}>Create patient + Issue token</button>}
          </div>
          {dupList && dupList.length > 0 && (
            <div style={{ marginTop: 12, border: "1px solid #f59e0b", background: "#fffbeb", borderRadius: 10, padding: 12 }}>
              <b>⚠ A patient with this phone number already exists:</b>
              {dupList.map((p) => (
                <div className="row" key={p.id} style={{ marginTop: 8 }}>
                  <span>{p.full_name} ({p.mr_number}){p.phone ? ` · ${p.phone}` : ""}</span>
                  <div className="spacer" />
                  <button className="btn small" onClick={() => issueTokenFor(p.id)}>Issue token to this patient</button>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <button className="btn small ghost" onClick={createAnyway}>Create a new patient anyway</button>
                <button className="btn small ghost" style={{ marginLeft: 8 }} onClick={() => setDupList(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {lastIssued && !tvMode && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row">
            <span>Just issued: <b>Token #{lastIssued.token.token_number}</b> — {pName(lastIssued.token.patient_id)} · Fee {rs(lastIssued.token.fee_pkr)}
              {lastIssued.specialty ? <> · Specialty <b>{lastIssued.specialty}</b></> : null}
              {lastIssued.inv ? <> · Invoice <b>{lastIssued.inv.invoice_number}</b></> : null}</span>
            <div className="spacer" />
            <button className="btn small ghost" onClick={() => printReceipt?.(tokenDoc(lastIssued.token, lastIssued.inv, lastIssued.specialty))}>Print receipt</button>
          </div>
        </div>
      )}
      {editTok && (
        <div className="modal-back" onClick={() => setEditTok(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 16 }}>Edit token #{editTok.token_number}</b>
              <div className="spacer" />
              <button className="btn small ghost" onClick={() => setEditTok(null)}>Close ✕</button>
            </div>
            <div><label>Department</label>
              <select value={etf.department_id} onChange={(e) => setEtf({ ...etf, department_id: e.target.value })}>
                {(data?.depts ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></div>
            <div style={{ marginTop: 10 }}><label>Doctor</label>
              <select value={etf.doctor_id} onChange={(e) => setEtf({ ...etf, doctor_id: e.target.value })}>
                <option value="">— none —</option>
                {(data?.doctors ?? []).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select></div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" onClick={saveEditTok}>Save changes</button>
              <button className="btn ghost" onClick={() => setEditTok(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {slip && (
        <div className="modal-back" onClick={() => setSlip(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 16 }}>✅ Token issued</b>
              <div className="spacer" />
              <button className="btn small ghost" onClick={() => setSlip(null)}>Close ✕</button>
            </div>
            <div className="slip-preview"><ReceiptSlip brand={brand} doc={slip} /></div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => printReceipt?.(slip)}>🖨 Print again</button>
              <button className="btn ghost" onClick={() => setSlip(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <h3>Today's queue (auto-refresh 5s)</h3>
        <table>
          <thead><tr><th>#</th><th>Patient</th><th>Department</th><th>Doctor</th><th>Fee</th><th>Status</th>{!tvMode && <th>Actions</th>}</tr></thead>
          <tbody>
            {(data?.tokens ?? []).map((t) => (
              <tr key={t.id}>
                <td><b>{t.token_number}</b></td><td>{pName(t.patient_id)}</td><td>{dName(t.department_id)}</td>
                <td>{docName(t.doctor_id)}</td><td>{rs(t.fee_pkr)}</td>
                <td><span className={`pill ${pill(t.status)}`}>{t.status}</span></td>
                {!tvMode && <td><div className="row">
                  {t.status === "waiting" && <button className="btn small ghost" onClick={() => openEditTok(t)}>Edit</button>}
                  {profile.role === "clinic_admin" && t.status !== "completed" && <button className="btn small danger" onClick={() => deleteToken(t)}>Delete</button>}
                  <button className="btn small ghost" onClick={() => printReceipt?.({
                    title: "OPD Token", big: "#" + t.token_number,
                    lines: [
                      { k: "Patient", v: pName(t.patient_id) },
                      { k: "Department", v: dName(t.department_id) },
                      { k: "Doctor", v: docName(t.doctor_id) },
                      { k: "Fee", v: rs(t.fee_pkr) },
                      { k: "Status", v: t.status },
                      { k: "Date", v: t.token_date ?? todayStr() },
                    ],
                  })}>Print</button>
                </div></td>}
              </tr>
            ))}
            {(data?.tokens ?? []).length === 0 && <tr><td colSpan={7} className="muted">No tokens today.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- TV Board ----------------
   Full-screen waiting-room board: NOW SERVING (token + patient name),
   UP NEXT, and the WAITING list. Patient names come from the view's
   patient_name column when present; otherwise they are enriched from
   tokens -> patients for roles allowed to read them (a pure display
   login sees names once the view carries patient_name). */
export function TvBoard({ profile }) {
  const [clock, setClock] = useState(new Date());
  useEffect(() => { const i = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(i); }, []);
  const { data, reload } = useLoad(async () => {
    const rows = await q(supabase.from("tv_queue_board").select("*").eq("tenant_id", profile?.tenant_id ?? "00000000-0000-0000-0000-000000000000").eq("token_date", todayStr()).order("token_number"), []);
    let nameById = {};
    if ((rows ?? []).some((r) => !r.patient_name)) {
      try {
        const tks = await q(supabase.from("tokens").select("id, patient:patients!tokens_patient_id_fkey(full_name)").eq("token_date", todayStr()), []);
        for (const t of tks ?? []) if (t.patient?.full_name) nameById[t.id] = t.patient.full_name;
      } catch { /* role cannot read tokens/patients — numbers only */ }
    }
    let clinic = "";
    try {
      const br = await q(supabase.from("settings").select("value").eq("key", "clinic_branding").maybeSingle(), null);
      clinic = br?.value?.clinic_name ?? "";
    } catch { /* branding not readable for this role */ }
    return { clinic, rows: (rows ?? []).map((r) => ({ ...r, patient_name: r.patient_name ?? nameById[r.id] ?? null })) };
  }, []);
  useEffect(() => { const i = setInterval(reload, 5000); return () => clearInterval(i); }, [reload]);
  const rows = data?.rows ?? [];
  const serving = rows.filter((r) => r.status === "in_consultation");
  const waitingAll = rows.filter((r) => r.status === "waiting");
  const hero = serving[0] ?? null;
  const alsoServing = serving.slice(1);
  const upNext = waitingAll[0] ?? null;
  const waiting = waitingAll.slice(1, 13);
  const moreCount = Math.max(0, waitingAll.length - 1 - waiting.length);
  return (
    <div className="tv2">
      <div className="tv2-head">
        <div className="tv2-brand">
          <span className="brandmark" style={{ width: 44, height: 44, fontSize: 24, borderRadius: 12 }}>✚</span>
          <div>
            <div className="tv2-clinic">{data?.clinic || "MediCore"}</div>
            <div className="tv2-sub">OPD QUEUE · LIVE</div>
          </div>
        </div>
        <div className="tv2-clock">{clock.toLocaleTimeString("en-GB")}
          <span>{clock.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
        </div>
      </div>
      <div className="tv2-main">
        <div className="tv2-panel tv2-serving">
          <div className="tv2-label">🟢 NOW SERVING</div>
          {hero ? (
            <>
              <div className="tv2-bignum">#{hero.token_number}</div>
              <div className="tv2-name">{hero.patient_name ?? "—"}</div>
              <div className="tv2-meta">{hero.department_name ?? ""}{hero.doctor_name ? ` · ${hero.doctor_name}` : ""}</div>
              {alsoServing.length > 0 && (
                <div className="tv2-also">{alsoServing.map((r) => <span className="tv2-alsochip" key={r.id}>#{r.token_number} {r.patient_name ?? ""} · {r.department_name ?? ""}</span>)}</div>
              )}
            </>
          ) : <div className="tv2-none">—<span>No patient is being served right now</span></div>}
        </div>
        <div className="tv2-panel tv2-next">
          <div className="tv2-label">⏭ UP NEXT</div>
          {upNext ? (
            <>
              <div className="tv2-nextnum">#{upNext.token_number}</div>
              <div className="tv2-nextname">{upNext.patient_name ?? "—"}</div>
              <div className="tv2-meta">{upNext.department_name ?? ""}</div>
              <div className="tv2-nextnote">Please be ready — your turn is next</div>
            </>
          ) : <div className="tv2-none">—<span>The queue is empty</span></div>}
        </div>
      </div>
      <div className="tv2-wait">
        <div className="tv2-label">⏳ WAITING{waitingAll.length ? ` · ${waitingAll.length} in queue` : ""}</div>
        <div className="tv2-chips">
          {waiting.map((r) => (
            <div className="tv2-chip" key={r.id}><b>#{r.token_number}</b><span>{r.patient_name ?? ""}</span><small>{r.department_name ?? ""}</small></div>
          ))}
          {waiting.length === 0 && <div className="tv2-chipempty">No more patients waiting</div>}
          {moreCount > 0 && <div className="tv2-chip tv2-more">+{moreCount} more</div>}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Patients ---------------- */
export function Patients({ profile }) {
  const canManage = profile?.role === "clinic_admin";
  const tid = profile.tenant_id;
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [f, setF] = useState({ full_name: "", gender: "male", age_years: "", phone: "", cnic: "", blood_group: "", city: "", address: "" });
  const { data, reload } = useLoad(async () =>
    q(supabase.from("patients").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(200)), [tid]);
  async function add() {
    setMsg({ err: "", ok: "" });
    try {
      if (!f.full_name.trim()) throw new Error("Patient name is required.");
      const patient = await createPatientRecord(tid, {
        full_name: f.full_name.trim(), gender: f.gender,
        age_years: f.age_years ? Number(f.age_years) : null, phone: f.phone || null,
        cnic: f.cnic || null, blood_group: f.blood_group || null, city: f.city || null, address: f.address || null,
      });
      setMsg({ err: "", ok: `Patient added (MR: ${patient.mr_number}).` });
      setF({ full_name: "", gender: "male", age_years: "", phone: "", cnic: "", blood_group: "", city: "", address: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [editing, setEditing] = useState(null);
  const [ef, setEf] = useState({});
  const setE = (k) => (e) => setEf({ ...ef, [k]: e.target.value });
  function startEdit(pt) {
    setEditing(pt);
    setEf({ full_name: pt.full_name ?? "", gender: pt.gender ?? "male", age_years: pt.age_years ?? "", phone: pt.phone ?? "", cnic: pt.cnic ?? "", blood_group: pt.blood_group ?? "", city: pt.city ?? "", address: pt.address ?? "", allergies: pt.allergies ?? "" });
  }
  async function saveEdit() {
    setMsg({ err: "", ok: "" });
    try {
      if (!ef.full_name.trim()) throw new Error("Patient name is required.");
      await q(supabase.from("patients").update({
        full_name: ef.full_name.trim(), gender: ef.gender,
        age_years: ef.age_years ? Number(ef.age_years) : null, phone: ef.phone || null,
        cnic: ef.cnic || null, blood_group: ef.blood_group || null, city: ef.city || null,
        address: ef.address || null, allergies: ef.allergies || null,
      }).eq("id", editing.id));
      setMsg({ err: "", ok: `Patient updated: ${ef.full_name.trim()}.` });
      setEditing(null); reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function deactivate(pt) {
    if (!window.confirm(`Delete ${pt.full_name} from the patient list? Their history (tokens, bills) stays safe — this only removes them from the lists.`)) return;
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("patients").update({ is_active: false }).eq("id", pt.id));
      setMsg({ err: "", ok: `Patient deleted from lists: ${pt.full_name}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  return (
    <div>
      <h2>Patients</h2>
      <Notice err={msg.err} ok={msg.ok} />
      <StatCards items={[
        { icon: "🧑", label: "Registered patients", value: (data ?? []).length },
        { icon: "🆕", label: "New today", value: (data ?? []).filter((x) => String(x.created_at ?? "").slice(0, 10) === todayStr()).length, tone: "blue" },
        { icon: "📅", label: "New this month", value: (data ?? []).filter((x) => String(x.created_at ?? "").slice(0, 7) === todayStr().slice(0, 7)).length, tone: "violet" },
        { icon: "⚠", label: "Allergies recorded", value: (data ?? []).filter((x) => x.allergies).length, tone: "amber" },
      ]} />
      {canManage && (
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>New patient</h3>
        <div className="grid cols-4">
          <div><label>Full name *</label><input value={f.full_name} onChange={set("full_name")} /></div>
          <div><label>Gender</label><select value={f.gender} onChange={set("gender")}><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></div>
          <div><label>Age (years)</label><input type="number" value={f.age_years} onChange={set("age_years")} /></div>
          <div><label>Phone</label><input value={f.phone} onChange={set("phone")} /></div>
          <div><label>CNIC</label><input value={f.cnic} onChange={set("cnic")} /></div>
          <div><label>Blood group</label><input value={f.blood_group} onChange={set("blood_group")} /></div>
          <div><label>City</label><input value={f.city} onChange={set("city")} /></div>
          <div><label>Address</label><input value={f.address} onChange={set("address")} /></div>
        </div>
        <div style={{ marginTop: 12 }}><button className="btn" onClick={add}>Add Patient</button></div>
      </div>
      )}
      {editing && canManage && (
        <div className="card" style={{ marginBottom: 14, border: "2px solid #0e7490" }}>
          <h3 style={{ marginTop: 0 }}>Edit patient — {editing.mr_number}</h3>
          <div className="grid cols-4">
            <div><label>Full name *</label><input value={ef.full_name} onChange={setE("full_name")} /></div>
            <div><label>Gender</label><select value={ef.gender} onChange={setE("gender")}><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></div>
            <div><label>Age (years)</label><input type="number" value={ef.age_years} onChange={setE("age_years")} /></div>
            <div><label>Phone</label><input value={ef.phone} onChange={setE("phone")} /></div>
            <div><label>CNIC</label><input value={ef.cnic} onChange={setE("cnic")} /></div>
            <div><label>Blood group</label><input value={ef.blood_group} onChange={setE("blood_group")} /></div>
            <div><label>City</label><input value={ef.city} onChange={setE("city")} /></div>
            <div><label>Address</label><input value={ef.address} onChange={setE("address")} /></div>
            <div><label>Allergies</label><input value={ef.allergies} onChange={setE("allergies")} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={saveEdit}>Save changes</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>MR #</th><th>Name</th><th>Gender</th><th>Age</th><th>Phone</th><th>City</th><th>Actions</th></tr></thead>
          <tbody>
            {(data ?? []).map((p) => <tr key={p.id}><td>{p.mr_number}</td><td><b>{p.full_name}</b></td><td>{p.gender ?? ""}</td><td>{p.age_years ?? ""}</td><td>{p.phone ?? ""}</td><td>{p.city ?? ""}</td><td>{canManage && <div className="row"><button className="btn small ghost" onClick={() => startEdit(p)}>Edit</button><button className="btn small danger" onClick={() => deactivate(p)}>Delete</button></div>}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Doctor / Nursing queue ---------------- */
export function CareQueue({ profile, title, variant = "doctor" }) {
  const isDoc = variant === "doctor";
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [openId, setOpenId] = useState(null);
  const { data, reload } = useLoad(async () => {
    const [tokens, patients, allToday, completed] = await Promise.all([
      q(supabase.from("tokens").select("*").eq("token_date", todayStr()).in("status", ["waiting", "in_consultation"]).order("token_number")),
      q(supabase.from("patients").select("id,full_name,mr_number,age_years,gender,allergies")),
      q(supabase.from("tokens").select("status").eq("token_date", todayStr())),
      q(supabase.from("tokens").select("*").eq("token_date", todayStr()).eq("status", "completed").order("updated_at", { ascending: false })),
    ]);
    return { tokens: tokens ?? [], patients: patients ?? [], allToday: allToday ?? [], completed: completed ?? [] };
  }, []);
  useEffect(() => { const i = setInterval(reload, 5000); return () => clearInterval(i); }, [reload]);
  async function setStatus(t, status) {
    try { await q(supabase.from("tokens").update({ status }).eq("id", t.id)); reload(); }
    catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const pName = (id) => data?.patients.find((p) => p.id === id);
  return (
    <div>
      <h2>{title}</h2>
      <p className="muted" style={{ marginTop: -6 }}>{isDoc ? "Consultation room — open Consult / Rx on a patient to record diagnosis, prescription and lab orders." : "Nursing station — start patients in when they are called, and complete them when the visit is done."}</p>
      <Notice err={msg.err} ok={msg.ok} />
      <StatCards items={[
        { icon: "🎫", label: "Tokens today", value: (data?.allToday ?? []).length },
        { icon: "⏳", label: "Waiting", value: (data?.allToday ?? []).filter((t) => t.status === "waiting").length, tone: "amber" },
        { icon: "🩺", label: "In consultation", value: (data?.allToday ?? []).filter((t) => t.status === "in_consultation").length, tone: "blue" },
        { icon: "✅", label: isDoc ? "Consulted today" : "Completed today", value: (data?.allToday ?? []).filter((t) => t.status === "completed").length, tone: "violet" },
      ]} />
      <div className="card">
        <table>
          <thead><tr><th>Token</th><th>Patient</th><th>Age/Gender</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {(data?.tokens ?? []).map((t) => { const p = pName(t.patient_id); return (
              <tr key={t.id}><td><b>#{t.token_number}</b></td>
                <td>{p?.full_name ?? "—"} <span className="muted">{p?.mr_number ?? ""}</span></td>
                <td>{p?.age_years ?? ""} / {p?.gender ?? ""}</td>
                <td><span className="pill blue">{t.status}</span></td>
                <td><div className="row">
                  {t.status === "waiting" && <button className="btn small" onClick={() => setStatus(t, "in_consultation")}>Start</button>}
                  {t.status === "in_consultation" && <button className="btn small" onClick={() => setStatus(t, "completed")}>Complete</button>}
                  {isDoc && t.status === "in_consultation" && <button className="btn small ghost" onClick={() => setOpenId(openId === t.id ? null : t.id)}>✍️ Consult / Rx</button>}
                </div></td></tr> ); })}
            {(data?.tokens ?? []).length === 0 && <tr><td colSpan={5} className="muted">The queue is empty.</td></tr>}
          </tbody>
        </table>
      </div>
      {isDoc && (data?.tokens ?? []).filter((t) => t.id === openId).map((t) => <ConsultPanel key={t.id} profile={profile} token={t} patient={pName(t.patient_id)} onClose={() => setOpenId(null)} onSaved={() => { setOpenId(null); reload(); }} />)}
      {!isDoc && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Completed today</h3>
          {(data?.completed ?? []).length === 0 ? <p className="muted">No completed visits yet today.</p> : (
            <table>
              <thead><tr><th>Token</th><th>Patient</th><th>Age/Gender</th><th>Finished at</th></tr></thead>
              <tbody>
                {(data?.completed ?? []).map((t) => { const p = pName(t.patient_id); return (
                  <tr key={t.id}><td><b>#{t.token_number}</b></td>
                    <td>{p?.full_name ?? "—"} <span className="muted">{p?.mr_number ?? ""}</span></td>
                    <td>{p?.age_years ?? ""} / {p?.gender ?? ""}</td>
                    <td>{t.updated_at ? new Date(t.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td></tr> ); })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Pharmacy ---------------- */
export function Pharmacy({ profile }) {
  const tid = profile.tenant_id;
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [sel, setSel] = useState({ batch_id: "", qty: 1 });
  const [fefoMed, setFefoMed] = useState("");
  const [fefoNote, setFefoNote] = useState("");
  const [lastSale, setLastSale] = useState(null);
  const { printReceipt } = usePrint() ?? {};
  const [batchFor, setBatchFor] = useState(null);
  const [bf, setBf] = useState({ batch_no: "", quantity: "", expiry_date: "", purchase_price: "", sale_price: "" });
  const setB = (k) => (e) => setBf({ ...bf, [k]: e.target.value });
  const { data, reload } = useLoad(async () => {
    const [meds, batches] = await Promise.all([
      q(supabase.from("medicines").select("*").eq("is_active", true).order("name")),
      q(supabase.from("medicine_batches").select("*").order("expiry_date")),
    ]);
    return { meds: meds ?? [], batches: batches ?? [] };
  }, [tid]);
  /* A medicine only becomes sellable once it has a batch with quantity.
     Medicines added from the catalog without a batch get their first
     batch here, from the Stock list. */
  async function addBatch(m) {
    setMsg({ err: "", ok: "" });
    try {
      if (!bf.batch_no.trim()) throw new Error("Enter a batch number.");
      if (!Number(bf.quantity)) throw new Error("Enter the batch quantity.");
      if (!bf.expiry_date) throw new Error("Enter the batch expiry date — every batch needs one (used for expiry alerts and first-expiry-first-out selling).");
      await q(supabase.from("medicine_batches").insert({
        tenant_id: tid, medicine_id: m.id, batch_no: bf.batch_no.trim(),
        quantity: Number(bf.quantity), expiry_date: bf.expiry_date || null,
        purchase_price: bf.purchase_price === "" ? (m.purchase_price ?? null) : Number(bf.purchase_price),
        sale_price: bf.sale_price === "" ? (m.sale_price ?? null) : Number(bf.sale_price),
        received_date: todayStr(),
      }));
      setMsg({ err: "", ok: `Batch ${bf.batch_no.trim()} added for ${m.name} — it can now be sold.` });
      setBatchFor(null);
      setBf({ batch_no: "", quantity: "", expiry_date: "", purchase_price: "", sale_price: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const medName = (id) => data?.meds.find((m) => m.id === id);
  const batch = data?.batches.find((b) => b.id === sel.batch_id);
  const price = batch ? Number(batch.sale_price ?? medName(batch.medicine_id)?.sale_price ?? 0) : 0;
  /* FEFO: batches load expiry-ordered, so the first in-stock batch of the
     chosen medicine is the one that expires first. Expired-only stock
     still picks the earliest batch but warns loudly. */
  function pickFefo(medId) {
    setFefoMed(medId);
    if (!medId) { setFefoNote(""); return; }
    const bs = (data?.batches ?? []).filter((b) => b.medicine_id === medId && Number(b.quantity) > 0);
    if (!bs.length) { setFefoNote("This medicine has no stock."); return; }
    const fresh = bs.find((b) => b.expiry_date >= todayStr());
    const pick = fresh ?? bs[0];
    setSel({ ...sel, batch_id: pick.id });
    setFefoNote(`FEFO batch: ${pick.batch_no} · exp ${pick.expiry_date} · stock ${pick.quantity}${fresh ? "" : " — ⚠ all batches are expired!"}`);
  }
  async function sell() {
    setMsg({ err: "", ok: "" });
    try {
      if (!batch) throw new Error("Select a batch.");
      const qty = Number(sel.qty);
      if (!qty || qty < 1) throw new Error("Enter a valid quantity.");
      const total = price * qty;
      const invNo = "PH-" + Date.now();
      const inv = await q(supabase.from("invoices").insert({
        tenant_id: tid, invoice_number: invNo, invoice_type: "pharmacy",
        subtotal: total, discount_amount: 0, tax_amount: 0, total_amount: total,
        amount_paid: total, balance_amount: 0, status: "paid",
      }).select().single());
      try {
        await q(supabase.from("stock_movements").insert({
          tenant_id: tid, medicine_id: batch.medicine_id, batch_id: batch.id,
          // Live DB check constraint + seed data use 'out' for stock leaving
          // the shelf ('sale' is not an accepted movement_type there).
          movement_type: "out", quantity: -qty, reference_type: "invoice",
          reference_id: inv.id, performed_by: profile.id,
        }));
      } catch (e) {
        await q(supabase.from("invoices").delete().eq("id", inv.id));
        throw e;
      }
      await q(supabase.from("payments").insert({
        tenant_id: tid, invoice_id: inv.id, amount: total, payment_method: "cash", received_by: profile.id,
      }));
      setLastSale({ invNo, name: medName(batch.medicine_id)?.name ?? "Medicine", batch: batch.batch_no, qty, price, total });
      setMsg({ err: "", ok: `Sale complete — ${invNo}, ${rs(total)}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const today = todayStr();
  return (
    <div>
      <h2>Pharmacy POS</h2>
      <Notice err={msg.err} ok={msg.ok} />
      <StatCards items={[
        { icon: "💊", label: "Products in stock list", value: (data?.meds ?? []).length },
        { icon: "📦", label: "Total stock (units)", value: (data?.batches ?? []).reduce((a, b) => a + (Number(b.quantity) || 0), 0), tone: "blue" },
        { icon: "⚠", label: "Low / out of stock", value: (data?.meds ?? []).filter((m) => (data?.batches ?? []).filter((b) => b.medicine_id === m.id).reduce((a, b) => a + (Number(b.quantity) || 0), 0) <= 10).length, tone: "amber" },
        { icon: "⏰", label: "Expiring in 30 days", value: (data?.batches ?? []).filter((b) => Number(b.quantity) > 0 && b.expiry_date >= todayStr() && b.expiry_date <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).length, tone: "violet" },
      ]} />
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>New sale</h3>
        <div className="row" style={{ gap: 8, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 280px" }}><label>Medicine (FEFO — earliest-expiry batch is auto-selected)</label>
            <select value={fefoMed} onChange={(e) => pickFefo(e.target.value)}>
              <option value="">— select medicine —</option>
              {(data?.meds ?? []).filter((m) => (data?.batches ?? []).some((b) => b.medicine_id === m.id && Number(b.quantity) > 0)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></div>
          {fefoNote && <span className="muted">{fefoNote}</span>}
        </div>
        <div className="grid cols-3">
          <div><label>Medicine / Batch</label>
            <select value={sel.batch_id} onChange={(e) => setSel({ ...sel, batch_id: e.target.value })}>
              <option value="">— choose —</option>
              {data?.batches.map((b) => <option key={b.id} value={b.id}>{medName(b.medicine_id)?.name} · Batch {b.batch_no} · Stock {b.quantity} · {rs(b.sale_price ?? medName(b.medicine_id)?.sale_price ?? 0)} · exp {b.expiry_date}</option>)}
            </select></div>
          <div><label>Quantity</label><input type="number" min="1" value={sel.qty} onChange={(e) => setSel({ ...sel, qty: e.target.value })} /></div>
          <div><label>Total</label><div className="big" style={{ fontSize: 22 }}>{rs(price * Number(sel.qty || 0))}</div></div>
        </div>
        <div style={{ marginTop: 12 }}><button className="btn" onClick={sell}>Complete Sale</button>
          <span className="muted" style={{ marginLeft: 10 }}>Overselling is blocked by the database — stock cannot go negative.</span></div>
        {lastSale && (
          <div className="row" style={{ marginTop: 10 }}>
            <span>Last sale: <b>{lastSale.invNo}</b> — {lastSale.name} × {lastSale.qty} = {rs(lastSale.total)}</span>
            <button className="btn small ghost" onClick={() => printReceipt?.({
              title: "Pharmacy Receipt",
              lines: [
                { k: "Invoice", v: lastSale.invNo },
                { k: "Medicine", v: lastSale.name },
                { k: "Batch", v: lastSale.batch },
                { k: "Qty", v: lastSale.qty },
                { k: "Price", v: rs(lastSale.price) },
                { k: "Total", v: rs(lastSale.total) },
                { k: "Date", v: todayStr() },
              ],
            })}>Print receipt</button>
          </div>
        )}
      </div>
      <PharmacyCatalogAdd profile={profile} tenantMeds={data?.meds ?? []} tenantBatches={data?.batches ?? []} onAdded={reload} />
      <div className="card">
        <h3>Stock</h3>
        <table>
          <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th>Stock</th><th>Sale price</th><th></th></tr></thead>
          <tbody>
            {(data?.batches ?? []).map((b) => { const m = medName(b.medicine_id); const low = Number(b.quantity) <= Number(m?.reorder_level ?? 10); const expired = b.expiry_date < today; const expiring = !expired && b.expiry_date <= soon; return (
              <tr key={b.id}><td><b>{m?.name}</b> <span className="muted">{m?.strength ?? ""}</span></td><td>{b.batch_no}</td>
                <td>{b.expiry_date} {expired && <span className="pill red">expired</span>} {expiring && <span className="pill amber">expiring</span>}</td>
                <td>{b.quantity} {low && <span className="pill amber">low</span>}</td><td>{rs(b.sale_price ?? m?.sale_price ?? 0)}</td><td></td></tr> ); })}
            {(data?.meds ?? []).filter((m) => !(data?.batches ?? []).some((b) => b.medicine_id === m.id)).map((m) => (
              <tr key={m.id}><td><b>{m.name}</b> <span className="muted">{m.strength ?? ""}</span></td><td>—</td>
                <td>—</td><td><span className="pill amber">no stock yet</span></td><td>{rs(m.sale_price ?? 0)}</td>
                <td><button className="btn small" onClick={() => { setBatchFor(batchFor === m.id ? null : m.id); setBf({ batch_no: "", quantity: "", expiry_date: "", purchase_price: "", sale_price: "" }); }}>＋ Add batch</button></td></tr> ))}
            {(data?.batches ?? []).length === 0 && (data?.meds ?? []).length === 0 && <tr><td colSpan={6} className="muted">No medicines yet — add one from the catalog above.</td></tr>}
          </tbody>
        </table>
        {(() => { const m = (data?.meds ?? []).find((x) => x.id === batchFor); if (!m) return null; return (
          <div style={{ marginTop: 12, borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
            <b>Add batch — {m.name}</b>
            <div className="grid cols-4" style={{ marginTop: 8 }}>
              <div><label>Batch no *</label><input value={bf.batch_no} onChange={setB("batch_no")} placeholder="e.g. PND-2026-01" /></div>
              <div><label>Quantity *</label><input type="number" value={bf.quantity} onChange={setB("quantity")} /></div>
              <div><label>Expiry date *</label><input type="date" value={bf.expiry_date} onChange={setB("expiry_date")} /></div>
              <div><label>Sale price (Rs)</label><input type="number" value={bf.sale_price} onChange={setB("sale_price")} placeholder={m.sale_price ?? ""} /></div>
              <div><label>Purchase price (Rs)</label><input type="number" value={bf.purchase_price} onChange={setB("purchase_price")} placeholder={m.purchase_price ?? ""} /></div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button className="btn" onClick={() => addBatch(m)}>Save batch</button>
              <button className="btn ghost" onClick={() => setBatchFor(null)}>Cancel</button>
            </div>
          </div> ); })()}
      </div>
    </div>
  );
}

/* ---------------- QR badge helpers ----------------
   Attendance QR payload is simply the staff member's id (from
   staff_directory). QRCode renders it; jsQR decodes it in browsers
   without BarcodeDetector, so scanning works everywhere. */
export function useQrUrl(text) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let on = true;
    if (text) QRCode.toDataURL(String(text), { width: 260, margin: 1 }).then((u) => { if (on) setUrl(u); }).catch(() => {});
    else setUrl("");
    return () => { on = false; };
  }, [text]);
  return url;
}
const escHtml = (t) => String(t ?? "").replace(/[<>&"]/g, "");
export function printQrBadge(name, sub, url, extra = {}) {
  const w = window.open("", "_blank", "width=430,height=640");
  if (!w) return;
  const clinic = escHtml(extra.clinic || "MediCore Clinic");
  const photo = extra.photo ? `<img src="${extra.photo}" style="width:84px;height:84px;border-radius:50%;object-fit:cover;border:3px solid #0f766e;margin-top:14px"/>` : "";
  w.document.write(`<html><head><title>Employee ID Card</title></head><body style="font-family:sans-serif;margin:0;padding:18px;background:#f1f5f9"><div style="max-width:340px;margin:0 auto;background:#fff;border:1.5px solid #0f766e;border-radius:16px;overflow:hidden;text-align:center"><div style="background:#0b3b4d;color:#fff;padding:14px 10px"><div style="font-size:19px;font-weight:800">${clinic}</div><div style="font-size:11px;letter-spacing:2px;opacity:.85">EMPLOYEE ID CARD</div></div>${photo}<h3 style="margin:10px 0 2px;font-size:19px">${escHtml(name)}</h3><p style="color:#555;margin:0 0 6px">${escHtml(String(sub ?? "").replaceAll("_", " "))}</p><img src="${url}" style="width:200px;height:200px"/><p style="color:#888;font-size:11.5px;padding:0 22px 16px;margin:4px 0 0">Show this code at the HR desk — your attendance is marked by scanning it. If found, please return to the clinic.</p></div><script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body></html>`);
  w.document.close();
}

/* Salary workflow: HR prepares the slip (payroll status "draft" =
   pending approval), Finance approves it to "paid". Notifications are
   best-effort rows in the notifications table — the workflow never
   blocks if one cannot be written. */
export async function notify(tenantId, { userId = null, role = null, type, title, message, refType = null, refId = null }) {
  try {
    await supabase.from("notifications").insert({
      tenant_id: tenantId, user_id: userId, target_role: role, type, title, message,
      reference_type: refType, reference_id: refId,
    });
  } catch { /* best-effort */ }
}
export const payrollStatusLabel = (st) => (st === "draft" ? "pending approval" : st);

/* ---------------- Finance ----------------
   Complete accounts setup: a Debit / Credit cash book with a
   running balance (credits = payments received against invoices,
   debits = clinic expenses), an Add expense form, and the invoice
   register. Accountant + clinic_admin; expenses verified writable
   by the accountant role. */
export function Finance({ profile }) {
  const tid = profile?.tenant_id;
  const { printReceipt } = usePrint() ?? {};
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [ef, setEf] = useState({ title: "", category: "Supplies", amount: "", expense_date: todayStr(), payment_method: "cash", notes: "" });
  const setE = (k) => (e) => setEf({ ...ef, [k]: e.target.value });
  const { data, reload } = useLoad(async () => {
    const [inv, pay, exp, payroll, dir] = await Promise.all([
      q(supabase.from("invoices").select("*").order("created_at", { ascending: false }).limit(200)),
      q(supabase.from("payments").select("*").order("created_at", { ascending: false }).limit(300)),
      q(supabase.from("expenses").select("*").order("created_at", { ascending: false }).limit(300)),
      q(supabase.from("payroll").select("*").order("created_at", { ascending: false }).limit(200)),
      q(supabase.from("staff_directory").select("id,full_name,user_profile_id,role")),
    ]);
    return { inv: inv ?? [], pay: pay ?? [], exp: exp ?? [], payroll: payroll ?? [], dir: dir ?? [] };
  }, []);
  const invById = new Map((data?.inv ?? []).map((x) => [x.id, x]));
  const staffById = new Map((data?.dir ?? []).map((x) => [x.id, x]));
  const salaryDebits = (data?.payroll ?? []).filter((r) => r.status === "paid").map((r) => ({
    key: "s" + r.id, date: String(r.paid_at ?? r.updated_at ?? "").slice(0, 10), ts: new Date(r.paid_at ?? r.updated_at ?? 0).getTime() || 0,
    desc: `Salary — ${staffById.get(r.staff_id)?.full_name ?? "Staff"} (${monthLabel(`${r.period_year}-${String(r.period_month ?? "").padStart(2, "0")}`)})`,
    sub: "", via: "Payroll", credit: 0, debit: Number(r.net_salary) || 0,
  }));
  const pendingSlips = (data?.payroll ?? []).filter((r) => r.status === "draft");
  /* Finance is the ONLY step that pays a salary: HR prepares the slip
     (draft), Finance approves here -> paid, and both HR and the
     employee are notified on their logins. */
  async function approveSlip(r) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("payroll").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", r.id));
      const staff = staffById.get(r.staff_id);
      const label = `${staff?.full_name ?? "Staff"} — ${monthLabel(`${r.period_year}-${String(r.period_month ?? "").padStart(2, "0")}`)}`;
      if (staff?.user_profile_id) notify(tid, { userId: staff.user_profile_id, type: "salary_paid", title: "Your salary has been paid", message: `${monthLabel(`${r.period_year}-${String(r.period_month ?? "").padStart(2, "0")}`)} salary of ${rs(r.net_salary ?? 0)} has been paid by Finance. Your payslip is in My Profile.`, refType: "payroll", refId: r.id });
      notify(tid, { role: "hr_manager", type: "salary_paid", title: `Salary paid — ${label}`, message: `Net ${rs(r.net_salary ?? 0)} was marked paid by Finance.`, refType: "payroll", refId: r.id });
      notify(tid, { role: "clinic_admin", type: "salary_paid", title: `Salary paid — ${label}`, message: `Net ${rs(r.net_salary ?? 0)} was marked paid by Finance.`, refType: "payroll", refId: r.id });
      setMsg({ err: "", ok: `Salary paid: ${label} — ${rs(r.net_salary ?? 0)}. HR and the employee have been notified.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const credits = (data?.pay ?? []).map((p) => { const inv = invById.get(p.invoice_id); return {
    key: "p" + p.id, date: String(p.paid_at ?? p.created_at ?? "").slice(0, 10), ts: new Date(p.paid_at ?? p.created_at ?? 0).getTime() || 0,
    desc: inv ? `${inv.invoice_type.toUpperCase()} fee — ${inv.invoice_number}` : "Payment received", sub: p.reference_no ?? "",
    via: p.payment_method ?? "cash", credit: Number(p.amount) || 0, debit: 0,
  }; });
  const debits = (data?.exp ?? []).map((x) => ({
    key: "e" + x.id, date: String(x.expense_date ?? x.created_at ?? "").slice(0, 10), ts: new Date(x.expense_date ?? x.created_at ?? 0).getTime() || 0,
    desc: x.title ?? "Expense", sub: x.notes ?? "", via: x.category ?? "",
    credit: 0, debit: Number(x.amount) || 0,
  }));
  let bal = 0;
  const ledgerAsc = [...credits, ...debits, ...salaryDebits].sort((a, b) => a.ts - b.ts).map((e) => { bal += e.credit - e.debit; return { ...e, balance: bal }; });
  const ledger = [...ledgerAsc].reverse().slice(0, 120);
  const totCredit = credits.reduce((a, e) => a + e.credit, 0);
  const totDebit = debits.reduce((a, e) => a + e.debit, 0) + salaryDebits.reduce((a, e) => a + e.debit, 0);
  const todayCredit = credits.filter((e) => e.date === todayStr()).reduce((a, e) => a + e.credit, 0);
  async function addExpense() {
    setMsg({ err: "", ok: "" });
    try {
      if (!ef.title.trim()) throw new Error("Enter the expense title.");
      if (!Number(ef.amount)) throw new Error("Enter the amount.");
      await q(supabase.from("expenses").insert({
        tenant_id: tid, title: ef.title.trim(), category: ef.category,
        amount: Number(ef.amount), expense_date: ef.expense_date || todayStr(),
        payment_method: ef.payment_method, notes: ef.notes || null,
      }));
      setMsg({ err: "", ok: `Expense recorded: ${ef.title.trim()} — ${rs(Number(ef.amount))} (Debit).` });
      setEf({ title: "", category: "Supplies", amount: "", expense_date: todayStr(), payment_method: "cash", notes: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  return (
    <div>
      <h2>Finance</h2>
      <p className="muted" style={{ marginTop: -6 }}>Accounts — money in (Credit), money out (Debit), and the running balance.</p>
      <Notice err={msg.err} ok={msg.ok} />
      <StatCards items={[
        { icon: "💰", label: "Total credit (received)", value: rs(totCredit) },
        { icon: "💸", label: "Total debit (expenses)", value: rs(totDebit), tone: "amber" },
        { icon: "⚖️", label: "Net balance", value: rs(totCredit - totDebit), tone: "blue" },
        { icon: "📅", label: "Collected today", value: rs(todayCredit), tone: "violet" },
      ]} />
      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Salary approvals{pendingSlips.length > 0 ? ` — ${pendingSlips.length} waiting` : ""}</h3>
        {pendingSlips.length === 0 ? <p className="muted" style={{ marginBottom: 0 }}>No salary slips are waiting. When HR prepares a slip, it appears here for payment.</p> : (
          <table>
            <thead><tr><th>Staff</th><th>Month</th><th>Basic</th><th>Allowances</th><th>Deductions</th><th>Net pay</th><th></th></tr></thead>
            <tbody>
              {pendingSlips.map((r) => (
                <tr key={r.id}>
                  <td><b>{staffById.get(r.staff_id)?.full_name ?? "—"}</b></td>
                  <td>{monthLabel(`${r.period_year}-${String(r.period_month ?? "").padStart(2, "0")}`)}</td>
                  <td>{rs(r.basic_salary ?? 0)}</td><td>{rs(r.allowances ?? 0)}</td><td>{rs(r.deductions ?? 0)}</td>
                  <td><b>{rs(r.net_salary ?? 0)}</b></td>
                  <td><button className="btn small" onClick={() => approveSlip(r)}>Approve &amp; pay</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Cash Book — Debit / Credit</h3>
        {ledger.length === 0 ? <p className="muted">No entries yet.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Via / Category</th><th>Debit (Rs)</th><th>Credit (Rs)</th><th>Balance</th></tr></thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.key}>
                    <td>{e.date}</td>
                    <td><b>{e.desc}</b>{e.sub && <div className="muted" style={{ fontSize: 12 }}>{e.sub}</div>}</td>
                    <td>{e.via}</td>
                    <td>{e.debit ? <span style={{ color: "#b91c1c" }}>{rs(e.debit)}</span> : "—"}</td>
                    <td>{e.credit ? <span style={{ color: "#15803d" }}>{rs(e.credit)}</span> : "—"}</td>
                    <td><b>{rs(e.balance)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>Showing the latest {ledger.length} entries. Credit = payments received; Debit = expenses recorded below.</p>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Add expense (Debit)</h3>
        <div className="grid cols-4">
          <div><label>Title *</label><input value={ef.title} onChange={setE("title")} placeholder="e.g. Electricity bill" /></div>
          <div><label>Category</label><select value={ef.category} onChange={setE("category")}><option>Supplies</option><option>Rent</option><option>Utilities</option><option>Salaries</option><option>Maintenance</option><option>Equipment</option><option>Other</option></select></div>
          <div><label>Amount (Rs) *</label><input type="number" value={ef.amount} onChange={setE("amount")} /></div>
          <div><label>Date</label><input type="date" value={ef.expense_date} onChange={setE("expense_date")} /></div>
          <div><label>Paid via</label><select value={ef.payment_method} onChange={setE("payment_method")}><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="card">Card</option></select></div>
          <div><label>Notes</label><input value={ef.notes} onChange={setE("notes")} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={addExpense}>Record expense</button></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Invoices</h3>
        <table>
          <thead><tr><th>Number</th><th>Type</th><th>Total</th><th>Paid</th><th>Status</th><th>Date</th><th>Print</th></tr></thead>
          <tbody>
            {(data?.inv ?? []).map((i) => <tr key={i.id}><td>{i.invoice_number}</td><td>{i.invoice_type}</td><td>{rs(i.total_amount)}</td><td>{rs(i.amount_paid)}</td><td><span className={`pill ${i.status === "paid" ? "green" : "amber"}`}>{i.status}</span></td><td>{String(i.created_at).slice(0, 10)}</td><td><button className="btn small ghost" onClick={() => printReceipt?.({
              title: "Invoice",
              lines: [
                { k: "Number", v: i.invoice_number },
                { k: "Type", v: i.invoice_type },
                { k: "Subtotal", v: rs(i.subtotal) },
                { k: "Total", v: rs(i.total_amount) },
                { k: "Paid", v: rs(i.amount_paid) },
                { k: "Status", v: i.status },
                { k: "Date", v: String(i.created_at).slice(0, 10) },
              ],
            })}>Print</button></td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- HR ---------------- */
export function HR({ profile, session }) {
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const { data, reload } = useLoad(async () => {
    const [staff, priv, att, profiles, branding] = await Promise.all([
      q(supabase.from("staff_directory").select("*").order("full_name")),
      q(supabase.from("staff_private").select("*")),
      q(supabase.from("attendance").select("*").order("attendance_date", { ascending: false }).limit(50)),
      supabase.from("user_profiles").select("id,avatar_url").then((r) => r.data ?? []),
      profile?.tenant_id
        ? supabase.from("settings").select("value").eq("tenant_id", profile.tenant_id).eq("key", "clinic_branding").maybeSingle().then((r) => r.data?.value ?? null)
        : Promise.resolve(null),
    ]);
    return { staff: staff ?? [], priv: priv ?? [], att: att ?? [], profiles: profiles ?? [], branding };
  }, []);
  const privMap = Object.fromEntries((data?.priv ?? []).map((p) => [p.staff_id, p]));
  const avatarByProfile = new Map((data?.profiles ?? []).map((p) => [p.id, p.avatar_url]));
  async function markStaff(staffRow, status, method = "manual") {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("attendance").insert({
        tenant_id: profile.tenant_id, staff_id: staffRow.id, attendance_date: todayStr(),
        check_in_at: status === "present" ? new Date().toISOString() : null, method, status,
      }));
      setMsg({ err: "", ok: `Attendance marked for ${staffRow.full_name} (${status}).` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function adminOps(body) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-user-ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(parsed?.error ?? `admin-user-ops is not responding (${res.status}). ${text.slice(0, 160)}`);
    return parsed;
  }
  /* Hire: one call creates the login account, the profile, the staff
     record and the salary/CNIC row together (create-clinic-user). */
  const [hf, setHf] = useState({ full_name: "", role: "doctor", designation: "", email: "", password: "", phone: "", cnic: "", basic_salary: "", doctor_share_percent: "" });
  const setH = (k) => (e) => setHf({ ...hf, [k]: e.target.value });
  async function hire() {
    setMsg({ err: "", ok: "" });
    try {
      if (!hf.full_name.trim() || !hf.email.trim() || hf.password.length < 8) throw new Error("Full name, email and a password (min 8) are required.");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-clinic-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          email: hf.email.trim(), password: hf.password, full_name: hf.full_name.trim(), role: hf.role, phone: hf.phone || null,
          staff: {
            designation: hf.designation || null,
            cnic: hf.cnic || null,
            basic_salary: hf.basic_salary ? Number(hf.basic_salary) : null,
            doctor_share_percent: hf.doctor_share_percent ? Number(hf.doctor_share_percent) : null,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Function error ${res.status}`);
      setMsg({ err: "", ok: `Hired: ${hf.full_name.trim()} (${hf.role}) — login, staff record and salary saved.` });
      setHf({ full_name: "", role: "doctor", designation: "", email: "", password: "", phone: "", cnic: "", basic_salary: "", doctor_share_percent: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  /* Salary / CNIC / doctor-share editing (staff_private is upserted). */
  const [salId, setSalId] = useState(null);
  const [salF, setSalF] = useState({ cnic: "", basic_salary: "", doctor_share_percent: "" });
  const { printReceipt } = usePrint() ?? {};
  const [slipFor, setSlipFor] = useState(null);
  const [slipF, setSlipF] = useState({ month: "", basic: "", allowances: "0", deductions: "0", status: "paid", paid_at: "" });
  const [slipRows, setSlipRows] = useState([]);
  async function openSlip(st) {
    setMsg({ err: "", ok: "" });
    try {
      const [priv, rows] = await Promise.all([
        q(supabase.from("staff_private").select("*").eq("staff_id", st.id).maybeSingle()),
        q(supabase.from("payroll").select("*").eq("staff_id", st.id).order("period_year", { ascending: false }).order("period_month", { ascending: false })),
      ]);
      const now = new Date();
      setSlipF({ month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`, basic: priv?.basic_salary ?? "", allowances: "0", deductions: "0", status: "paid", paid_at: now.toISOString().slice(0, 10) });
      setSlipRows(rows ?? []);
      setSlipFor(st);
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function saveSlip() {
    if (!slipFor) return;
    setMsg({ err: "", ok: "" });
    try {
      if (!slipF.month) throw new Error("Pick the salary month.");
      const basic = Number(slipF.basic) || 0;
      const allow = Number(slipF.allowances) || 0;
      const ded = Number(slipF.deductions) || 0;
      const [yy, mm] = slipF.month.split("-").map(Number);
      const row = { tenant_id: profile.tenant_id, staff_id: slipFor.id, period_year: yy, period_month: mm, basic_salary: basic, allowances: allow, deductions: ded, late_deduction: 0, absent_deduction: 0, net_salary: basic + allow - ded, status: "draft", paid_at: null };
      const saved = await q(supabase.from("payroll").insert(row).select().single());
      setMsg({ ok: `Salary slip saved for ${slipFor.full_name} — ${monthLabel(slipF.month)} — sent to Finance for payment.`, err: "" });
      notify(profile.tenant_id, { role: "accountant", type: "salary_pending", title: `Salary pending approval — ${slipFor.full_name}`, message: `${monthLabel(slipF.month)} · Net ${rs(row.net_salary)} is waiting in Finance for payment.`, refType: "payroll", refId: saved?.id ?? null });
      setSlipRows((r) => [saved, ...r]);
      printReceipt?.(paySlipDoc(slipFor.full_name, slipFor.role, saved));
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  function openSalary(st) {
    const pv = privMap[st.id] ?? {};
    setSalId(st.id);
    setSalF({ cnic: pv.cnic ?? "", basic_salary: pv.basic_salary ?? "", doctor_share_percent: pv.doctor_share_percent ?? "" });
  }
  async function saveSalary(st) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("staff_private").upsert({
        staff_id: st.id, tenant_id: profile.tenant_id, cnic: salF.cnic || null,
        basic_salary: Number(salF.basic_salary || 0), doctor_share_percent: Number(salF.doctor_share_percent || 0),
      }, { onConflict: "staff_id" }));
      setMsg({ err: "", ok: `Salary saved for ${st.full_name}.` });
      setSalId(null); reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  /* Fire / rehire: deactivate the staff row (they vanish from token and
     doctor lists) and, for Clinic Admins, block the login too. */
  async function toggleStaffActive(st) {
    const next = !st.is_active;
    if (!next && !window.confirm(`Deactivate ${st.full_name}? They will disappear from token/doctor lists${st.user_profile_id ? " and their login will be blocked" : ""}.`)) return;
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("staff").update({ is_active: next }).eq("id", st.id));
      if (st.user_profile_id && profile.role === "clinic_admin") {
        await adminOps({ action: "set_active", user_id: st.user_profile_id, is_active: next });
      }
      setMsg({ err: "", ok: `${st.full_name} has been ${next ? "reactivated" : "deactivated"}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function markMine() {
    const mine = (data?.staff ?? []).find((s) => s.user_profile_id === profile.id);
    if (!mine) { setMsg({ err: "Your staff record was not found — ask HR to add your staff entry first.", ok: "" }); return; }
    markStaff(mine, "present");
  }

  /* ----- QR attendance scanner (BarcodeDetector + camera, where supported).
     Staff QR payload is simply the staff member's id. ----- */
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [badgeFor, setBadgeFor] = useState(null);
  const badgeUrl = useQrUrl(badgeFor?.id ?? "");
  const cameraOk = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  function stopScan() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }
  useEffect(() => stopScan, []);
  async function startScan() {
    setScanNote(""); setMsg({ err: "", ok: "" });
    if (!cameraOk) {
      setScanNote("This browser cannot open a camera here — open the site over HTTPS (or on the phone) and try again, or use the manual attendance buttons below.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    } catch (e) {
      setScanNote(e.name === "NotAllowedError"
        ? "Camera permission was blocked — allow camera access for this site in the browser settings, then try again."
        : `Camera could not be opened (${e.message}) — use manual attendance.`);
      return;
    }
    streamRef.current = stream;
    setScanning(true);
    requestAnimationFrame(async () => {
      const video = videoRef.current;
      if (!video) { stopScan(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      /* Native detector where the browser has one; otherwise decode
         frames with jsQR — so Chrome, Edge, Firefox and Safari all work. */
      let detector = null;
      try { if ("BarcodeDetector" in window) detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch { detector = null; }
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const onRaw = (raw) => {
        const staffRow = (data?.staff ?? []).find((x) => x.id === raw);
        stopScan();
        if (staffRow) markStaff(staffRow, "present", "qr");
        else setMsg({ err: `QR scanned, but this staff ID was not found in this clinic: ${raw}`, ok: "" });
      };
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes && codes.length) { onRaw(String(codes[0].rawValue ?? "").trim()); return; }
          } else if (video.readyState >= 2 && video.videoWidth) {
            const w = Math.min(640, video.videoWidth);
            const h = Math.max(1, Math.round(video.videoHeight * (w / video.videoWidth)));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
            if (found && found.data) { onRaw(String(found.data).trim()); return; }
          }
        } catch { /* frame not ready — keep scanning */ }
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    });
  }
  return (
    <div>
      <h2>HR — Staff & Attendance</h2>
      <Notice err={msg.err} ok={msg.ok} />
      {profile.role === "clinic_admin" ? (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginTop: 0 }}>Hire staff — login, record and salary in one step</h3>
          <div className="grid cols-4">
            <div><label>Full name *</label><input value={hf.full_name} onChange={setH("full_name")} /></div>
            <div><label>Role *</label><select value={hf.role} onChange={setH("role")}>{["doctor", "nurse", "pharmacist", "token_operator", "accountant", "hr_manager", "lab_operator", "display"].map((r) => <option key={r} value={r}>{r}</option>)}<option value="employee">employee (profile only — no system panels)</option></select></div>
            <div><label>Designation / job title</label><input value={hf.designation} onChange={setH("designation")} placeholder="e.g. Sweeper, Ward boy, Guard, Manager" /></div>
            <div><label>Email (login) *</label><input value={hf.email} onChange={setH("email")} /></div>
            <div><label>Password (min 8) *</label><input value={hf.password} onChange={setH("password")} /></div>
            <div><label>Phone</label><input value={hf.phone} onChange={setH("phone")} /></div>
            <div><label>CNIC</label><input value={hf.cnic} onChange={setH("cnic")} /></div>
            <div><label>Basic salary (Rs)</label><input type="number" value={hf.basic_salary} onChange={setH("basic_salary")} /></div>
            <div><label>Doctor share %</label><input type="number" value={hf.doctor_share_percent} onChange={setH("doctor_share_percent")} /></div>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={hire}>Hire staff</button></div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="muted" style={{ margin: 0 }}>New logins are created by the Clinic Admin (here in HR, or in Settings → Create user). Salary and staff status are managed in the directory below.</p>
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row">
          <h3 style={{ margin: 0 }}>QR Attendance</h3>
          <div className="spacer" />
          {!scanning
            ? <button className="btn small" onClick={startScan}>Scan QR — start camera</button>
            : <button className="btn small danger" onClick={stopScan}>Stop scanner</button>}
        </div>
        {scanning && <video ref={videoRef} muted playsInline style={{ width: "100%", maxWidth: 380, borderRadius: 10, marginTop: 10, background: "#000" }} />}
        {scanning && <p className="muted" style={{ marginBottom: 0 }}>Hold the staff QR code in front of the camera — attendance is marked automatically on scan.</p>}
        {scanNote && <p className="muted" style={{ marginBottom: 0 }}>{scanNote}</p>}
        {!scanNote && <p className="muted" style={{ marginBottom: 0 }}>Works in any modern browser with a camera. Staff QR codes: the QR button in the directory below, or each staff member's own My Profile page — print the badge or scan it straight off their phone screen.</p>}
      </div>
      {badgeFor && (
        <div className="modal-back" onClick={() => setBadgeFor(null)}>
          <div className="modal-card" style={{ width: 360, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Attendance QR</h3>
            <p className="muted" style={{ marginTop: 0 }}>{badgeFor.full_name} · {String(badgeFor.role ?? "").replaceAll("_", " ")}</p>
            {avatarByProfile.get(badgeFor.user_profile_id) ? <img src={avatarByProfile.get(badgeFor.user_profile_id)} alt="" style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover" }} /> : null}
            {badgeUrl ? <img src={badgeUrl} alt="Attendance QR" style={{ width: 240, height: 240 }} /> : <p className="muted">Preparing QR…</p>}
            <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
              <button className="btn" onClick={() => badgeUrl && printQrBadge(badgeFor.full_name, badgeFor.designation || badgeFor.role, badgeUrl, { clinic: data?.branding?.name, photo: avatarByProfile.get(badgeFor.user_profile_id) })}>Print ID card</button>
              <button className="btn ghost" onClick={() => setBadgeFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row"><h3 style={{ margin: 0 }}>Staff directory</h3><div className="spacer" /><button className="btn small" onClick={markMine}>Mark my attendance</button></div>
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Designation</th><th>Phone</th><th>Salary (restricted)</th><th>Attendance (today)</th><th>Actions</th></tr></thead>
          <tbody>
            {(data?.staff ?? []).flatMap((st) => {
              const row = (
                <tr key={st.id} style={st.is_active ? undefined : { opacity: 0.55 }}>
                  <td><b>{st.full_name}</b>{!st.is_active && <span className="pill red" style={{ marginLeft: 6 }}>inactive</span>}</td>
                  <td>{st.role}</td><td>{st.designation ?? ""}</td><td>{st.phone ?? ""}</td>
                  <td>{privMap[st.id] ? rs(privMap[st.id].basic_salary) : <span className="muted">— not visible for your role</span>}</td>
                  <td><div className="row">
                    <button className="btn small" disabled={!st.is_active} onClick={() => markStaff(st, "present")}>Present</button>
                    <button className="btn small ghost" disabled={!st.is_active} onClick={() => markStaff(st, "absent")}>Absent</button>
                  </div></td>
                  <td><div className="row">
                    <button className="btn small ghost" onClick={() => setBadgeFor(st)}>QR</button>
                    {(profile.role === "clinic_admin" || profile.role === "hr_manager") && <button className="btn small ghost" onClick={() => openSalary(st)}>Salary</button>}
                    {(profile.role === "clinic_admin" || profile.role === "hr_manager") && <button className="btn small ghost" onClick={() => openSlip(st)}>Slip</button>}
                    <button className="btn small danger" onClick={() => toggleStaffActive(st)}>{st.is_active ? "Deactivate" : "Reactivate"}</button>
                  </div></td>
                </tr>
              );
              if (salId !== st.id) return [row];
              return [row, (
                <tr key={st.id + "-sal"}>
                  <td colSpan={7}>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div><label>CNIC</label><input value={salF.cnic} onChange={(e) => setSalF({ ...salF, cnic: e.target.value })} /></div>
                      <div><label>Basic salary (Rs)</label><input type="number" value={salF.basic_salary} onChange={(e) => setSalF({ ...salF, basic_salary: e.target.value })} /></div>
                      <div><label>Doctor share %</label><input type="number" value={salF.doctor_share_percent} onChange={(e) => setSalF({ ...salF, doctor_share_percent: e.target.value })} /></div>
                      <button className="btn small" onClick={() => saveSalary(st)}>Save salary</button>
                      <button className="btn small ghost" onClick={() => setSalId(null)}>Cancel</button>
                    </div>
                  </td>
                </tr>
              )];
            })}
          </tbody>
        </table>
        <p className="muted">Salary/CNIC is visible only to HR, Accountant and Clinic Admin (database rule).</p>
      </div>
      {slipFor && (
        <div className="modal-back" onClick={() => setSlipFor(null)}>
          <div className="modal-card" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Salary slip — {slipFor.full_name}</h3>
            <div className="grid cols-3">
              <div><label>Month</label><input type="month" value={slipF.month} onChange={(e) => setSlipF({ ...slipF, month: e.target.value })} /></div>
              <div><label>Basic salary (Rs)</label><input type="number" value={slipF.basic} onChange={(e) => setSlipF({ ...slipF, basic: e.target.value })} /></div>
              <div><label>Allowances (Rs)</label><input type="number" value={slipF.allowances} onChange={(e) => setSlipF({ ...slipF, allowances: e.target.value })} /></div>
              <div><label>Deductions (Rs)</label><input type="number" value={slipF.deductions} onChange={(e) => setSlipF({ ...slipF, deductions: e.target.value })} /></div>
              <div style={{ gridColumn: "1 / -1" }}><p className="muted" style={{ margin: 0 }}>HR only prepares the slip — it is saved as <b>Pending approval</b> and sent to Finance. Finance marks the salary paid; HR and the employee are then notified automatically.</p></div>}
            </div>
            <p style={{ margin: "10px 0 0" }}>Net pay: <b>{rs((Number(slipF.basic) || 0) + (Number(slipF.allowances) || 0) - (Number(slipF.deductions) || 0))}</b></p>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={saveSlip}>Save slip — send to Finance</button>
              <button className="btn ghost" onClick={() => setSlipFor(null)}>Close</button>
            </div>
            {slipRows.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <h4 style={{ margin: "0 0 6px" }}>Previous slips</h4>
                <table>
                  <thead><tr><th>Month</th><th>Net</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {slipRows.map((r) => (
                      <tr key={r.id}><td>{monthLabel(`${r.period_year}-${String(r.period_month).padStart(2, "0")}`)}</td><td>{rs(r.net_salary || ((r.basic_salary ?? 0) + (r.allowances ?? 0) - (r.deductions ?? 0) - (r.late_deduction ?? 0) - (r.absent_deduction ?? 0)))}</td><td><span className={`pill ${r.status === "paid" ? "green" : "amber"}`}>{payrollStatusLabel(r.status)}</span></td><td><button className="btn small ghost" onClick={() => printReceipt?.(paySlipDoc(slipFor.full_name, slipFor.role, r))}>Print</button></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="card"><h3>Recent attendance</h3><GenericTable rows={(data?.att ?? []).map((a) => ({ date: a.attendance_date, status: a.status, method: a.method, check_in: a.check_in_at ? String(a.check_in_at).slice(11, 16) : "" }))} /></div>
    </div>
  );
}

/* ---------------- Lab ---------------- */
export function Lab({ profile }) {
  const { printReceipt } = usePrint() ?? {};
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [resultFor, setResultFor] = useState(null);
  const [rf, setRf] = useState({ value: "", abnormal: false });
  const [busy, setBusy] = useState(false);
  const canAct = ["lab_operator", "clinic_admin"].includes(profile?.role);
  const { data, err, reload } = useLoad(async () => {
    const [orders, lp, patients, results] = await Promise.all([
      q(supabase.from("lab_orders").select("*").order("created_at", { ascending: false }).limit(100)),
      profile?.tenant_id
        ? q(supabase.from("settings").select("value").eq("tenant_id", profile.tenant_id).eq("key", "lab_prices").maybeSingle())
        : Promise.resolve(null),
      q(supabase.from("patients").select("id,full_name,mr_number")),
      q(supabase.from("lab_results").select("*").order("created_at", { ascending: false }).limit(300)),
    ]);
    return { orders: orders ?? [], labPrices: lp?.value ?? null, patients: patients ?? [], results: results ?? [] };
  }, []);
  const rows = data?.orders ?? [];
  const patById = new Map((data?.patients ?? []).map((x) => [x.id, x]));
  const resultByOrder = new Map();
  (data?.results ?? []).forEach((r) => { if (!resultByOrder.has(r.lab_order_id)) resultByOrder.set(r.lab_order_id, r); });
  /* The lab workflow: a doctor's order arrives as pending; the lab
     enters the result here, which completes the order and makes the
     report printable. Verified live: lab_operator can insert
     lab_results and update lab_orders. */
  async function saveResult() {
    if (!resultFor) return;
    setMsg({ err: "", ok: "" });
    try {
      if (!rf.value.trim()) throw new Error("Enter the result value.");
      setBusy(true);
      await q(supabase.from("lab_results").insert({
        tenant_id: profile.tenant_id, lab_order_id: resultFor.id, patient_id: resultFor.patient_id,
        result_value: rf.value.trim(), is_abnormal: rf.abnormal,
        reported_by: profile.id, reported_at: new Date().toISOString(),
      }));
      await q(supabase.from("lab_orders").update({ status: "completed" }).eq("id", resultFor.id));
      setMsg({ err: "", ok: `Result saved for ${resultFor.test_name} — the report is ready to print.` });
      setResultFor(null);
      setRf({ value: "", abnormal: false });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBusy(false);
  }
  const savedPrices = data?.labPrices ?? null;
  /* Effective price list: clinic's saved prices first, built-in list as
     fallback, standard fee (labelled) for anything unlisted. */
  const priceNames = [...new Set([
    ...(savedPrices ? Object.keys(savedPrices) : []),
    ...BUILTIN_LAB_PRICES.map((t) => t.name),
  ])].sort((a, b) => a.localeCompare(b));
  return (
    <div>
      <h2>Lab Orders</h2>
      <Notice err={msg.err || err} ok={msg.ok} />
      <StatCards items={[
        { icon: "🧪", label: "Orders today", value: rows.filter((r) => String(r.created_at ?? "").slice(0, 10) === todayStr()).length },
        { icon: "⏳", label: "Pending", value: rows.filter((r) => r.status === "pending").length, tone: "amber" },
        { icon: "✅", label: "Done / reported", value: rows.filter((r) => r.status !== "pending").length, tone: "blue" },
        { icon: "💰", label: "Lab fees today", value: rs(rows.filter((r) => String(r.created_at ?? "").slice(0, 10) === todayStr()).reduce((a, r) => a + (Number(r.fee_pkr) || 0), 0)), tone: "violet" },
      ]} />
      <div className="card">
        {rows.length === 0 ? <p className="muted">No lab orders yet. Doctors order tests from the consultation panel.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Date</th><th>Patient</th><th>Test</th><th>Fee</th><th>Status</th><th>Result</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((r) => { const pt = patById.get(r.patient_id); const res = resultByOrder.get(r.id); return (
                  <tr key={r.id}>
                    <td>{String(r.created_at ?? "").slice(0, 10)}</td>
                    <td><b>{pt?.full_name ?? "—"}</b> <span className="muted">{pt?.mr_number ?? ""}</span></td>
                    <td>{r.test_name}</td>
                    <td>{rs(r.fee_pkr ?? 0)}</td>
                    <td><span className={`pill ${r.status === "completed" ? "green" : "amber"}`}>{r.status}</span></td>
                    <td>{res ? <>{res.result_value} {res.is_abnormal && <span className="pill red">abnormal</span>}</> : <span className="muted">—</span>}</td>
                    <td><div className="row">
                      {r.status !== "completed" && canAct && <button className="btn small" onClick={() => { setResultFor(r); setRf({ value: "", abnormal: false }); }}>Enter result</button>}
                      {r.status === "completed" && res && <button className="btn small ghost" onClick={() => printReceipt?.({
                        paper: "A4", title: "Lab Report",
                        lines: [
                          { k: "Patient", v: pt?.full_name ?? "—" },
                          { k: "MR #", v: pt?.mr_number ?? "—" },
                          { k: "Test", v: r.test_name },
                          { k: "Result", v: res.result_value },
                          ...(res.is_abnormal ? [{ k: "Flag", v: "ABNORMAL" }] : []),
                          { k: "Fee", v: rs(r.fee_pkr ?? 0) },
                          { k: "Reported", v: String(res.reported_at ?? res.created_at ?? "").slice(0, 10) },
                        ],
                      })}>Print report</button>}
                      {r.status !== "completed" && <button className="btn small ghost" onClick={() => printReceipt?.({
                        title: "Lab Order",
                        lines: [
                          { k: "Patient", v: pt?.full_name ?? "—" },
                          { k: "Test", v: r.test_name },
                          { k: "Fee", v: rs(r.fee_pkr ?? 0) },
                          { k: "Date", v: String(r.created_at ?? "").slice(0, 10) },
                        ],
                      })}>Print order</button>}
                    </div></td>
                  </tr> ); })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {resultFor && (
        <div className="modal-back" onClick={() => setResultFor(null)}>
          <div className="modal-card" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Enter result — {resultFor.test_name}</h3>
            <p className="muted" style={{ marginTop: 0 }}>{patById.get(resultFor.patient_id)?.full_name ?? ""}</p>
            <div><label>Result value *</label><textarea rows={3} value={rf.value} onChange={(e) => setRf({ ...rf, value: e.target.value })} placeholder="e.g. Hemoglobin 13.5 g/dL" /></div>
            <label className="row" style={{ gap: 8, marginTop: 10, alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={rf.abnormal} onChange={(e) => setRf({ ...rf, abnormal: e.target.checked })} style={{ width: 18, height: 18 }} /> Mark as abnormal</label>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={saveResult}>{busy ? "Saving…" : "Save result & complete"}</button>
              <button className="btn ghost" onClick={() => setResultFor(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Lab test prices — effective</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The clinic's saved prices (Settings → Fees & Prices) apply first, otherwise the built-in list.
          Tests not on any list are charged the <b>standard fee {rs(STANDARD_LAB_FEE)}</b>, labelled as such.
        </p>
        <table>
          <thead><tr><th>Test</th><th>Price</th><th>Source</th></tr></thead>
          <tbody>
            {priceNames.map((name) => { const info = labPriceInfo(name, savedPrices); return (
              <tr key={name}><td>{name}</td><td>{rs(info.price)}</td>
                <td>{info.source === "clinic" ? <span className="pill green">clinic price</span> : info.source === "builtin" ? <span className="pill blue">built-in</span> : <span className="pill amber">standard fee</span>}</td></tr> ); })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Operations (OT) ----------------
   Operations live in the public.operations table (Phase 2B). RLS does
   the scoping: clinic staff read their own clinic's rows, only
   clinic_admin / doctor / nurse can create or update, and only
   clinic_admin can delete. The fee is recorded on the operation ONLY —
   unlike OPD/lab there is no database trigger for operations, so the
   app must NOT create invoices or payments for them. */
export function Operations({ profile }) {
  const canManageOp = profile.role === "clinic_admin" || profile.role === "doctor";
  const tid = profile.tenant_id;
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const { printReceipt } = usePrint() ?? {};
  /* datetime-local wants a LOCAL "YYYY-MM-DDTHH:mm" string. */
  const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const emptyForm = () => ({
    patient_id: "", token_id: "", procedure_name: "", department_id: "",
    surgeon_id: "", ot_room: "", scheduled_at: nowLocal(), fee_pkr: "", notes: "",
  });
  const [form, setForm] = useState(emptyForm);
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const { data, reload } = useLoad(async () => {
    const [ops, patients, depts, doctors, todayTokens] = await Promise.all([
      q(supabase.from("operations").select("*").order("scheduled_at", { ascending: false }).limit(200)),
      q(supabase.from("patients").select("id,full_name,mr_number").eq("is_active", true).order("full_name")),
      q(supabase.from("departments").select("id,name").eq("is_active", true).order("name")),
      q(supabase.from("user_profiles").select("id,full_name").eq("role", "doctor").eq("is_active", true)),
      q(supabase.from("tokens").select("id,patient_id,token_number").eq("token_date", todayStr()).order("token_number")),
    ]);
    return { ops: ops ?? [], patients: patients ?? [], depts: depts ?? [], doctors: doctors ?? [], todayTokens: todayTokens ?? [] };
  }, [tid]);
  const pName = (id) => data?.patients.find((p) => p.id === id)?.full_name ?? "—";
  const dName = (id) => data?.depts.find((d) => d.id === id)?.name ?? "—";
  const docName = (id) => data?.doctors.find((d) => d.id === id)?.full_name ?? "—";
  const fmtWhen = (iso) => new Date(iso).toLocaleString("en-PK", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const pill = (s) => s === "scheduled" ? "amber" : s === "in_progress" ? "blue" : s === "completed" ? "green" : "red";
  /* Ordering choice: aaj ke aur aane wale operations pehle (waqt ke
     hisaab se barhte hue), phir purane operations (ulte hisaab se). */
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const allOps = data?.ops ?? [];
  const upcoming = allOps.filter((o) => new Date(o.scheduled_at) >= todayStart)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const past = allOps.filter((o) => new Date(o.scheduled_at) < todayStart);
  const rows = [...upcoming, ...past];
  const patientTokens = form.patient_id
    ? (data?.todayTokens ?? []).filter((t) => t.patient_id === form.patient_id)
    : [];
  async function schedule() {
    setMsg({ err: "", ok: "" });
    try {
      if (!form.patient_id) throw new Error("Select a patient.");
      if (!form.procedure_name.trim()) throw new Error("Procedure name is required.");
      if (!form.scheduled_at) throw new Error("Select the operation date and time.");
      const op = await q(supabase.from("operations").insert({
        tenant_id: tid,
        patient_id: form.patient_id,
        token_id: form.token_id || null,
        procedure_name: form.procedure_name.trim(),
        department_id: form.department_id || null,
        surgeon_id: form.surgeon_id || null,
        ot_room: form.ot_room.trim() || null,
        scheduled_at: new Date(form.scheduled_at).toISOString(),
        fee_pkr: form.fee_pkr === "" ? 0 : Number(form.fee_pkr) || 0,
        notes: form.notes.trim() || null,
        created_by: profile.id,
      }).select().single());
      setMsg({ err: "", ok: `Operation scheduled — ${op.procedure_name} (${pName(op.patient_id)}), ${fmtWhen(op.scheduled_at)}.` });
      setForm(emptyForm());
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function setStatus(op, status) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("operations").update({ status, updated_at: new Date().toISOString() }).eq("id", op.id));
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function remove(op) {
    if (!window.confirm(`Delete the operation record "${op.procedure_name}" (${pName(op.patient_id)})?`)) return;
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("operations").delete().eq("id", op.id));
      setMsg({ err: "", ok: "Operation record deleted." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  return (
    <div>
      <h2>Operations (OT)</h2>
      <Notice err={msg.err} ok={msg.ok} />
      <StatCards items={[
        { icon: "🏥", label: "Operations today", value: rows.filter((o) => String(o.scheduled_at ?? "").slice(0, 10) === todayStr()).length },
        { icon: "🗓️", label: "Scheduled", value: rows.filter((o) => o.status === "scheduled").length, tone: "amber" },
        { icon: "🔄", label: "In progress", value: rows.filter((o) => o.status === "in_progress").length, tone: "blue" },
        { icon: "✅", label: "Completed", value: rows.filter((o) => o.status === "completed").length, tone: "violet" },
      ]} />
      {canManageOp && (
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Schedule operation</h3>
        <div className="grid cols-3">
          <div><label>Patient *</label>
            <select value={form.patient_id} onChange={(e) => setForm({ ...form, patient_id: e.target.value, token_id: "" })}>
              <option value="">— choose —</option>
              {data?.patients.map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.mr_number})</option>)}
            </select></div>
          <div><label>Token — aaj ka (optional)</label>
            <select value={form.token_id} onChange={setF("token_id")} disabled={!form.patient_id}>
              <option value="">— none —</option>
              {patientTokens.map((t) => <option key={t.id} value={t.id}>Token #{t.token_number}</option>)}
            </select>
            {form.patient_id && patientTokens.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>This patient has no token today — the operation can still be scheduled without one.</div>}</div>
          <div><label>Procedure name *</label><input value={form.procedure_name} onChange={setF("procedure_name")} placeholder="e.g. Appendectomy" /></div>
          <div><label>Department (optional)</label>
            <select value={form.department_id} onChange={setF("department_id")}>
              <option value="">— none —</option>
              {data?.depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
          <div><label>Surgeon (optional)</label>
            <select value={form.surgeon_id} onChange={setF("surgeon_id")}>
              <option value="">— none —</option>
              {data?.doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
            </select></div>
          <div><label>OT room (optional)</label><input value={form.ot_room} onChange={setF("ot_room")} placeholder="e.g. OT-1" /></div>
          <div><label>Scheduled date &amp; time</label><input type="datetime-local" value={form.scheduled_at} onChange={setF("scheduled_at")} /></div>
          <div><label>Fee (Rs, optional)</label><input type="number" min="0" value={form.fee_pkr} onChange={setF("fee_pkr")} placeholder="0" /></div>
          <div><label>Notes (optional)</label><input value={form.notes} onChange={setF("notes")} /></div>
        </div>
        <div style={{ marginTop: 12 }}><button className="btn" onClick={schedule}>Schedule Operation</button></div>
        <p className="muted" style={{ marginBottom: 0 }}>
          The operation fee is invoiced automatically when the operation is marked Completed.
        </p>
      </div>
      )}
      <div className="card">
        <h3>Operations list</h3>
        {rows.length === 0 ? <p className="muted">No operations scheduled yet.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Date &amp; Time</th><th>Patient</th><th>Procedure</th><th>Department</th><th>Surgeon</th><th>OT Room</th><th>Fee</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>{fmtWhen(o.scheduled_at)}</td>
                    <td><b>{pName(o.patient_id)}</b></td>
                    <td>{o.procedure_name}</td>
                    <td>{o.department_id ? dName(o.department_id) : "—"}</td>
                    <td>{o.surgeon_id ? docName(o.surgeon_id) : "—"}</td>
                    <td>{o.ot_room ?? "—"}</td>
                    <td>{rs(o.fee_pkr)}</td>
                    <td><span className={`pill ${pill(o.status)}`}>{o.status.replace("_", " ")}</span></td>
                    <td><div className="row">
                      {canManageOp && o.status === "scheduled" && <button className="btn small" onClick={() => setStatus(o, "in_progress")}>Start</button>}
                      {canManageOp && o.status === "in_progress" && <button className="btn small" onClick={() => setStatus(o, "completed")}>Complete</button>}
                      {canManageOp && (o.status === "scheduled" || o.status === "in_progress") && <button className="btn small ghost" onClick={() => setStatus(o, "cancelled")}>Cancel</button>}
                      <button className="btn small ghost" onClick={() => printReceipt?.({
                        title: "Operation Slip",
                        lines: [
                          { k: "Patient", v: pName(o.patient_id) },
                          { k: "Procedure", v: o.procedure_name },
                          { k: "Department", v: o.department_id ? dName(o.department_id) : "—" },
                          { k: "Surgeon", v: o.surgeon_id ? docName(o.surgeon_id) : "—" },
                          { k: "OT Room", v: o.ot_room ?? "—" },
                          { k: "Scheduled", v: fmtWhen(o.scheduled_at) },
                          { k: "Fee", v: rs(o.fee_pkr) },
                          { k: "Status", v: o.status.replace("_", " ") },
                        ],
                      })}>Print</button>
                      {profile.role === "clinic_admin" && <button className="btn small danger" onClick={() => remove(o)}>Delete</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Reports ---------------- */
export function Reports() {
  const { data } = useLoad(async () => {
    const [inv, tokToday, tokTotal] = await Promise.all([
      q(supabase.from("invoices").select("invoice_type,total_amount,status,created_at")),
      supabase.from("tokens").select("id", { count: "exact", head: true }).eq("token_date", todayStr()).then((r) => r.count ?? 0),
      supabase.from("tokens").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0),
    ]);
    return { inv: inv ?? [], todayCount: tokToday, totalTokens: tokTotal };
  }, []);
  const paid = (data?.inv ?? []).filter((i) => i.status === "paid");
  const byType = {};
  paid.forEach((i) => { byType[i.invoice_type] = (byType[i.invoice_type] ?? 0) + Number(i.total_amount || 0); });
  return (
    <div>
      <h2>Reports</h2>
      <div className="grid cols-3">
        <div className="card"><div className="muted">Total revenue (paid)</div><div className="big">{rs(paid.reduce((s, i) => s + Number(i.total_amount || 0), 0))}</div></div>
        <div className="card"><div className="muted">Tokens today</div><div className="big">{data?.todayCount ?? "—"}</div></div>
        <div className="card"><div className="muted">Total tokens (all time)</div><div className="big">{data?.totalTokens ?? "—"}</div></div>
        {Object.entries(byType).map(([k, v]) => <div className="card" key={k}><div className="muted">Revenue — {k}</div><div className="big">{rs(v)}</div></div>)}
      </div>
    </div>
  );
}

/* ---------------- Settings / Users ---------------- */
export function Settings({ profile, session }) {
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [f, setF] = useState({ email: "", password: "", full_name: "", role: "nurse", phone: "" });
  const { data, reload } = useLoad(async () => {
    const tid = profile.tenant_id;
    const [users, tenant, tenantsAll, branding, footer, lastSync, feeSetup, labPrices, hospitalTypes, departments, specialtyCatalog, doctorAssignments, enabledModules, supportGrants] = await Promise.all([
      q(supabase.from("user_profiles").select("*").order("full_name")),
      tid ? q(supabase.from("tenants").select("*").eq("id", tid).maybeSingle()) : Promise.resolve(null),
      q(supabase.from("tenants").select("id,name").order("name")),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "clinic_branding").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "saas_footer").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "sheets_last_sync").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "fee_setup").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "lab_prices").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "hospital_types").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("departments").select("id,name,code,is_active").eq("tenant_id", tid).order("name")) : Promise.resolve([]),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "specialty_catalog").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "doctor_assignments").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "enabled_modules").maybeSingle()) : Promise.resolve(null),
      tid ? q(supabase.from("support_access_grants").select("*").eq("tenant_id", tid).order("created_at", { ascending: false })) : Promise.resolve([]),
    ]);
    return {
      users: users ?? [], tenant, tenantsAll: tenantsAll ?? [], branding: branding?.value ?? null,
      footer: footer?.value ?? null, lastSync: lastSync?.value ?? null,
      feeSetup: feeSetup?.value ?? null, labPrices: labPrices?.value ?? null,
      hospitalTypes: hospitalTypes?.value ?? null, departments: departments ?? [],
      specialtyCatalog: specialtyCatalog?.value ?? null, doctorAssignments: doctorAssignments?.value ?? null,
      enabledModules: enabledModules?.value ?? null,
      supportGrants: supportGrants ?? [],
      doctors: (users ?? []).filter((u) => u.role === "doctor"),
    };
  }, []);
  async function createUser() {
    setMsg({ err: "", ok: "" });
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-clinic-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        /* Staff-type roles also get their linked staff record in the same
           call: a login account alone is not enough — tokens, attendance
           and payroll work off the staff row (tokens.doctor_id is a staff
           FK), and the function creates it when `staff` is sent. */
        body: JSON.stringify({
          ...f,
          staff: ["doctor", "nurse", "pharmacist", "token_operator", "accountant", "hr_manager", "lab_operator", "employee"].includes(f.role) ? {} : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Function error ${res.status}`);
      setMsg({ err: "", ok: `User created: ${body.email} (${body.role})` });
      setF({ email: "", password: "", full_name: "", role: "nurse", phone: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const canCreate = ["clinic_admin", "super_admin"].includes(profile.role);
  const isSuper = profile.role === "super_admin";

  /* ----- Clinic branding (settings key 'clinic_branding') ----- */
  const [bf, setBf] = useState(null);
  useEffect(() => {
    if (!data || bf !== null) return;
    const cb = data.branding ?? {};
    setBf({
      name: data.tenant?.name ?? "", city: data.tenant?.city ?? "",
      logo: cb.logo ?? "", tagline: cb.tagline ?? "", address: cb.address ?? "",
      phone: cb.phone ?? "", email: cb.email ?? "", website: cb.website ?? "",
      end_note: cb.end_note ?? "", paper: ["80mm", "58mm", "A4"].includes(cb.paper) ? cb.paper : "80mm",
      show_footer: cb.show_footer !== false,
    });
  }, [data, bf]);
  const setB = (k) => (e) => setBf((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  function onLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 200;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      setBf((p) => ({ ...p, logo: c.toDataURL("image/png") }));
    };
    img.onerror = () => { URL.revokeObjectURL(url); setMsg({ err: "The logo file could not be read.", ok: "" }); };
    img.src = url;
  }
  async function saveBranding() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || !bf) throw new Error("Clinic profile not found.");
      if (bf.name.trim() && (bf.name !== data.tenant?.name || bf.city !== data.tenant?.city)) {
        await q(supabase.from("tenants").update({ name: bf.name.trim(), city: bf.city || null }).eq("id", profile.tenant_id));
      }
      const { name, city, ...rest } = bf;
      await q(supabase.from("settings").upsert(
        { tenant_id: profile.tenant_id, key: "clinic_branding", value: rest },
        { onConflict: "tenant_id,key" }
      ));
      setMsg({ err: "", ok: "Clinic branding saved — receipts will now use this logo and details." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- SaaS footer (settings key 'saas_footer', super admin, all tenants) ----- */
  const [ff, setFf] = useState(null);
  useEffect(() => {
    if (!data || ff !== null) return;
    const sf = data.footer ?? {};
    setFf({ name: sf.name ?? "", tagline: sf.tagline ?? "", phone: sf.phone ?? "", email: sf.email ?? "", website: sf.website ?? "" });
  }, [data, ff]);
  const setFt = (k) => (e) => setFf((p) => ({ ...p, [k]: e.target.value }));
  async function saveFooter() {
    setMsg({ err: "", ok: "" });
    try {
      const tenants = data?.tenantsAll ?? [];
      if (!tenants.length) throw new Error("The clinic list was not found.");
      for (const t of tenants) {
        await q(supabase.from("settings").upsert(
          { tenant_id: t.id, key: "saas_footer", value: ff },
          { onConflict: "tenant_id,key" }
        ));
      }
      setMsg({ err: "", ok: `SaaS footer saved for ${tenants.length} clinics.` });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Fees & lab prices (settings keys 'fee_setup' + 'lab_prices').
     Admin-only control (this whole Settings screen is clinic_admin /
     super_admin). The Token screen reads fee_setup live, and lab fees
     resolve through labPriceInfo() (clinic prices -> built-in -> standard). */
  const [fs, setFs] = useState(null);
  useEffect(() => {
    if (!data || fs !== null) return;
    setFs({ opd_fee: data.feeSetup?.opd_fee ?? 800, follow_up_fee: data.feeSetup?.follow_up_fee ?? 400 });
  }, [data, fs]);
  const setFsF = (k) => (e) => setFs((p) => ({ ...p, [k]: e.target.value }));
  async function saveFees() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || !fs) throw new Error("Clinic profile not found.");
      const value = { ...(data.feeSetup ?? {}), opd_fee: Number(fs.opd_fee) || 0, follow_up_fee: Number(fs.follow_up_fee) || 0 };
      await q(supabase.from("settings").upsert(
        { tenant_id: profile.tenant_id, key: "fee_setup", value },
        { onConflict: "tenant_id,key" }
      ));
      setMsg({ err: "", ok: "Fees saved — the new OPD fee now applies on the Token screen." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const [lpRows, setLpRows] = useState(null);
  const [lpNew, setLpNew] = useState({ name: "", price: "" });
  useEffect(() => {
    if (!data || lpRows !== null) return;
    if (data.labPrices && Object.keys(data.labPrices).length) {
      setLpRows(Object.entries(data.labPrices)
        .map(([name, price]) => ({ name, price: Number(price) || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      // First open: seed the editor from the built-in list.
      setLpRows(BUILTIN_LAB_PRICES.map((t) => ({ ...t })));
    }
  }, [data, lpRows]);
  function addLpRow() {
    const name = lpNew.name.trim();
    const price = Number(lpNew.price);
    if (!name) { setMsg({ err: "Enter the test name.", ok: "" }); return; }
    if (lpNew.price === "" || Number.isNaN(price) || price < 0) { setMsg({ err: "Enter a valid price (0 or more).", ok: "" }); return; }
    if ((lpRows ?? []).some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) {
      setMsg({ err: `${name}" is already in the list — edit its price instead.`, ok: "" }); return;
    }
    setLpRows((p) => [...p, { name, price }]);
    setLpNew({ name: "", price: "" });
  }
  async function saveLabPrices() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || !lpRows) throw new Error("Clinic profile not found.");
      const map = {};
      for (const r of lpRows) {
        const name = r.name.trim();
        if (name) map[name] = Number(r.price) || 0;
      }
      await q(supabase.from("settings").upsert(
        { tenant_id: profile.tenant_id, key: "lab_prices", value: map },
        { onConflict: "tenant_id,key" }
      ));
      setMsg({ err: "", ok: `Lab prices saved — clinic price list ready with ${Object.keys(map).length} tests.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Modules on/off (Phase 3, settings key 'enabled_modules').
     Per-tenant toggles for the OPTIONAL modules only (OPTIONAL_MODULES:
     Lab, Nursing, HR, Operations). Core modules are never gated.
     Default rule: a module is ON unless explicitly saved as false, so a
     clinic that never opens this card keeps every screen. App.jsx reads
     the same key to hide disabled modules from that clinic's nav. */
  const [em, setEm] = useState(null);
  useEffect(() => {
    if (!data || em !== null) return;
    const saved = data.enabledModules ?? {};
    const next = {};
    for (const m of OPTIONAL_MODULES) next[m.key] = saved[m.key] !== false;
    setEm(next);
  }, [data, em]);
  const toggleEm = (k) => setEm((p) => ({ ...p, [k]: !p[k] }));
  async function saveEnabledModules() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || !em) throw new Error("Clinic profile not found.");
      const value = {};
      for (const m of OPTIONAL_MODULES) value[m.key] = em[m.key] !== false;
      await q(supabase.from("settings").upsert(
        { tenant_id: profile.tenant_id, key: "enabled_modules", value },
        { onConflict: "tenant_id,key" }
      ));
      setMsg({ err: "", ok: "Modules saved — disabled modules will be hidden from this clinic's staff menus." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Hospital types & departments (Phase 1).
     Types are saved to settings key 'hospital_types' ({ primary, types }).
     "Apply templates" inserts the chosen types' template departments into
     the existing departments table, skipping names the tenant already has
     (idempotent). Departments feed the Token/Doctor screens directly. */
  const [ht, setHt] = useState(null);
  const [newDept, setNewDept] = useState("");
  useEffect(() => {
    if (!data || ht !== null) return;
    const saved = data.hospitalTypes;
    setHt({ types: Array.isArray(saved?.types) ? saved.types : [], primary: saved?.primary ?? "" });
  }, [data, ht]);
  function toggleType(t) {
    setHt((p) => {
      const types = p.types.includes(t) ? p.types.filter((x) => x !== t) : [...p.types, t];
      const primary = types.includes(p.primary) ? p.primary : (types[0] ?? "");
      return { types, primary };
    });
  }
  async function saveHospitalTypes() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || !ht) throw new Error("Clinic profile not found.");
      await q(supabase.from("settings").upsert(
        { tenant_id: profile.tenant_id, key: "hospital_types", value: { primary: ht.primary || ht.types[0] || null, types: ht.types } },
        { onConflict: "tenant_id,key" }
      ));
      setMsg({ err: "", ok: "Hospital types save ho gaye." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  /* Departments carry a short code (seed data uses OPD, PED, ...). Generate
     one from the name, unique against the codes this tenant already has. */
  function deptCodeFor(name, taken) {
    const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    let base = words.length >= 2 ? words.slice(0, 3).map((w) => w[0]).join("") : (words[0] ?? "DEPT").slice(0, 4);
    base = (base || "DEPT").toUpperCase();
    let code = base, n = 2;
    while (taken.has(code)) { code = base + n; n++; }
    taken.add(code);
    return code;
  }
  async function applyTemplates() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || !ht?.types.length) throw new Error("Select at least one hospital type (and save) first.");
      const wanted = departmentsForTypes(ht.types);
      const existing = data.departments ?? [];
      const existingNames = new Set(existing.map((d) => d.name.trim().toLowerCase()));
      const takenCodes = new Set(existing.map((d) => (d.code ?? "").toUpperCase()).filter(Boolean));
      let added = 0, failed = 0;
      for (const name of wanted) {
        if (existingNames.has(name.trim().toLowerCase())) continue;
        try {
          await q(supabase.from("departments").insert({
            tenant_id: profile.tenant_id, name, code: deptCodeFor(name, takenCodes), is_active: true,
          }));
          existingNames.add(name.trim().toLowerCase());
          added++;
        } catch { failed++; }
      }
      const skipped = wanted.length - added - failed;
      setMsg({
        err: failed ? `${failed} department(s) could not be added (database error) — the rest were added.` : "",
        ok: failed ? "" : `Templates applied — ${added} new department(s) added, ${skipped} already existed (skipped).`,
      });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function addDepartment() {
    setMsg({ err: "", ok: "" });
    try {
      const name = newDept.trim();
      if (!name) throw new Error("Enter the department name.");
      if ((data.departments ?? []).some((d) => d.name.trim().toLowerCase() === name.toLowerCase())) {
        throw new Error(`${name}" already exists in departments.`);
      }
      const takenCodes = new Set((data.departments ?? []).map((d) => (d.code ?? "").toUpperCase()).filter(Boolean));
      await q(supabase.from("departments").insert({
        tenant_id: profile.tenant_id, name, code: deptCodeFor(name, takenCodes), is_active: true,
      }));
      setMsg({ err: "", ok: `Department "${name}" added — it is now available on the Token screen.` });
      setNewDept("");
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function renameDepartment(d) {
    const name = window.prompt(`Enter the new name for the department:`, d.name);
    if (!name || !name.trim() || name.trim() === d.name) return;
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("departments").update({ name: name.trim() }).eq("id", d.id));
      setMsg({ err: "", ok: "Department renamed." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function toggleDepartment(d) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("departments").update({ is_active: !d.is_active }).eq("id", d.id));
      setMsg({ err: "", ok: `${d.name}" has been ${d.is_active ? "deactivated" : "reactivated"}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Specialties & Services (Phase 2A).
     The clinic's own catalog lives in settings key 'specialty_catalog',
     keyed by DEPARTMENT ID:
       { "<deptId>": { "specialties": [ { "name": "...", "services": [] } ] } }
     catalog.js SPECIALTY_TEMPLATES only seed suggestions (specialty names,
     no services) for departments that have none yet. The Token screen
     reads this same key to offer a specialty for the chosen department. */
  const [sc, setSc] = useState(null);
  const [scDept, setScDept] = useState("");
  const [scSpec, setScSpec] = useState("");
  const [scNewSpec, setScNewSpec] = useState("");
  const [scNewSvc, setScNewSvc] = useState("");
  useEffect(() => {
    if (!data || sc !== null) return;
    setSc(data.specialtyCatalog && typeof data.specialtyCatalog === "object" ? data.specialtyCatalog : {});
  }, [data, sc]);
  useEffect(() => {
    if (!scDept && (data?.departments ?? []).length) setScDept(data.departments[0].id);
  }, [data, scDept]);
  const scSpecs = scDept && sc ? (sc[scDept]?.specialties ?? []) : [];
  const scSel = scSpecs.find((s) => s.name === scSpec) ?? null;
  function scSetSpecs(deptId, specs) {
    setSc((p) => ({ ...(p ?? {}), [deptId]: { specialties: specs } }));
  }
  function addSpecialty() {
    const name = scNewSpec.trim();
    if (!scDept) { setMsg({ err: "Select a department first.", ok: "" }); return; }
    if (!name) { setMsg({ err: "Enter the specialty name.", ok: "" }); return; }
    if (scSpecs.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) {
      setMsg({ err: `"${name}" already exists in this department.`, ok: "" }); return;
    }
    scSetSpecs(scDept, [...scSpecs, { name, services: [] }]);
    setScNewSpec("");
    setScSpec(name);
  }
  function renameSpecialty(spec) {
    const name = window.prompt("Enter the new name for the specialty:", spec.name);
    if (!name || !name.trim() || name.trim() === spec.name) return;
    const nn = name.trim();
    if (scSpecs.some((s) => s !== spec && s.name.trim().toLowerCase() === nn.toLowerCase())) {
      setMsg({ err: `"${nn}" already exists in this department.`, ok: "" }); return;
    }
    scSetSpecs(scDept, scSpecs.map((s) => s === spec ? { ...s, name: nn } : s));
    if (scSpec === spec.name) setScSpec(nn);
  }
  function removeSpecialty(spec) {
    if (!window.confirm(`Delete specialty "${spec.name}" and all its services?`)) return;
    scSetSpecs(scDept, scSpecs.filter((s) => s !== spec));
    if (scSpec === spec.name) setScSpec("");
  }
  function addService() {
    const name = scNewSvc.trim();
    if (!scSel) { setMsg({ err: "Select a specialty first.", ok: "" }); return; }
    if (!name) { setMsg({ err: "Enter the service name.", ok: "" }); return; }
    if ((scSel.services ?? []).some((x) => x.trim().toLowerCase() === name.toLowerCase())) {
      setMsg({ err: `"${name}" already exists in this specialty.`, ok: "" }); return;
    }
    scSetSpecs(scDept, scSpecs.map((s) => s === scSel ? { ...s, services: [...(s.services ?? []), name] } : s));
    setScNewSvc("");
  }
  function renameService(svc) {
    const name = window.prompt("Enter the new name for the service:", svc);
    if (!name || !name.trim() || name.trim() === svc) return;
    const nn = name.trim();
    if ((scSel.services ?? []).some((x) => x !== svc && x.trim().toLowerCase() === nn.toLowerCase())) {
      setMsg({ err: `"${nn}" already exists in this specialty.`, ok: "" }); return;
    }
    scSetSpecs(scDept, scSpecs.map((s) => s === scSel ? { ...s, services: (s.services ?? []).map((x) => x === svc ? nn : x) } : s));
  }
  function removeService(svc) {
    scSetSpecs(scDept, scSpecs.map((s) => s === scSel ? { ...s, services: (s.services ?? []).filter((x) => x !== svc) } : s));
  }
  async function persistSpecialtyCatalog(value, okText) {
    await q(supabase.from("settings").upsert(
      { tenant_id: profile.tenant_id, key: "specialty_catalog", value },
      { onConflict: "tenant_id,key" }
    ));
    setMsg({ err: "", ok: okText });
    reload();
  }
  async function saveSpecialties() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || sc === null) throw new Error("Clinic profile not found.");
      await persistSpecialtyCatalog(sc, "Specialties & services save ho gaye — Token screen par ab yehi specialties ayengi.");
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  /* Seed template specialty names for departments that exist for this
     tenant and have NO specialties yet — idempotent: departments that
     already have specialties (or have no template) are left untouched. */
  async function loadSpecTemplates() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || sc === null) throw new Error("Clinic profile not found.");
      const next = { ...sc };
      let seeded = 0;
      for (const d of data.departments ?? []) {
        if ((next[d.id]?.specialties ?? []).length) continue;
        const tpl = specialtyTemplateFor(d.name);
        if (!tpl) continue;
        next[d.id] = { specialties: tpl.map((name) => ({ name, services: [] })) };
        seeded++;
      }
      if (!seeded) {
        setMsg({ err: "", ok: "No new departments found — departments with templates already have specialties (or no template exists for them)." });
        return;
      }
      setSc(next);
      await persistSpecialtyCatalog(next, `Template suggestions loaded — specialties prepared for ${seeded} department(s). Add services inside each specialty.`);
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Doctor assignments (Phase 2A).
     Settings key 'doctor_assignments':
       { "<user_profile_id>": { "departments": ["<deptId>"],
                                "specialties": ["<specialty name>"] } }
     The Token screen filters its Doctor dropdown by these department
     assignments (falling back to all doctors when a department has none). */
  const [da, setDa] = useState(null);
  const [daDoc, setDaDoc] = useState("");
  useEffect(() => {
    if (!data || da !== null) return;
    setDa(data.doctorAssignments && typeof data.doctorAssignments === "object" ? data.doctorAssignments : {});
  }, [data, da]);
  const daDocId = daDoc || data?.doctors?.[0]?.id || "";
  const daCur = (da && daDocId) ? (da[daDocId] ?? { departments: [], specialties: [] }) : { departments: [], specialties: [] };
  const allSpecNames = [...new Set(Object.values(sc ?? {}).flatMap((v) => (v?.specialties ?? []).map((s) => s.name)))].sort((a, b) => a.localeCompare(b));
  function daToggle(field, value) {
    if (!daDocId) return;
    setDa((p) => {
      const cur = p[daDocId] ?? { departments: [], specialties: [] };
      const list = cur[field] ?? [];
      const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
      return { ...p, [daDocId]: { ...cur, [field]: next } };
    });
  }
  async function saveAssignments() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id || da === null) throw new Error("Clinic profile not found.");
      await q(supabase.from("settings").upsert(
        { tenant_id: profile.tenant_id, key: "doctor_assignments", value: da },
        { onConflict: "tenant_id,key" }
      ));
      setMsg({ err: "", ok: "Doctor assignments save ho gaye — Token screen par department ke hisaab se doctors filter honge." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- User tools ----- */
  async function resetEmail(u) {
    setMsg({ err: "", ok: "" });
    const { error } = await supabase.auth.resetPasswordForEmail(u.email);
    if (error) setMsg({ err: error.message, ok: "" });
    else setMsg({ err: "", ok: `Password reset email sent to ${u.email}.` });
  }
  async function toggleActive(u) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("user_profiles").update({ is_active: !u.is_active }).eq("id", u.id));
      setMsg({ err: "", ok: `${u.full_name} has been ${u.is_active ? "deactivated" : "reactivated"}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function adminOps(body) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-user-ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      throw new Error(parsed?.error ?? `admin-user-ops is not responding (${res.status}) — if the function is not deployed yet, deploy it first. ${text.slice(0, 160)}`);
    }
    return parsed;
  }
  /* NOTE (privacy lockdown): there is deliberately NO "set password"
     tool anymore. Nobody — including the Super Admin — sets another
     user's password; users receive a reset email and choose their own
     (Super Admin sends it from the Platform → Users screen via the
     admin-user-ops "send_reset" action, which is audit-logged). */
  async function deleteUser(u) {
    if (!window.confirm(`Permanently delete ${u.full_name} (${u.email})? This cannot be undone.`)) return;
    setMsg({ err: "", ok: "" });
    try {
      await adminOps({ action: "delete_user", user_id: u.id });
      setMsg({ err: "", ok: `${u.email} has been deleted.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Support Access (privacy lockdown) -----
     Clinic admin only, own clinic: grant the platform Super Admin
     temporary, time-boxed access to THIS clinic's data for support
     (table support_access_grants). The database guard
     (support_access_active) opens only while a grant is live, so the
     Super Admin sees this clinic's data only inside the window —
     expiry closes it automatically, and Revoke closes it at once.
     Max duration is 7 days (also enforced by a database check). */
  const [sgDur, setSgDur] = useState(6 * 3600);
  const [sgReason, setSgReason] = useState("");
  const grantStatus = (g) => (g.revoked_at ? "Revoked" : new Date(g.expires_at) <= new Date() ? "Expired" : "Active");
  async function grantSupport() {
    setMsg({ err: "", ok: "" });
    try {
      if (!profile.tenant_id) throw new Error("Clinic profile not found.");
      const expires = new Date(Date.now() + Number(sgDur) * 1000);
      await q(supabase.from("support_access_grants").insert({
        tenant_id: profile.tenant_id, granted_by: profile.id,
        reason: sgReason.trim() || null, expires_at: expires.toISOString(),
      }));
      setSgReason("");
      setMsg({ err: "", ok: `Support access granted — open until ${expires.toLocaleString()}, then it closes automatically.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function revokeSupport(g) {
    if (!window.confirm("Revoke this support grant now? The Super Admin's access to this clinic will end immediately.")) return;
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("support_access_grants").update({ revoked_at: new Date().toISOString() }).eq("id", g.id));
      setMsg({ err: "", ok: "Support access revoked — the Super Admin can no longer see this clinic's data." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  /* ----- Clinic backup export (ZIP, one CSV per table, own tenant only) ----- */
  const [backupBusy, setBackupBusy] = useState(false);
  async function downloadBackup() {
    if (!profile.tenant_id) return;
    setBackupBusy(true); setMsg({ err: "", ok: "" });
    try {
      const tables = ["patients", "tokens", "invoices", "payments", "expenses", "medicines", "medicine_batches", "lab_orders", "staff", "attendance"];
      const files = []; const errors = [];
      for (const t of tables) {
        try {
          const rows = [];
          for (let from = 0; ; from += 1000) {
            const { data: page, error } = await supabase.from(t).select("*")
              .eq("tenant_id", profile.tenant_id).range(from, from + 999);
            if (error) throw new Error(error.message);
            rows.push(...(page ?? []));
            if (!page || page.length < 1000) break;
          }
          files.push({ name: `${t}.csv`, content: toCsv(rows) });
        } catch (e) { errors.push(`${t}: ${e.message}`); }
      }
      if (errors.length) files.push({ name: "_errors.txt", content: "These tables could not be exported:\n" + errors.join("\n") });
      const slug = (data?.tenant?.name ?? "clinic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clinic";
      downloadBlob(makeZip(files), `medicore-backup-${slug}-${todayStr()}.zip`);
      if (errors.length) setMsg({ err: `Backup downloaded, but ${errors.length} table(s) failed: ${errors.join(" · ")}`, ok: "" });
      else setMsg({ err: "", ok: `Backup ZIP downloaded — CSVs for ${files.length} tables included.` });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBackupBusy(false);
  }

  /* ----- Sync to Google Sheets (deployed sheets-sync Edge Function) ----- */
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncInfo, setSyncInfo] = useState(undefined);
  useEffect(() => {
    if (syncInfo === undefined && data) setSyncInfo(data.lastSync ?? null);
  }, [data, syncInfo]);
  async function syncToSheets() {
    setSyncBusy(true); setMsg({ err: "", ok: "" });
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/sheets-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok) throw new Error(body?.error ?? `sheets-sync is not responding (${res.status}). ${text.slice(0, 160)}`);
      let inserted = 0, updated = 0;
      (function scan(o) {
        if (!o || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o)) {
          if (k === "inserted") inserted += Number(v) || 0;
          else if (k === "updated") updated += Number(v) || 0;
          else scan(v);
        }
      })(body);
      const summary = { at: new Date().toISOString(), by: profile.email, inserted, updated };
      if (profile.tenant_id) {
        await q(supabase.from("settings").upsert(
          { tenant_id: profile.tenant_id, key: "sheets_last_sync", value: summary },
          { onConflict: "tenant_id,key" }
        ));
        setSyncInfo(summary);
      }
      setMsg({ err: "", ok: `Sheets sync completed — ${inserted} new rows added, ${updated} rows updated.` });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setSyncBusy(false);
  }
  return (
    <div>
      <h2>Settings</h2>
      <Notice err={msg.err} ok={msg.ok} />
      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="card"><h3>My profile</h3>
          <div>{profile.full_name}</div><div className="muted">{profile.email} · {profile.role}</div></div>
        <div className="card"><h3>Clinic</h3>
          {data?.tenant ? <><div><b>{data.tenant.name}</b></div><div className="muted">{data.tenant.city} · {data.tenant.phone}</div></>
            : <div className="muted">Platform account (all clinics)</div>}</div>
      </div>
      {profile.tenant_id && bf && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Clinic branding — shown on receipts</h3>
          <div className="grid cols-3">
            <div><label>Clinic name</label><input value={bf.name} onChange={setB("name")} /></div>
            <div><label>City</label><input value={bf.city} onChange={setB("city")} /></div>
            <div><label>Tagline</label><input value={bf.tagline} onChange={setB("tagline")} /></div>
            <div><label>Address (receipt)</label><input value={bf.address} onChange={setB("address")} /></div>
            <div><label>Phone (receipt)</label><input value={bf.phone} onChange={setB("phone")} /></div>
            <div><label>Email (receipt)</label><input value={bf.email} onChange={setB("email")} /></div>
            <div><label>Website</label><input value={bf.website} onChange={setB("website")} /></div>
            <div><label>Receipt paper size</label>
              <select value={bf.paper} onChange={setB("paper")}>
                <option value="80mm">Thermal 80mm</option>
                <option value="58mm">Thermal 58mm</option>
                <option value="A4">A4</option>
              </select></div>
            <div><label>Receipt end note</label><input value={bf.end_note} onChange={setB("end_note")} placeholder="e.g. Thank you! Get well soon." /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <div>
              <label>Logo — upload an image file (auto-resized)</label>
              <input type="file" accept="image/*" onChange={onLogoFile} />
            </div>
            <div style={{ flex: 1 }}>
              <label>…or paste a logo URL</label>
              <input value={bf.logo?.startsWith("data:") ? "" : (bf.logo ?? "")} placeholder="https://…/logo.png" onChange={setB("logo")} />
            </div>
            {bf.logo && <img src={bf.logo} alt="logo" style={{ height: 48, objectFit: "contain", background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: 4 }} />}
            {bf.logo && <button className="btn small ghost" onClick={() => setBf((p) => ({ ...p, logo: "" }))}>Logo hatayein</button>}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: 14, color: "var(--ink)" }}>
            <input type="checkbox" checked={bf.show_footer} onChange={setB("show_footer")} style={{ width: "auto" }} />
            Receipt ke end par SaaS footer dikhayein
          </label>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={saveBranding}>Save branding</button></div>
        </div>
      )}
      {isSuper && ff && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Platform (SaaS) footer — printed at the end of every clinic's receipts</h3>
          <div className="grid cols-3">
            <div><label>Platform name</label><input value={ff.name} onChange={setFt("name")} placeholder="MediCore" /></div>
            <div><label>Tagline</label><input value={ff.tagline} onChange={setFt("tagline")} /></div>
            <div><label>Phone</label><input value={ff.phone} onChange={setFt("phone")} /></div>
            <div><label>Email</label><input value={ff.email} onChange={setFt("email")} /></div>
            <div><label>Website</label><input value={ff.website} onChange={setFt("website")} /></div>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={saveFooter}>Save footer (all clinics)</button>
            <span className="muted" style={{ marginLeft: 10 }}>Empty fields are not printed on the receipt.</span></div>
        </div>
      )}
      {canCreate && profile.tenant_id && fs && lpRows && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Fees & Prices — admin control</h3>
          <div className="grid cols-3">
            <div><label>OPD fee (Rs)</label><input type="number" min="0" value={fs.opd_fee} onChange={setFsF("opd_fee")} /></div>
            <div><label>Follow-up fee (Rs)</label><input type="number" min="0" value={fs.follow_up_fee} onChange={setFsF("follow_up_fee")} /></div>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={saveFees}>Save fees</button>
            <span className="muted" style={{ marginLeft: 10 }}>The OPD fee is reflected on the Token screen immediately. Only Clinic Admin / Super Admin can change fees.</span></div>
          <h4 style={{ margin: "18px 0 6px" }}>Lab test prices</h4>
          <p className="muted" style={{ marginTop: 0 }}>
            {data?.labPrices
              ? "This clinic's saved price list is active — edit prices here."
              : "No saved list yet — the built-in list below is in use. Saving makes it this clinic's own list."}
            {" "}Tests not on this list are charged the standard fee {rs(STANDARD_LAB_FEE)} (labelled on the Lab screen).
          </p>
          <table>
            <thead><tr><th>Test</th><th>Price (Rs)</th><th></th></tr></thead>
            <tbody>
              {lpRows.map((r, i) => (
                <tr key={i}><td>{r.name}</td>
                  <td><input type="number" min="0" value={r.price} style={{ maxWidth: 140 }}
                    onChange={(e) => setLpRows((p) => p.map((x, xi) => xi === i ? { ...x, price: e.target.value } : x))} /></td>
                  <td><button className="btn small danger" onClick={() => setLpRows((p) => p.filter((_, xi) => xi !== i))}>Remove</button></td></tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="Naya test, e.g. Ultrasound Pelvis" value={lpNew.name} style={{ flex: 2 }}
              onChange={(e) => setLpNew({ ...lpNew, name: e.target.value })} />
            <input type="number" min="0" placeholder="Price (Rs)" value={lpNew.price} style={{ flex: 1 }}
              onChange={(e) => setLpNew({ ...lpNew, price: e.target.value })} />
            <button className="btn small" onClick={addLpRow}>Add test</button>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={saveLabPrices}>Save lab prices</button></div>
        </div>
      )}
      {canCreate && profile.tenant_id && em && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Modules on/off — this clinic only</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Turn off modules this clinic does not use — they are hidden from the menu of all staff of <b>this clinic</b> only (other clinics are unaffected). Core modules — Dashboard,
            Tokens, Patients, Doctor, Pharmacy, Finance, Reports, TV Board — always stay on.
            A module never saved here remains <b>ON by default</b>.
          </p>
          <div className="grid cols-2">
            {OPTIONAL_MODULES.map((m) => (
              <label key={m.key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--ink)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={em[m.key] !== false} onChange={() => toggleEm(m.key)} />
                {m.label} — {em[m.key] !== false ? "ON" : "OFF"}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={saveEnabledModules}>Save modules</button></div>
        </div>
      )}
      {canCreate && profile.tenant_id && ht && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Hospital type & departments</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Select your facility types — more than one is allowed — and mark one as <b>Primary</b>.
            <b>Apply templates</b> then adds the departments of these types to your departments;
            departments that already exist are skipped (no duplicates).
          </p>
          <div className="grid cols-2">
            {HOSPITAL_TYPES.map((t) => (
              <label key={t} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--ink)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={ht.types.includes(t)} onChange={() => toggleType(t)} />
                <span style={{ flex: 1 }}>{t}</span>
                <input type="radio" name="ht-primary" style={{ width: "auto" }} disabled={!ht.types.includes(t)}
                  checked={ht.primary === t} onChange={() => setHt((p) => ({ ...p, primary: t }))} />
                <span className="muted">Primary</span>
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={saveHospitalTypes}>Save hospital types</button>
            <button className="btn ghost" onClick={applyTemplates}>Apply templates — add departments</button>
          </div>
          <h4 style={{ margin: "18px 0 6px" }}>Departments (is clinic ke)</h4>
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {(data?.departments ?? []).map((d) => (
                <tr key={d.id}><td><b>{d.name}</b></td><td>{d.code ?? ""}</td>
                  <td>{d.is_active ? <span className="pill green">active</span> : <span className="pill red">inactive</span>}</td>
                  <td><div className="row">
                    <button className="btn small ghost" onClick={() => renameDepartment(d)}>Rename</button>
                    <button className="btn small ghost" onClick={() => toggleDepartment(d)}>{d.is_active ? "Deactivate" : "Reactivate"}</button>
                  </div></td></tr>
              ))}
              {(data?.departments ?? []).length === 0 && <tr><td colSpan={4} className="muted">No departments yet — apply templates or add below.</td></tr>}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="Naya custom department, e.g. Dialysis Unit" value={newDept} style={{ flex: 1 }}
              onChange={(e) => setNewDept(e.target.value)} />
            <button className="btn small" onClick={addDepartment}>Add department</button>
          </div>
          <p className="muted">These departments appear in the Token screen department dropdown — a new department is available there immediately. Deactivated departments are hidden from the dropdown.</p>
          {sc !== null && (
            <>
              <h4 style={{ margin: "18px 0 6px" }}>Specialties & Services</h4>
              <p className="muted" style={{ marginTop: 0 }}>
                Manage specialties inside each department, and clinical services inside each specialty.
                This is the clinic's own list (settings key <code>specialty_catalog</code>).
                <b>Load template suggestions</b> fills well-known specialties only for departments that have none — existing lists are never modified. Press <b>Save</b> after making changes.
              </p>
              <div className="row">
                <div style={{ flex: 1 }}><label>Department</label>
                  <select value={scDept} onChange={(e) => { setScDept(e.target.value); setScSpec(""); }}>
                    {(data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select></div>
                <button className="btn ghost" onClick={loadSpecTemplates}>Load template suggestions</button>
              </div>
              <div className="grid cols-2" style={{ marginTop: 12 }}>
                <div>
                  <label>Specialties — {data?.departments?.find((d) => d.id === scDept)?.name ?? ""}</label>
                  {scSpecs.map((s) => (
                    <div className="row" key={s.name} style={{ marginTop: 6, ...(scSpec === s.name ? { background: "#ecfdf5", borderRadius: 8, padding: "4px 6px" } : {}) }}>
                      <button className="btn small ghost" style={{ flex: 1, textAlign: "left" }} onClick={() => setScSpec(s.name)}>
                        {s.name} <span className="muted">({(s.services ?? []).length} services)</span>
                      </button>
                      <button className="btn small ghost" onClick={() => renameSpecialty(s)}>Rename</button>
                      <button className="btn small danger" onClick={() => removeSpecialty(s)}>Remove</button>
                    </div>
                  ))}
                  {scSpecs.length === 0 && <p className="muted">No specialties for this department yet — add below or load template suggestions.</p>}
                  <div className="row" style={{ marginTop: 8 }}>
                    <input placeholder="Nayi specialty, e.g. Glaucoma" value={scNewSpec} style={{ flex: 1 }}
                      onChange={(e) => setScNewSpec(e.target.value)} />
                    <button className="btn small" onClick={addSpecialty}>Add specialty</button>
                  </div>
                </div>
                <div>
                  <label>Clinical services{scSel ? ` — ${scSel.name}` : ""}</label>
                  {scSel ? (
                    <>
                      {(scSel.services ?? []).map((svc) => (
                        <div className="row" key={svc} style={{ marginTop: 6 }}>
                          <span style={{ flex: 1 }}>{svc}</span>
                          <button className="btn small ghost" onClick={() => renameService(svc)}>Rename</button>
                          <button className="btn small danger" onClick={() => removeService(svc)}>Remove</button>
                        </div>
                      ))}
                      {(scSel.services ?? []).length === 0 && <p className="muted">No services for this specialty yet.</p>}
                      <div className="row" style={{ marginTop: 8 }}>
                        <input placeholder="Nayi service, e.g. OCT Scan" value={scNewSvc} style={{ flex: 1 }}
                          onChange={(e) => setScNewSvc(e.target.value)} />
                        <button className="btn small" onClick={addService}>Add service</button>
                      </div>
                    </>
                  ) : <p className="muted">Select a specialty on the left to view or edit its services.</p>}
                </div>
              </div>
              <div style={{ marginTop: 12 }}><button className="btn" onClick={saveSpecialties}>Save specialties & services</button></div>
            </>
          )}
          {da !== null && (
            <>
              <h4 style={{ margin: "18px 0 6px" }}>Doctor assignments</h4>
              <p className="muted" style={{ marginTop: 0 }}>
                Assign each doctor to departments and specialties (settings key <code>doctor_assignments</code>).
                On the Token screen, selecting a department lists its assigned doctors — if none are assigned to it, all doctors are shown.
              </p>
              {(data?.doctors ?? []).length === 0
                ? <p className="muted">This clinic has no doctor accounts yet — create a doctor user below first.</p>
                : (
                  <>
                    <div><label>Doctor</label>
                      <select value={daDocId} onChange={(e) => setDaDoc(e.target.value)}>
                        {(data?.doctors ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
                      </select></div>
                    <div className="grid cols-2" style={{ marginTop: 10 }}>
                      <div><label>Departments</label>
                        {(data?.departments ?? []).filter((d) => d.is_active).map((d) => (
                          <label key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--ink)" }}>
                            <input type="checkbox" style={{ width: "auto" }} checked={(daCur.departments ?? []).includes(d.id)} onChange={() => daToggle("departments", d.id)} />
                            <span>{d.name}</span>
                          </label>
                        ))}
                        {(data?.departments ?? []).filter((d) => d.is_active).length === 0 && <p className="muted">No active departments.</p>}
                      </div>
                      <div><label>Specialties</label>
                        {allSpecNames.length ? allSpecNames.map((name) => (
                          <label key={name} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--ink)" }}>
                            <input type="checkbox" style={{ width: "auto" }} checked={(daCur.specialties ?? []).includes(name)} onChange={() => daToggle("specialties", name)} />
                            <span>{name}</span>
                          </label>
                        )) : <p className="muted">No specialties in the catalog yet — create specialties above first.</p>}
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}><button className="btn" onClick={saveAssignments}>Save assignments</button></div>
                  </>
                )}
            </>
          )}
        </div>
      )}
      {canCreate && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Data — Backup & Google Sheets</h3>
          <div className="row">
            {profile.tenant_id
              ? <button className="btn" disabled={backupBusy} onClick={downloadBackup}>{backupBusy ? "Preparing backup…" : "Download backup (ZIP)"}</button>
              : <span className="muted">Backups are created per clinic — download from a clinic's Clinic Admin account.</span>}
            <button className="btn ghost" disabled={syncBusy} onClick={syncToSheets}>{syncBusy ? "Syncing…" : "Sync to Sheets"}</button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            The backup contains only this clinic's data — patients, tokens, invoices, payments, expenses, medicines, batches, lab orders, staff, attendance (one CSV per table).
            <br />
            {syncInfo
              ? <>Last synced: <b>{new Date(syncInfo.at).toLocaleString()}</b> — {syncInfo.inserted ?? 0} inserted, {syncInfo.updated ?? 0} updated{syncInfo.by ? ` · by ${syncInfo.by}` : ""}</>
              : "No Sheets sync record found yet."}
          </p>
        </div>
      )}
      {profile.role === "clinic_admin" && profile.tenant_id && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Support Access — temporary access for the Super Admin</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            By default, the platform Super Admin cannot see this clinic's data (patients, finance, staff).
            If support is needed, grant <b>temporary</b> access here — the Super Admin can view this clinic's data for the chosen duration,
            and access <b>closes automatically</b> at expiry. You can <b>Revoke</b> at any time. Maximum duration: <b>7 days</b>.
          </p>
          <div className="row">
            <div><label>Muddat (duration)</label>
              <select value={sgDur} onChange={(e) => setSgDur(Number(e.target.value))}>
                <option value={3600}>1 hour</option>
                <option value={6 * 3600}>6 hours</option>
                <option value={24 * 3600}>24 hours</option>
                <option value={3 * 24 * 3600}>3 days</option>
                <option value={7 * 24 * 3600}>7 days (max)</option>
              </select></div>
            <div style={{ flex: 1 }}><label>Reason (optional)</label>
              <input value={sgReason} onChange={(e) => setSgReason(e.target.value)} placeholder="e.g. Reports ka masla check karna hai" /></div>
            <button className="btn" onClick={grantSupport}>Grant access</button>
          </div>
          {(data?.supportGrants ?? []).length > 0 ? (
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Granted</th><th>Reason</th><th>Expires</th><th>Status</th><th></th></tr></thead>
              <tbody>{(data?.supportGrants ?? []).map((g) => { const st = grantStatus(g); return (
                <tr key={g.id}>
                  <td>{new Date(g.created_at).toLocaleString()}</td>
                  <td>{g.reason ?? "—"}</td>
                  <td>{new Date(g.expires_at).toLocaleString()}</td>
                  <td><span className={`pill ${st === "Active" ? "green" : st === "Revoked" ? "red" : "amber"}`}>{st}</span></td>
                  <td>{st === "Active" && <button className="btn small danger" onClick={() => revokeSupport(g)}>Revoke</button>}</td>
                </tr> ); })}</tbody>
            </table>
          ) : <p className="muted" style={{ marginBottom: 0 }}>No support grant has been given yet — the Super Admin cannot see this clinic's data.</p>}
        </div>
      )}
      {canCreate && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Create user (via Edge Function)</h3>
          <div className="grid cols-3">
            <div><label>Full name</label><input value={f.full_name} onChange={set("full_name")} /></div>
            <div><label>Email</label><input value={f.email} onChange={set("email")} /></div>
            <div><label>Password (min 8)</label><input type="password" value={f.password} onChange={set("password")} /></div>
            <div><label>Role</label><select value={f.role} onChange={set("role")}>
              {["doctor", "nurse", "pharmacist", "token_operator", "accountant", "hr_manager", "lab_operator", "display", "employee", ...(profile.role === "super_admin" ? ["clinic_admin"] : [])].map((r) => <option key={r} value={r}>{r}</option>)}
            </select></div>
            <div><label>Phone</label><input value={f.phone} onChange={set("phone")} /></div>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={createUser}>Create User</button></div>
        </div>
      )}
      <div className="card">
        <h3>Users</h3>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>{(data?.users ?? []).map((u) => (
            <tr key={u.id}>
              <td><b>{u.full_name}</b></td><td>{u.email}</td><td>{u.role}</td>
              <td>{u.is_active ? <span className="pill green">active</span> : <span className="pill red">inactive</span>}</td>
              <td><div className="row">
                <button className="btn small ghost" onClick={() => resetEmail(u)}>Reset email</button>
                <button className="btn small ghost" disabled={u.id === profile.id} onClick={() => toggleActive(u)}>{u.is_active ? "Deactivate" : "Reactivate"}</button>
                <button className="btn small danger" disabled={u.id === profile.id} onClick={() => deleteUser(u)}>Delete</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted" style={{ marginTop: 8 }}>Delete requires the <b>admin-user-ops</b> Edge Function to be deployed. Passwords are never set here — users receive a reset email and set their own password.</p>
      </div>
    </div>
  );
}

/* ---------------- Platform (Super Admin) ----------------
   PRIVACY LOCKDOWN: the Super Admin is platform-only. These screens
   read tenants / plans / subscriptions, per-clinic COUNTS from the
   platform_usage_stats() function (the database returns rows only
   to a super_admin caller, and never row-level clinic data), the
   user list, and the support_access_grants list (read-only here —
   grants are created/revoked by each clinic's own Clinic Admin in
   Settings → Support Access). No clinical/financial table is read
   from any of these screens. */
function usePlatformLists() {
  return useLoad(async () => {
    const [tenants, subs, plans, users] = await Promise.all([
      q(supabase.from("tenants").select("*").order("name")),
      q(supabase.from("subscriptions").select("*")),
      q(supabase.from("plans").select("*")),
      q(supabase.from("user_profiles").select("id,tenant_id,role")),
    ]);
    return { tenants: tenants ?? [], subs: subs ?? [], plans: plans ?? [], users: users ?? [] };
  }, []);
}
const latestSubFor = (subs, tid) => (subs ?? []).filter((s) => s.tenant_id === tid)
  .sort((a, b) => String(b.ends_on ?? "").localeCompare(String(a.ends_on ?? "")))[0];

export function PlatformDashboard() {
  const { data, err } = useLoad(async () => {
    const nowIso = new Date().toISOString();
    const [stats, grants, grantors] = await Promise.all([
      q(supabase.rpc("platform_usage_stats")),
      q(supabase.from("support_access_grants").select("*")
        .is("revoked_at", null).lte("starts_at", nowIso).gt("expires_at", nowIso)
        .order("expires_at")),
      q(supabase.from("user_profiles").select("id,full_name,email")),
    ]);
    return { stats: stats ?? [], grants: grants ?? [], grantors: grantors ?? [] };
  }, []);
  const grantorName = (id) => data?.grantors.find((u) => u.id === id)?.full_name ?? "Clinic Admin";
  const clinicName = (tid) => data?.stats.find((s) => s.tenant_id === tid)?.clinic_name ?? tid;
  const tot = (k) => (data?.stats ?? []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const maxTok = Math.max(1, ...(data?.stats ?? []).map((s) => Number(s.tokens_last_30_days) || 0));
  const maxInv = Math.max(1, ...(data?.stats ?? []).map((s) => Number(s.invoices_last_30_days) || 0));
  const daysLeft = (iso) => (iso ? Math.ceil((new Date(iso + "T23:59:59") - new Date()) / 86400000) : null);
  return (
    <div>
      <div className="pagehead">
        <h2>Platform Dashboard</h2>
        <p>Privacy lockdown: the Super Admin cannot see clinic data (patients, finance, staff) —
          only per-clinic <b>counts</b> and subscription status are shown here.</p>
      </div>
      <Notice err={err} />
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="ic">🏥</div><div><div className="lb">Clinics</div><div className="vl">{data?.stats.length ?? 0}</div></div></div>
        <div className="stat"><div className="ic blue">✅</div><div><div className="lb">Active subscriptions</div><div className="vl">{(data?.stats ?? []).filter((s) => s.subscription_status === "active").length}</div></div></div>
        <div className="stat"><div className="ic violet">👥</div><div><div className="lb">Total users (all clinics)</div><div className="vl">{tot("users_count")}</div></div></div>
        <div className="stat"><div className="ic amber">🩺</div><div><div className="lb">Total patients (all clinics)</div><div className="vl">{tot("patients_count")}</div></div></div>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Clinics — usage (counts only)</h3>
        <table>
          <thead><tr><th>Clinic</th><th>Subscription</th><th>Ends on</th><th>Users</th><th>Patients</th><th>Tokens (30 din)</th><th>Invoices (30 din)</th></tr></thead>
          <tbody>{(data?.stats ?? []).map((s) => (
            <tr key={s.tenant_id}>
              <td><b>{s.clinic_name}</b></td>
              <td>{s.subscription_status ? <span className={`pill ${s.subscription_status === "active" ? "green" : "red"}`}>{s.subscription_status}</span> : "—"}</td>
              <td>{s.subscription_ends_on ?? "—"}{(() => { const d = daysLeft(s.subscription_ends_on); return d === null ? null : <span className={`pill ${d < 0 ? "red" : d <= 30 ? "amber" : "green"}`} style={{ marginLeft: 8 }}>{d < 0 ? "expired" : `${d} days left`}</span>; })()}</td>
              <td>{s.users_count}</td><td>{s.patients_count}</td>
              <td>{s.tokens_last_30_days}<div className="bar"><i style={{ width: `${Math.round(((Number(s.tokens_last_30_days) || 0) / maxTok) * 100)}%` }} /></div></td>
              <td>{s.invoices_last_30_days}<div className="bar blue"><i style={{ width: `${Math.round(((Number(s.invoices_last_30_days) || 0) / maxInv) * 100)}%` }} /></div></td>
            </tr>
          ))}</tbody>
        </table>
        {(data?.stats ?? []).length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No usage stats returned — platform_usage_stats() returns rows to super_admin only.</p>}
      </div>
      <div className="card">
        <h3>Active support access — clinics with an active grant</h3>
        {(data?.grants ?? []).length === 0
          ? <p className="muted" style={{ marginBottom: 0 }}>No active support grants — no clinic data is visible to the Super Admin.</p>
          : (
            <table>
              <thead><tr><th>Clinic</th><th>Reason</th><th>Granted by</th><th>Expires</th></tr></thead>
              <tbody>{(data?.grants ?? []).map((g) => (
                <tr key={g.id}>
                  <td><b>{clinicName(g.tenant_id)}</b></td>
                  <td>{g.reason ?? "—"}</td>
                  <td>{grantorName(g.granted_by)}</td>
                  <td>{new Date(g.expires_at).toLocaleString()}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
          Only a clinic's own Clinic Admin can grant access (Settings → Support Access) — the Super Admin cannot create grants,
          and access closes automatically at expiry.
        </p>
      </div>
    </div>
  );
}

export function PlatformTenants({ session }) {
  const { data, err, reload } = usePlatformLists();
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [busy, setBusy] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
  const [delText, setDelText] = useState("");
  const [f, setF] = useState({ name: "", city: "", phone: "", email: "", address: "", plan_id: "", htype: "" });
  const planName = (id) => data?.plans.find((p) => p.id === id)?.name ?? "";
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const planForCreate = data?.plans.find((p) => p.id === f.plan_id) ?? data?.plans?.[0] ?? null;
  async function createClinic() {
    setMsg({ err: "", ok: "" });
    try {
      const name = f.name.trim();
      if (!name) throw new Error("Enter the clinic / hospital name.");
      if (!planForCreate) throw new Error("No plan exists — create a plan on the Plans screen first.");
      setBusy(true);
      const slug = (name + "-" + (f.city.trim() || "clinic")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const created = await q(supabase.from("tenants").insert({
        name, slug,
        city: f.city.trim() || null, phone: f.phone.trim() || null,
        email: f.email.trim() || null, address: f.address.trim() || null,
        status: "active",
      }).select("id").single());
      const tenantId = created.id;
      let warn = "";
      const start = new Date(); const end = new Date(start);
      if (planForCreate.billing_cycle === "yearly") end.setFullYear(end.getFullYear() + 1);
      else end.setMonth(end.getMonth() + 1);
      const iso = (d) => d.toISOString().slice(0, 10);
      try {
        await q(supabase.from("subscriptions").insert({
          tenant_id: tenantId, plan_id: planForCreate.id, status: "active",
          starts_on: iso(start), ends_on: iso(end), amount_pkr: planForCreate.price_pkr ?? 0,
        }));
      } catch (e) { warn += ` Subscription could not be created (${e.message}).`; }
      if (f.htype) {
        try {
          await q(supabase.from("settings").upsert(
            { tenant_id: tenantId, key: "hospital_types", value: { primary: f.htype, types: [f.htype] } },
            { onConflict: "tenant_id,key" }));
        } catch (e) { warn += ` Hospital category could not be saved (${e.message}).`; }
      }
      setMsg({ err: "", ok: `${name}" created — ${planForCreate.name} plan, subscription until ${iso(end)}. Next, create this clinic's Clinic Admin from the Users screen; after login they can set departments (templates) and categories in their Settings.${warn}` });
      setF({ name: "", city: "", phone: "", email: "", address: "", plan_id: "", htype: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBusy(false);
  }
  async function deleteClinic() {
    if (!delTarget) return;
    setMsg({ err: "", ok: "" });
    try {
      if (delText.trim() !== delTarget.name) throw new Error("Type the clinic name exactly to confirm.");
      if (!session?.access_token) throw new Error("No session found — sign in again and retry.");
      setBusy(true);
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-tenant-ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: "delete_clinic", tenant_id: delTarget.id, confirm_name: delText.trim() }),
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok) throw new Error(parsed?.error ?? `Delete failed (${res.status}) — if the admin-tenant-ops function is not deployed yet, deploy it first.`);
      setMsg({ err: "", ok: `${delTarget.name}" has been permanently deleted — ${parsed.users_deleted ?? 0} logins and all clinic data removed.` });
      setDelTarget(null); setDelText("");
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBusy(false);
  }
  return (
    <div>
      <div className="pagehead"><h2>Tenants — Clinics</h2><p>All clinics and hospitals registered on the platform.</p></div>
      <Notice err={msg.err || err} ok={msg.ok} />
      {data && (
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="pill blue">Total clinics: {data.tenants.length}</span>
          <span className="pill green">Active: {data.tenants.filter((t) => t.status === "active").length}</span>
          <span className="pill red">Suspended: {data.tenants.filter((t) => t.status !== "active").length}</span>
          <span className="pill">Total users: {data.users.length}</span>
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Add new clinic / hospital</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          A subscription starts automatically for the new clinic, and role permissions are seeded.
          Only the <b>primary</b> hospital category is set here — the clinic's own Clinic Admin manages
          categories and department templates in Settings → Hospital type &amp; departments.
        </p>
        <div className="grid cols-3">
          <div><label>Clinic / hospital name *</label><input value={f.name} onChange={set("name")} placeholder="e.g. Noor Hospital" /></div>
          <div><label>City</label><input value={f.city} onChange={set("city")} /></div>
          <div><label>Phone</label><input value={f.phone} onChange={set("phone")} /></div>
          <div><label>Email</label><input value={f.email} onChange={set("email")} /></div>
          <div><label>Address</label><input value={f.address} onChange={set("address")} /></div>
          <div><label>Plan</label>
            <select value={planForCreate?.id ?? ""} onChange={set("plan_id")}>
              {(data?.plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} — {rs(p.price_pkr)}/{p.billing_cycle === "yearly" ? "year" : "month"}</option>)}
            </select></div>
          <div><label>Hospital category (primary)</label>
            <select value={f.htype} onChange={set("htype")}>
              <option value="">— not now —</option>
              {HOSPITAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
        </div>
        <div style={{ marginTop: 12 }}><button className="btn" disabled={busy} onClick={createClinic}>{busy ? "Creating…" : "Create clinic"}</button></div>
      </div>
      {delTarget && (
        <div className="card" style={{ marginBottom: 14, border: "2px solid #dc2626", background: "#fef2f2" }}>
          <h3 style={{ color: "#b91c1c", marginTop: 0 }}>🗑 Delete clinic — {delTarget.name}</h3>
          <p><b>This cannot be undone.</b> All data of this clinic will be permanently deleted — patients, tokens, invoices, staff, pharmacy stock, audit log and all user logins. If needed, first take a backup from the clinic's Clinic Admin (Settings → Backup).</p>
          <p className="muted">Type the clinic name exactly to confirm: <b>{delTarget.name}</b></p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input style={{ flex: "1 1 260px" }} value={delText} onChange={(e) => setDelText(e.target.value)} placeholder={delTarget.name} />
            <button className="btn danger" disabled={busy || delText.trim() !== delTarget.name} onClick={deleteClinic}>{busy ? "Deleting…" : "Delete permanently"}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setDelTarget(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>Clinic</th><th>City</th><th>Status</th><th>Plan</th><th>Subscription</th><th>Users</th><th></th></tr></thead>
          <tbody>
            {(data?.tenants ?? []).map((t) => { const sub = latestSubFor(data.subs, t.id); return (
              <tr key={t.id}><td><b>{t.name}</b></td><td>{t.city ?? "—"}</td>
                <td><span className={`pill ${t.status === "active" ? "green" : "red"}`}>{t.status}</span></td>
                <td>{sub ? planName(sub.plan_id) : "—"}</td>
                <td>{sub ? sub.status : "—"}</td>
                <td>{data.users.filter((u) => u.tenant_id === t.id).length}</td><td><button className="btn small danger" onClick={() => { setDelTarget(t); setDelText(""); }}>🗑 Delete</button></td></tr> ); })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PLAN_MODULE_KEYS = ["tokens", "patients", "pharmacy", "finance", "hr", "lab"];
export function PlatformPlans() {
  const { data, err, reload } = usePlatformLists();
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(null);
  const modsLabel = (p) => {
    const m = p.features?.modules;
    if (!Array.isArray(m) || m.length === 0) return "—";
    if (m.includes("all")) return p.features?.priority_support ? "All modules + priority support" : "All modules";
    return m.join(", ");
  };
  function startAdd() {
    setMsg({ err: "", ok: "" });
    setF({ id: null, name: "", price_pkr: "", billing_cycle: "monthly", max_users: "", max_patients: "", modules: ["tokens", "patients", "pharmacy"], allModules: false, is_active: true, features: null });
  }
  function startEdit(p) {
    setMsg({ err: "", ok: "" });
    setF({
      id: p.id, name: p.name ?? "", price_pkr: p.price_pkr ?? "", billing_cycle: p.billing_cycle ?? "monthly",
      max_users: p.max_users ?? "", max_patients: p.max_patients ?? "",
      modules: Array.isArray(p.features?.modules) ? p.features.modules.filter((m) => m !== "all") : [],
      allModules: Array.isArray(p.features?.modules) && p.features.modules.includes("all"),
      is_active: p.is_active !== false, features: p.features ?? null,
    });
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  function toggleModule(m) {
    setF((prev) => ({ ...prev, modules: prev.modules.includes(m) ? prev.modules.filter((x) => x !== m) : [...prev.modules, m] }));
  }
  async function savePlan() {
    setMsg({ err: "", ok: "" });
    try {
      if (!f.name.trim()) throw new Error("Enter the plan name.");
      const price = Number(f.price_pkr);
      if (Number.isNaN(price) || price < 0) throw new Error("Enter a valid price (number).");
      setBusy(true);
      const features = { ...(f.features ?? {}), modules: f.allModules ? ["all"] : f.modules };
      const row = {
        name: f.name.trim(), price_pkr: price, billing_cycle: f.billing_cycle,
        max_users: f.max_users === "" ? null : Number(f.max_users),
        max_patients: f.max_patients === "" ? null : Number(f.max_patients),
        features, is_active: !!f.is_active,
      };
      if (f.id) await q(supabase.from("plans").update(row).eq("id", f.id));
      else await q(supabase.from("plans").insert(row));
      setMsg({ err: "", ok: `Plan "${row.name}" saved.` });
      setF(null);
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBusy(false);
  }
  async function toggleActive(p) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("plans").update({ is_active: !(p.is_active !== false) }).eq("id", p.id));
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  return (
    <div>
      <div className="pagehead"><h2>Plans</h2><p>Pricing plans offered to clinics. Add a plan, or edit price and limits.</p></div>
      <Notice err={msg.err || err} ok={msg.ok} />
      {!f && <div style={{ marginBottom: 12 }}><button className="btn" onClick={startAdd}>Add plan</button></div>}
      {f && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>{f.id ? "Edit plan" : "Add plan"}</h3>
          <div className="grid cols-3">
            <div><label>Name *</label><input value={f.name} onChange={set("name")} placeholder="e.g. Pro" /></div>
            <div><label>Price (PKR) *</label><input type="number" value={f.price_pkr} onChange={set("price_pkr")} /></div>
            <div><label>Billing cycle</label>
              <select value={f.billing_cycle} onChange={set("billing_cycle")}>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select></div>
            <div><label>Max users (khaali = unlimited)</label><input type="number" value={f.max_users} onChange={set("max_users")} /></div>
            <div><label>Max patients (khaali = unlimited)</label><input type="number" value={f.max_patients} onChange={set("max_patients")} /></div>
            <div><label>Active</label><input type="checkbox" checked={!!f.is_active} onChange={set("is_active")} /></div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label>Modules</label>
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <label><input type="checkbox" checked={!!f.allModules} onChange={(e) => setF({ ...f, allModules: e.target.checked })} /> All modules</label>
              {PLAN_MODULE_KEYS.map((m) => (
                <label key={m}><input type="checkbox" disabled={!!f.allModules} checked={f.modules.includes(m)} onChange={() => toggleModule(m)} /> {m}</label>
              ))}
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy} onClick={savePlan}>{busy ? "Saving…" : "Save plan"}</button>
            <button className="btn ghost" onClick={() => setF(null)}>Cancel</button>
          </div>
        </div>
      )}
      {(data?.plans ?? []).length === 0
        ? <div className="card"><p className="muted" style={{ marginBottom: 0 }}>No plans found.</p></div>
        : (
          <div className="grid cols-3">
            {(data?.plans ?? []).map((p) => (
              <div key={p.id} className={`plan-card ${p.is_active === false ? "off" : ""}`}>
                <div className="row"><b style={{ fontSize: 17 }}>{p.name}</b><span className="spacer" />
                  {p.is_active !== false ? <span className="pill green">active</span> : <span className="pill red">inactive</span>}</div>
                <div><span className="price">{rs(p.price_pkr)}</span> <span className="per">/ {p.billing_cycle === "yearly" ? "year" : "month"}</span></div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Max users: <b>{p.max_users ?? "Unlimited"}</b> · Max patients: <b>{p.max_patients ?? "Unlimited"}</b>
                </div>
                <div>{(Array.isArray(p.features?.modules) && p.features.modules.length)
                  ? (p.features.modules.includes("all")
                    ? <span className="modchip">All modules{p.features?.priority_support ? " + priority support" : ""}</span>
                    : p.features.modules.map((m) => <span key={m} className="modchip">{m}</span>))
                  : <span className="muted">—</span>}</div>
                <div className="row" style={{ marginTop: "auto" }}>
                  <button className="btn small ghost" onClick={() => startEdit(p)}>Edit</button>
                  <button className="btn small ghost" onClick={() => toggleActive(p)}>{p.is_active !== false ? "Deactivate" : "Activate"}</button>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

export function PlatformSubscriptions() {
  const { data, err } = usePlatformLists();
  const planName = (id) => data?.plans.find((p) => p.id === id)?.name ?? "";
  const clinicName = (id) => data?.tenants.find((t) => t.id === id)?.name ?? id;
  const sorted = (data?.subs ?? []).slice().sort((a, b) => String(b.ends_on ?? "").localeCompare(String(a.ends_on ?? "")));
  return (
    <div>
      <div className="pagehead"><h2>Subscriptions</h2><p>Every clinic's subscription and remaining time — expiring soonest first, so renewals are not missed.</p></div>
      <Notice err={err} />
      <div className="card">
        <table>
          <thead><tr><th>Clinic</th><th>Plan</th><th>Status</th><th>Starts</th><th>Ends</th><th>Remaining</th></tr></thead>
          <tbody>{sorted.map((s) => (
            <tr key={s.id}>
              <td><b>{clinicName(s.tenant_id)}</b></td>
              <td>{planName(s.plan_id)}</td>
              <td><span className={`pill ${s.status === "active" ? "green" : "red"}`}>{s.status}</span></td>
              <td>{s.starts_on ?? "—"}</td>
              <td>{s.ends_on ?? "—"}</td>
              <td>{(() => { if (!s.ends_on) return "—"; const d = Math.ceil((new Date(s.ends_on + "T23:59:59") - new Date()) / 86400000); return <span className={`pill ${d < 0 ? "red" : d <= 30 ? "amber" : "green"}`}>{d < 0 ? `expired ${-d}d ago` : `${d} days left`}</span>; })()}</td>
            </tr>
          ))}</tbody>
        </table>
        {sorted.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No subscription records found.</p>}
      </div>
    </div>
  );
}

export function PlatformUsers({ profile, session }) {
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [f, setF] = useState({ email: "", password: "", full_name: "", phone: "", tenant_id: "" });
  const { data, err, reload } = useLoad(async () => {
    const [users, tenants] = await Promise.all([
      // Privacy rule (owner's instruction): the Super Admin manages ONLY
      // each clinic's Clinic Admin (owner account). Clinic staff (doctor,
      // nurse, ...) are managed by their own Clinic Admin, so they are
      // not even loaded here.
      q(supabase.from("user_profiles").select("*").eq("role", "clinic_admin").order("full_name")),
      q(supabase.from("tenants").select("id,name").order("name")),
    ]);
    return { users: users ?? [], tenants: tenants ?? [] };
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const clinicName = (id) => data?.tenants.find((t) => t.id === id)?.name ?? "Platform";
  const tenantForCreate = f.tenant_id || data?.tenants?.[0]?.id || "";
  async function adminOps(body) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-user-ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      throw new Error(parsed?.error ?? `admin-user-ops is not responding (${res.status}) — if the function is not deployed yet, deploy it first. ${text.slice(0, 160)}`);
    }
    return parsed;
  }
  async function createUser() {
    setMsg({ err: "", ok: "" });
    try {
      if (!tenantForCreate) throw new Error("Select a clinic first.");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-clinic-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ...f, role: "clinic_admin", tenant_id: tenantForCreate }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Function error ${res.status}`);
      setMsg({ err: "", ok: `Clinic Admin ban gaya: ${body.email ?? f.email} (${clinicName(tenantForCreate)})` });
      setF({ email: "", password: "", full_name: "", phone: "", tenant_id: "" });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function sendReset(u) {
    setMsg({ err: "", ok: "" });
    try {
      await adminOps({ action: "send_reset", user_id: u.id });
      setMsg({ err: "", ok: `Password reset email sent to ${u.email} — the user will set their own password.` });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function toggleActive(u) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("user_profiles").update({ is_active: !u.is_active }).eq("id", u.id));
      setMsg({ err: "", ok: `${u.full_name} has been ${u.is_active ? "deactivated" : "reactivated"}.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function deleteUser(u) {
    if (!window.confirm(`Permanently delete ${u.full_name} (${u.email})? This cannot be undone.`)) return;
    setMsg({ err: "", ok: "" });
    try {
      await adminOps({ action: "delete_user", user_id: u.id });
      setMsg({ err: "", ok: `${u.email} has been deleted.` });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  return (
    <div>
      <div className="pagehead"><h2>Users — Clinic Admins</h2><p>The Super Admin manages only each clinic's <b>Clinic Admin</b> (owner account) — create, reset email, deactivate, delete. Clinic staff (doctors, nurses, etc.) are managed by their own Clinic Admin in Settings → Users. Every action is recorded in the audit log.</p></div>
      <Notice err={msg.err || err} ok={msg.ok} />
      {data && (
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="pill blue">Clinic Admins: {data.users.length}</span>
          <span className="pill green">Active: {data.users.filter((u) => u.is_active).length}</span>
          <span className="pill">Clinics: {data.tenants.length}</span>
        </div>
      )}
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Create Clinic Admin (via Edge Function)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The Super Admin can create only a clinic's <b>Clinic Admin</b> — clinic staff accounts (doctor, nurse, etc.) are created by that clinic's own admin.
        </p>
        <div className="grid cols-3">
          <div><label>Full name</label><input value={f.full_name} onChange={set("full_name")} /></div>
          <div><label>Email</label><input value={f.email} onChange={set("email")} /></div>
          <div><label>Password (min 8)</label><input type="password" value={f.password} onChange={set("password")} /></div>
          <div><label>Clinic</label>
            <select value={tenantForCreate} onChange={set("tenant_id")}>
              {(data?.tenants ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
          <div><label>Phone</label><input value={f.phone} onChange={set("phone")} /></div>
        </div>
        <div style={{ marginTop: 12 }}><button className="btn" onClick={createUser}>Create Clinic Admin</button></div>
      </div>
      <div className="card">
        <h3>Clinic Admins — har clinic ka owner account</h3>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Clinic</th><th>Role</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>{(data?.users ?? []).map((u) => (
            <tr key={u.id}>
              <td><b>{u.full_name}</b></td><td>{u.email}</td><td>{u.tenant_id ? clinicName(u.tenant_id) : "Platform"}</td><td>{u.role}</td>
              <td>{u.is_active ? <span className="pill green">active</span> : <span className="pill red">inactive</span>}</td>
              <td><div className="row">
                <button className="btn small ghost" onClick={() => sendReset(u)}>Send reset email</button>
                <button className="btn small ghost" disabled={u.id === profile.id} onClick={() => toggleActive(u)}>{u.is_active ? "Deactivate" : "Reactivate"}</button>
                <button className="btn small danger" disabled={u.id === profile.id} onClick={() => deleteUser(u)}>Delete</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
        {(data?.users ?? []).length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No Clinic Admin yet — create one from the form above.</p>}
        <p className="muted" style={{ marginTop: 8 }}>
          Note: all Super Admin actions — user create, delete and password reset — are recorded in the <b>audit log</b>.
          The Super Admin never sets passwords; users receive a reset email and set their own password.
          Send reset email and Delete require the <b>admin-user-ops</b> Edge Function to be deployed.
        </p>
      </div>
    </div>
  );
}

/* ---------------- Platform: Medicine Catalog (Phase 2) ----------------
   Global reference catalog (med_* tables). This screen renders only
   for super_admin. The catalog is read-only here except one action:
   marking a medicine / variant "verified" after a source check —
   the database restricts catalog writes to a super_admin aal2
   session anyway. Prices, barcodes and DRAP registration numbers
   stay blank until a verified import supplies them; the screen
   shows an honest dash instead of invented values. */
/* ---------------- Medicine Catalog: Import & Data Quality Center ----------------
   CSV/JSON bulk import for the global catalog. Every row is classified
   BEFORE anything is written: new / new variant on an existing medicine /
   duplicate / rejected. Existing rows are NEVER updated — imports only add,
   so verified data can never be overwritten by lower-quality data. Imported
   rows always start as pending_verification. Each import is logged in
   med_import_batches and can be rolled back: rows the batch created are
   deleted (ingredient links cascade with their medicine). */
function parseCsvText(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  const src = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  row.push(cur); rows.push(row);
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
const normNameImp = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const truthyImp = (v) => ["true", "yes", "1", "y"].includes(String(v ?? "").trim().toLowerCase());
const variantKeyImp = (medNorm, brand, strength, form, pack) => [
  medNorm, normNameImp(brand), String(strength ?? "").trim().toLowerCase(),
  String(form ?? "").trim().toLowerCase(), String(pack ?? "").trim().toLowerCase(),
].join("|");
function rowsFromImportText(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error("The JSON file must contain an array of objects.");
    return arr.map((o) => {
      const r = {};
      Object.entries(o ?? {}).forEach(([k, v]) => { r[String(k).trim().toLowerCase()] = v; });
      return r;
    });
  }
  const grid = parseCsvText(trimmed);
  if (grid.length < 2) throw new Error("No data rows found after the CSV header.");
  const head = grid[0].map((h) => String(h).trim().toLowerCase());
  return grid.slice(1).map((cells) => {
    const r = {};
    head.forEach((h, i) => { r[h] = cells[i] ?? ""; });
    return r;
  });
}
function parseIngredientsImp(s) {
  return String(s ?? "").split(";").map((x) => x.trim()).filter(Boolean).map((tok) => {
    const m = tok.match(/^(.*?)\s+([\d]+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu|%)$/i);
    if (m) return { name: m[1].trim(), value: Number(m[2]), unit: m[3].toLowerCase() === "iu" ? "IU" : m[3].toLowerCase() };
    return { name: tok, value: null, unit: null };
  });
}
const IMPORT_HEAD = ["generic_name", "category_slug", "pharm_class", "therapeutic_class", "atc_code", "ingredients", "is_controlled", "source_ref", "brand_name", "manufacturer", "strength_text", "dosage_form", "pack_size", "units_per_pack", "barcode", "registration_no", "rx_status", "retail_price_pkr", "wholesale_price_pkr", "price_as_of"];
const IMPORT_TEMPLATE = (() => {
  const pad = (a) => { const r = [...a]; while (r.length < IMPORT_HEAD.length) r.push(""); return r.join(","); };
  return [
    IMPORT_HEAD.join(","),
    pad(["Paracetamol", "pain-fever-paracetamol-acetaminophen", "Analgesic and antipyretic", "", "", "Paracetamol 500 mg", "false"]),
    pad(["EXAMPLE Generic", "antibiotics-penicillins", "Example class", "", "", "Example Ingredient 250 mg", "false", "Example source — delete this row", "ExampleBrand", "Example Pharma", "250 mg", "Capsule", "10", "10", "", "", "rx"]),
  ].join("\n");
})();

export function CatalogImport({ cats, meds, prods, profile, onDone }) {
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [fileName, setFileName] = useState("");
  const [rawRows, setRawRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);
  const [result, setResult] = useState(null);
  const [confirmBatch, setConfirmBatch] = useState(null);

  const { data: batches, reload: reloadBatches } = useLoad(async () => {
    try {
      return await q(supabase.from("med_import_batches")
        .select("id,file_name,total_rows,inserted_count,duplicate_count,rejected_count,status,created_at")
        .order("created_at", { ascending: false }).limit(10));
    } catch { return []; }
  }, []);

  const medByNorm = new Map(meds.map((m) => [m.normalized_name, m]));
  const medNormById = new Map(meds.map((m) => [m.id, m.normalized_name]));
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  const dbVariantKeys = new Set(prods.map((p) => variantKeyImp(medNormById.get(p.medicine_id) ?? "", p.brand_name, p.strength_text, p.dosage_form, p.pack_size)));
  const dbBarcodeKey = new Map();
  prods.forEach((p) => { if (p.barcode) dbBarcodeKey.set(String(p.barcode).trim(), variantKeyImp(medNormById.get(p.medicine_id) ?? "", p.brand_name, p.strength_text, p.dosage_form, p.pack_size)); });

  const classified = useMemo(() => {
    if (!rawRows) return null;
    const seenVar = new Set();
    const seenMedOnly = new Set();
    return rawRows.map((row, i) => {
      const out = { n: i + 1, row, kind: "rejected", reason: "" };
      const generic = String(row.generic_name ?? "").trim();
      if (!generic) { out.reason = "generic_name is missing"; return out; }
      out.generic = generic;
      out.norm = normNameImp(generic);
      const slug = String(row.category_slug ?? "").trim().toLowerCase();
      out.catId = null;
      if (slug) {
        const c = catBySlug.get(slug);
        if (!c) { out.reason = `category_slug "${slug}" not found in the catalog`; return out; }
        out.catId = c.id;
      }
      const strength = String(row.strength_text ?? "").trim();
      const form = String(row.dosage_form ?? "").trim();
      out.hasVariant = !!(strength || form);
      if (out.hasVariant && !(strength && form)) { out.reason = "strength_text and dosage_form are both required for a variant"; return out; }
      const num = (v) => { const t = String(v ?? "").trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) && n >= 0 ? n : "BAD"; };
      out.retail = num(row.retail_price_pkr);
      out.wholesale = num(row.wholesale_price_pkr);
      if (out.retail === "BAD" || out.wholesale === "BAD") { out.reason = "invalid price (number, 0 or more)"; return out; }
      const upp = String(row.units_per_pack ?? "").trim();
      out.unitsPerPack = upp ? Number(upp) : null;
      if (upp && (!Number.isInteger(out.unitsPerPack) || out.unitsPerPack < 0)) { out.reason = "units_per_pack is invalid"; return out; }
      out.rx = String(row.rx_status ?? "").trim().toLowerCase();
      if (out.rx && !["otc", "rx", "controlled", "hospital"].includes(out.rx)) { out.reason = "rx_status is invalid (otc / rx / controlled / hospital)"; return out; }
      out.priceAsOf = String(row.price_as_of ?? "").trim();
      if (out.priceAsOf && !/^\d{4}-\d{2}-\d{2}$/.test(out.priceAsOf)) { out.reason = "price_as_of must use the YYYY-MM-DD format"; return out; }
      out.barcode = String(row.barcode ?? "").trim() || null;
      out.vKey = out.hasVariant ? variantKeyImp(out.norm, row.brand_name, strength, form, row.pack_size) : null;
      if (out.vKey && seenVar.has(out.vKey)) { out.kind = "duplicate"; out.reason = "same variant already appeared earlier in this file"; return out; }
      if (!out.hasVariant && seenMedOnly.has(out.norm)) { out.kind = "duplicate"; out.reason = "same medicine already appeared earlier in this file"; return out; }
      if (out.vKey) seenVar.add(out.vKey); else seenMedOnly.add(out.norm);
      if (out.barcode && dbBarcodeKey.has(out.barcode)) {
        if (out.vKey && dbBarcodeKey.get(out.barcode) === out.vKey) { out.kind = "duplicate"; out.reason = "barcode + variant already exist"; return out; }
        out.reason = "this barcode is used by another variant"; return out;
      }
      const existing = medByNorm.get(out.norm);
      if (!existing) { out.kind = "new"; return out; }
      if (!out.hasVariant) { out.kind = "duplicate"; out.reason = "medicine already exists in the catalog"; return out; }
      if (dbVariantKeys.has(out.vKey)) { out.kind = "duplicate"; out.reason = "variant already exists in the catalog"; return out; }
      out.kind = "variant";
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, meds, prods, cats]);

  const counts = useMemo(() => {
    const c = { total: 0, newM: 0, variant: 0, duplicate: 0, rejected: 0 };
    (classified ?? []).forEach((r) => {
      c.total++;
      if (r.kind === "new") c.newM++;
      else if (r.kind === "variant") c.variant++;
      else if (r.kind === "duplicate") c.duplicate++;
      else c.rejected++;
    });
    return c;
  }, [classified]);

  async function onFile(e) {
    const f = e.target.files?.[0];
    setMsg({ err: "", ok: "" }); setResult(null); setRawRows(null);
    if (!f) return;
    try {
      const text = await f.text();
      const rows = rowsFromImportText(text);
      if (!rows.length) throw new Error("No data rows found in the file.");
      if (rows.length > 5000) throw new Error("File is too large — import at most 5000 rows at a time.");
      setFileName(f.name);
      setRawRows(rows);
    } catch (err) { setMsg({ err: "Could not read the file: " + err.message, ok: "" }); }
    e.target.value = "";
  }

  function downloadTemplate() {
    const blob = new Blob([IMPORT_TEMPLATE], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "medicore-catalog-import-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function runImport() {
    if (!classified) return;
    const work = classified.filter((r) => r.kind === "new" || r.kind === "variant");
    const totalSteps = new Set(work.filter((r) => r.kind === "new").map((r) => r.norm)).size + work.filter((r) => r.hasVariant).length;
    if (!work.length) return;
    setBusy(true); setMsg({ err: "", ok: "" }); setResult(null);
    const errors = classified.filter((r) => r.kind === "rejected").map((r) => ({ row: r.n, reason: r.reason }));
    let dupCount = counts.duplicate;
    let insMeds = 0, insProds = 0, done = 0;
    try {
      const batch = await q(supabase.from("med_import_batches").insert({
        imported_by: profile?.id ?? null, source_label: "Import Center (app)",
        file_name: fileName || "paste", total_rows: classified.length, status: "completed",
      }).select("id").single());
      const batchId = batch.id;
      const medIdByNorm = new Map(meds.map((m) => [m.normalized_name, m.id]));
      // 1) New medicines (one per normalized name) + their ingredient links.
      const newNorms = [...new Set(work.filter((r) => r.kind === "new").map((r) => r.norm))];
      const ingTokensByNorm = new Map();
      work.filter((r) => r.kind === "new").forEach((r) => {
        const toks = parseIngredientsImp(r.row.ingredients);
        if (toks.length) ingTokensByNorm.set(r.norm, [...(ingTokensByNorm.get(r.norm) ?? []), ...toks]);
      });
      for (const norm of newNorms) {
        const r0 = work.find((r) => r.kind === "new" && r.norm === norm);
        try {
          const med = await q(supabase.from("med_medicines").insert({
            generic_name: r0.generic, normalized_name: norm, category_id: r0.catId,
            pharm_class: String(r0.row.pharm_class ?? "").trim() || null,
            therapeutic_class: String(r0.row.therapeutic_class ?? "").trim() || null,
            atc_code: String(r0.row.atc_code ?? "").trim() || null,
            is_controlled: truthyImp(r0.row.is_controlled),
            source_ref: String(r0.row.source_ref ?? "").trim() || null,
            status: "pending_verification", import_batch_id: batchId,
          }).select("id").single());
          medIdByNorm.set(norm, med.id);
          insMeds++;
        } catch (e) {
          if (String(e.message).includes("23505") || String(e.message).toLowerCase().includes("duplicate")) dupCount++;
          else errors.push({ row: r0.n, reason: "medicine insert: " + e.message });
        }
        done++; setProg({ done, total: totalSteps });
      }
      // Ingredients dictionary + links for the medicines just created.
      const allToks = [...ingTokensByNorm.entries()].flatMap(([norm, toks]) => toks.map((t) => ({ norm, ...t })));
      if (allToks.length) {
        try {
          const uniqIng = [...new Map(allToks.map((t) => [normNameImp(t.name), t.name])).entries()]
            .map(([nn, name]) => ({ name, normalized_name: nn }));
          await q(supabase.from("med_ingredients").upsert(uniqIng, { onConflict: "normalized_name", ignoreDuplicates: true }));
          const ingRows = await q(supabase.from("med_ingredients").select("id,normalized_name").limit(10000));
          const ingIdByNorm = new Map((ingRows ?? []).map((x) => [x.normalized_name, x.id]));
          const linkSeen = new Set();
          const links = [];
          allToks.forEach((t) => {
            const mid = medIdByNorm.get(t.norm);
            const iid = ingIdByNorm.get(normNameImp(t.name));
            if (!mid || !iid) return;
            const k = [mid, iid, t.value ?? "", t.unit ?? ""].join("|");
            if (linkSeen.has(k)) return;
            linkSeen.add(k);
            links.push({ medicine_id: mid, ingredient_id: iid, strength_value: t.value, strength_unit: t.unit });
          });
          if (links.length) {
            try { await q(supabase.from("med_medicine_ingredients").insert(links)); }
            catch { for (const l of links) { try { await q(supabase.from("med_medicine_ingredients").insert(l)); } catch { /* duplicate link — skip */ } } }
          }
        } catch (e) { errors.push({ row: 0, reason: "ingredients: " + e.message }); }
      }
      // 2) Variants (for new medicines and for existing ones alike).
      for (const r of work) {
        if (!r.hasVariant) continue;
        const mid = medIdByNorm.get(r.norm);
        if (!mid) { errors.push({ row: r.n, reason: "medicine could not be created, variant skipped" }); done++; setProg({ done, total: totalSteps }); continue; }
        try {
          await q(supabase.from("med_products").insert({
            medicine_id: mid,
            brand_name: String(r.row.brand_name ?? "").trim() || null,
            manufacturer: String(r.row.manufacturer ?? "").trim() || null,
            strength_text: String(r.row.strength_text ?? "").trim(),
            dosage_form: String(r.row.dosage_form ?? "").trim(),
            pack_size: String(r.row.pack_size ?? "").trim() || null,
            units_per_pack: r.unitsPerPack, barcode: r.barcode,
            registration_no: String(r.row.registration_no ?? "").trim() || null,
            rx_status: r.rx || "rx",
            retail_price_pkr: r.retail, wholesale_price_pkr: r.wholesale,
            price_as_of: r.priceAsOf || null,
            status: "pending_verification", import_batch_id: batchId,
          }));
          insProds++;
        } catch (e) {
          if (String(e.message).includes("23505") || String(e.message).toLowerCase().includes("duplicate")) dupCount++;
          else errors.push({ row: r.n, reason: "variant insert: " + e.message });
        }
        done++; setProg({ done, total: totalSteps });
      }
      const rejectedNow = errors.length;
      await q(supabase.from("med_import_batches").update({
        inserted_count: insMeds + insProds, duplicate_count: dupCount,
        rejected_count: rejectedNow, errors: errors.slice(0, 100),
      }).eq("id", batchId));
      setResult({ insMeds, insProds, dupCount, rejectedNow, batchId });
      setMsg({ err: "", ok: `Import complete — ${insMeds} new medicines and ${insProds} new variants added. All are pending verification; verify only after checking.` });
      setRawRows(null); setFileName("");
      onDone?.(); reloadBatches();
    } catch (e) {
      setMsg({ err: "Import stopped: " + e.message, ok: "" });
    }
    setProg(null); setBusy(false);
  }

  async function rollbackBatch(b) {
    setBusy(true); setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("med_products").delete().eq("import_batch_id", b.id));
      await q(supabase.from("med_medicines").delete().eq("import_batch_id", b.id));
      await q(supabase.from("med_import_batches").update({ status: "rolled_back" }).eq("id", b.id));
      setMsg({ err: "", ok: `${b.file_name ?? "Import"}" has been rolled back — the medicines/variants added by this batch were deleted. Pre-existing data was not affected.` });
      setConfirmBatch(null);
      onDone?.(); reloadBatches();
    } catch (e) { setMsg({ err: "Rollback failed: " + e.message, ok: "" }); }
    setBusy(false);
  }

  const kindPill = (k) => k === "new"
    ? <span className="pill" style={{ background: "#dcfce7", color: "#166534" }}>New medicine</span>
    : k === "variant"
      ? <span className="pill" style={{ background: "#dbeafe", color: "#1e40af" }}>New variant</span>
      : k === "duplicate"
        ? <span className="pill" style={{ background: "#fef3c7", color: "#92400e" }}>Duplicate</span>
        : <span className="pill" style={{ background: "#fee2e2", color: "#991b1b" }}>Rejected</span>;

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>📥 Import &amp; Data Quality Center</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Bulk-add medicines to the catalog from a CSV or JSON file. Import only adds <b>new</b> data —
        existing or verified records are <b>never overwritten</b>. Every import is recorded as a batch
        and can be <b>rolled back</b> in one click.
      </p>
      <Notice err={msg.err} ok={msg.ok} />
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label className="btn" style={{ cursor: "pointer" }}>
          📂 Choose a CSV / JSON file
          <input type="file" accept=".csv,.json,text/csv,application/json" style={{ display: "none" }} onChange={onFile} />
        </label>
        <button className="btn ghost" onClick={downloadTemplate}>⬇ Template download</button>
        {fileName && <span className="muted">{fileName}</span>}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Only <b>generic_name</b> is required. For a variant, provide <b>strength_text + dosage_form</b>.
        Separate ingredients with <b>;</b> and include strengths — e.g. <i>Amoxicillin 500 mg; Clavulanic Acid 125 mg</i>.
        Provide <b>category_slug</b> for the category (e.g. <i>antibiotics-penicillins</i>). Delete the EXAMPLE row from the template first.
      </p>

      {classified && (
        <div style={{ marginTop: 10 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <span className="modchip">Total rows: {counts.total}</span>
            <span className="modchip">New medicines: {counts.newM}</span>
            <span className="modchip">New variants: {counts.variant}</span>
            <span className="modchip">Duplicates: {counts.duplicate}</span>
            <span className="modchip">Rejected: {counts.rejected}</span>
          </div>
          <table>
            <thead><tr><th>#</th><th>Generic</th><th>Variant</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {classified.slice(0, 100).map((r) => (
                <tr key={r.n}>
                  <td>{r.n}</td>
                  <td><b>{r.generic ?? "—"}</b></td>
                  <td>{r.hasVariant ? `${String(r.row.brand_name ?? "").trim() || "Generic"} · ${String(r.row.strength_text ?? "").trim()} ${String(r.row.dosage_form ?? "").trim()}` : <span className="muted">—</span>}</td>
                  <td>{kindPill(r.kind)}</td>
                  <td className="muted">{r.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {classified.length > 100 && <p className="muted">Showing the first 100 rows — the import will run on all {classified.length} rows.</p>}
          <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
            <button className="btn" disabled={busy || counts.newM + counts.variant === 0} onClick={runImport}>
              {busy ? "Importing…" : `Import (${counts.newM + counts.variant} new records)`}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => { setRawRows(null); setFileName(""); }}>Cancel</button>
            {prog && <span className="muted">{prog.done} / {prog.total} rows…</span>}
          </div>
        </div>
      )}
      {result && (
        <p style={{ marginTop: 10 }}>
          ✅ Aakhri import: <b>{result.insMeds}</b> medicines + <b>{result.insProds}</b> variants add hue ·
          Duplicates skip: <b>{result.dupCount}</b> · Rejected: <b>{result.rejectedNow}</b>
        </p>
      )}

      <h4 style={{ marginBottom: 6 }}>Import history (rollback yahin se)</h4>
      <table>
        <thead><tr><th>File</th><th>Date</th><th>Rows</th><th>Inserted</th><th>Dup.</th><th>Rej.</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {(batches ?? []).map((b) => (
            <tr key={b.id}>
              <td>{b.file_name ?? "—"}</td>
              <td>{String(b.created_at ?? "").slice(0, 10)}</td>
              <td>{b.total_rows}</td><td>{b.inserted_count}</td><td>{b.duplicate_count}</td><td>{b.rejected_count}</td>
              <td>{b.status === "rolled_back"
                ? <span className="pill" style={{ background: "#fee2e2", color: "#991b1b" }}>Rolled back</span>
                : <span className="pill" style={{ background: "#dcfce7", color: "#166534" }}>{b.status}</span>}</td>
              <td>{b.status === "completed" && (confirmBatch === b.id
                ? <span className="row" style={{ gap: 6 }}>
                    <button className="btn small danger" disabled={busy} onClick={() => rollbackBatch(b)}>Confirm rollback</button>
                    <button className="btn small ghost" disabled={busy} onClick={() => setConfirmBatch(null)}>Nahi</button>
                  </span>
                : <button className="btn small" disabled={busy} onClick={() => setConfirmBatch(b.id)}>↩ Rollback</button>)}</td>
            </tr>
          ))}
          {(batches ?? []).length === 0 && <tr><td colSpan={8} className="muted">No imports yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}


/* ---------------- Catalog integration helpers (Phases 4-5) ----------------
   Hospital-type smart boost: the clinic's primary hospital type maps to a
   catalog parent category; matching medicines sort FIRST in the pickers.
   The full catalog always stays searchable — nothing is hidden. */
const HOSPITAL_TYPE_CAT_SLUG = {
  "Eye Hospital": "eye-ent", "ENT Hospital": "eye-ent",
  "Cardiac / Heart Hospital": "cardiovascular",
  "Women & Maternity Hospital": "obgyn-fertility",
  "Children / Pediatric Hospital": "pediatrics",
  "Cancer / Oncology Hospital": "oncology-hematology",
  "Kidney & Urology Hospital": "renal-urology",
  "Dermatology / Skin Hospital": "dermatology",
  "Mental Health / Psychiatric Hospital": "neuro-psychiatry",
  "Neurology & Neurosurgery Hospital": "neuro-psychiatry",
  "Chest & Pulmonology Hospital": "respiratory-allergy",
  "Gastroenterology & Liver Hospital": "gastroenterology",
};
function useCatalogIndex() {
  return useLoad(async () => {
    const [cats, meds, prods] = await Promise.all([
      q(supabase.from("med_categories").select("id,parent_id,name,slug").order("sort")),
      q(supabase.from("med_medicines").select("id,generic_name,category_id,is_controlled,status,allergy_alerts").order("generic_name").limit(1000)),
      q(supabase.from("med_products").select("id,medicine_id,brand_name,manufacturer,dosage_form,strength_text,pack_size,barcode,retail_price_pkr,status").limit(2000)),
    ]);
    return { cats: cats ?? [], meds: meds ?? [], prods: prods ?? [] };
  }, []);
}
function useIngredientMatch(term, setIngMatch) {
  useEffect(() => {
    const t = (term ?? "").trim();
    if (t.length < 2) { setIngMatch(null); return; }
    let alive = true;
    (async () => {
      try {
        const ings = await q(supabase.from("med_ingredients").select("id").ilike("name", `%${t}%`).limit(50));
        if (!ings?.length) { if (alive) setIngMatch(new Set()); return; }
        const links = await q(supabase.from("med_medicine_ingredients").select("medicine_id").in("ingredient_id", ings.map((i) => i.id)).limit(500));
        if (alive) setIngMatch(new Set((links ?? []).map((l) => l.medicine_id)));
      } catch { if (alive) setIngMatch(new Set()); }
    })();
    return () => { alive = false; };
  }, [term, setIngMatch]);
}
function catalogSearch(prods, meds, term, ingMatch) {
  const t = (term ?? "").trim().toLowerCase();
  if (!t) return [];
  const medById = new Map(meds.map((m) => [m.id, m]));
  return prods.filter((p) => {
    const m = medById.get(p.medicine_id);
    return (m?.generic_name ?? "").toLowerCase().includes(t)
      || (p.brand_name ?? "").toLowerCase().includes(t)
      || (p.barcode && String(p.barcode) === (term ?? "").trim())
      || (ingMatch?.has(p.medicine_id) ?? false);
  });
}

/* ---------------- Phase 4: add a catalog variant into clinic stock -------- */
export function PharmacyCatalogAdd({ profile, tenantMeds, tenantBatches, onAdded }) {
  const tid = profile.tenant_id;
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [term, setTerm] = useState("");
  const [ingMatch, setIngMatch] = useState(null);
  const [addId, setAddId] = useState(null);
  const [f, setF] = useState({ name: "", sale_price: "", purchase_price: "", reorder_level: 10, batch_no: "", batch_qty: "", expiry_date: "" });
  const [busy, setBusy] = useState(false);
  const { data } = useCatalogIndex();
  useIngredientMatch(term, setIngMatch);
  const cats = data?.cats ?? [];
  const meds = data?.meds ?? [];
  const prods = data?.prods ?? [];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const catPath = (id) => {
    const c = catById.get(id);
    if (!c) return null;
    const p = c.parent_id ? catById.get(c.parent_id) : null;
    return p ? `${p.name} › ${c.name}` : c.name;
  };
  const medById = new Map(meds.map((m) => [m.id, m]));
  /* "In stock" must mean real, sellable quantity: a medicine row with
     no batch (or only empty batches) is NOT in stock. */
  const medByProduct = new Map((tenantMeds ?? []).filter((m) => m.catalog_product_id).map((m) => [m.catalog_product_id, m]));
  const qtyByMed = new Map();
  (tenantBatches ?? []).forEach((b) => qtyByMed.set(b.medicine_id, (qtyByMed.get(b.medicine_id) ?? 0) + (Number(b.quantity) || 0)));
  const stockQty = (p) => { const m = medByProduct.get(p.id); return m ? (qtyByMed.get(m.id) ?? 0) : null; };
  const results = catalogSearch(prods, meds, term, ingMatch).slice(0, 30);
  const selProd = prods.find((p) => p.id === addId) ?? null;
  const selMed = selProd ? medById.get(selProd.medicine_id) : null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function openAdd(p) {
    const m = medById.get(p.medicine_id);
    setAddId(p.id);
    setF({
      name: `${p.brand_name ? p.brand_name + " " : ""}${p.strength_text} ${p.dosage_form}`.trim(),
      sale_price: p.retail_price_pkr ?? "", purchase_price: "", reorder_level: 10,
      batch_no: "", batch_qty: "", expiry_date: "",
    });
    setMsg({ err: "", ok: "" });
    return m;
  }
  async function submitAdd() {
    if (!selProd || !selMed) return;
    setMsg({ err: "", ok: "" });
    try {
      if (!f.name.trim()) throw new Error("Medicine name is required.");
      setBusy(true);
      const med = await q(supabase.from("medicines").insert({
        tenant_id: tid, name: f.name.trim(),
        generic_name: selMed.generic_name, brand_name: selProd.brand_name || null,
        manufacturer: selProd.manufacturer || null, category: catPath(selMed.category_id),
        strength: selProd.strength_text, dosage_form: selProd.dosage_form,
        barcode: selProd.barcode || null,
        purchase_price: Number(f.purchase_price) || 0,
        sale_price: Number(f.sale_price) || 0,
        reorder_level: Number(f.reorder_level || 10),
        catalog_product_id: selProd.id,
      }).select().single());
      if (f.batch_no.trim() && Number(f.batch_qty) > 0 && !f.expiry_date) throw new Error("A first batch needs its expiry date — add it here, or leave the batch fields empty and add the batch from the Stock list.");
      let batchNote = "";
      if (f.batch_no.trim() && Number(f.batch_qty) > 0) {
        await q(supabase.from("medicine_batches").insert({
          tenant_id: tid, medicine_id: med.id, batch_no: f.batch_no.trim(),
          quantity: Number(f.batch_qty), expiry_date: f.expiry_date || null,
          purchase_price: Number(f.purchase_price) || 0,
          sale_price: Number(f.sale_price) || 0,
          received_date: todayStr(),
        }));
        batchNote = ` First batch (${f.batch_no.trim()} · qty ${f.batch_qty}) was also added.`;
      } else {
        batchNote = " It has no stock yet — add a batch from the Stock list below to sell it.";
      }
      setMsg({ err: "", ok: `${med.name} has been added to clinic stock.${batchNote}` });
      setAddId(null);
      onAdded?.();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBusy(false);
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>💊 Add medicine from catalog</h3>
      <p className="muted" style={{ marginTop: 0 }}>Search the global Medicine Catalog and add medicines to this clinic's stock.</p>
      <Notice err={msg.err} ok={msg.ok} />
      <input style={{ width: "100%" }} placeholder="Search catalog: Panadol, amoxi, barcode…" value={term} onChange={(e) => setTerm(e.target.value)} />
      {term.trim() && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Brand / Generic</th><th>Strength</th><th>Form</th><th>Pack</th><th>Catalog price</th><th></th></tr></thead>
          <tbody>
            {results.map((p) => { const m = medById.get(p.medicine_id); return (
              <tr key={p.id}>
                <td><b>{p.brand_name ?? m?.generic_name ?? "—"}</b> <span className="muted">{p.brand_name ? m?.generic_name : ""}</span>
                  {m?.is_controlled ? <span className="pill" style={{ background: "#fee2e2", color: "#991b1b", marginLeft: 6 }}>Controlled</span> : null}
                  <div className="muted" style={{ fontSize: 12 }}>{p.manufacturer ?? ""}</div></td>
                <td>{p.strength_text}</td><td>{p.dosage_form}</td><td>{p.pack_size ?? "—"}</td>
                <td>{p.retail_price_pkr != null ? rs(p.retail_price_pkr) : "—"}</td>
                <td>{(() => { const qty = stockQty(p); if (qty === null) return <button className="btn small" onClick={() => openAdd(p)}>＋ Add to stock</button>; if (qty > 0) return <span className="pill" style={{ background: "#dcfce7", color: "#166534" }}>✓ In stock</span>; return <span className="pill amber">Added — no stock yet</span>; })()}</td>
              </tr> ); })}
            {results.length === 0 && <tr><td colSpan={6} className="muted">Nothing found in the catalog.</td></tr>}
          </tbody>
        </table>
      )}
      {selProd && selMed && (
        <div style={{ marginTop: 12, borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
          <b>Add:</b> {selProd.brand_name ?? selMed.generic_name} · {selProd.strength_text} {selProd.dosage_form} <span className="muted">({selMed.generic_name})</span>
          <div className="grid cols-4" style={{ marginTop: 8 }}>
            <div><label>Stock naam *</label><input value={f.name} onChange={set("name")} /></div>
            <div><label>Sale price (Rs)</label><input type="number" value={f.sale_price} onChange={set("sale_price")} /></div>
            <div><label>Purchase price (Rs)</label><input type="number" value={f.purchase_price} onChange={set("purchase_price")} /></div>
            <div><label>Reorder level</label><input type="number" value={f.reorder_level} onChange={set("reorder_level")} /></div>
            <div><label>Batch no</label><input value={f.batch_no} onChange={set("batch_no")} /></div>
            <div><label>Batch qty</label><input type="number" value={f.batch_qty} onChange={set("batch_qty")} /></div>
            <div><label>Expiry date</label><input type="date" value={f.expiry_date} onChange={set("expiry_date")} /></div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn" disabled={busy} onClick={submitAdd}>{busy ? "Adding…" : "Add to stock"}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setAddId(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Phase 5: consultation + catalog prescription picker ----- */
const FREQ_PER_DAY = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, SOS: 0 };
export function ConsultPanel({ profile, token, patient, onClose, onSaved }) {
  const tid = profile.tenant_id;
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [form, setForm] = useState({ chief_complaint: "", diagnosis: "", advice: "", follow_up_date: "" });
  const [term, setTerm] = useState("");
  const [ingMatch, setIngMatch] = useState(null);
  const [items, setItems] = useState([]);
  const [linksByMed, setLinksByMed] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [labTerm, setLabTerm] = useState("");
  const [labPicks, setLabPicks] = useState([]);
  const [labBusy, setLabBusy] = useState(false);
  const { printReceipt } = usePrint() ?? {};
  const { data } = useLoad(async () => {
    const [cat, tenantMeds, htRow, staffRow, lpRow] = await Promise.all([
      (async () => {
        const [cats, meds, prods] = await Promise.all([
          q(supabase.from("med_categories").select("id,parent_id,name,slug").order("sort")),
          q(supabase.from("med_medicines").select("id,generic_name,category_id,is_controlled,status,allergy_alerts").order("generic_name").limit(1000)),
          q(supabase.from("med_products").select("id,medicine_id,brand_name,manufacturer,dosage_form,strength_text,pack_size,barcode,retail_price_pkr,status").limit(2000)),
        ]);
        return { cats: cats ?? [], meds: meds ?? [], prods: prods ?? [] };
      })(),
      q(supabase.from("medicines").select("id,catalog_product_id").eq("is_active", true)),
      q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "hospital_types").maybeSingle()),
      q(supabase.from("staff_directory").select("id").eq("user_profile_id", profile.id).maybeSingle()),
      q(supabase.from("settings").select("value").eq("tenant_id", tid).eq("key", "lab_prices").maybeSingle()),
    ]);
    return { ...cat, tenantMeds: tenantMeds ?? [], ht: htRow?.value ?? null, staffId: staffRow?.id ?? null, labPrices: lpRow?.value ?? null };
  }, [tid]);
  useIngredientMatch(term, setIngMatch);
  const cats = data?.cats ?? [];
  const meds = data?.meds ?? [];
  const prods = data?.prods ?? [];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const medById = new Map(meds.map((m) => [m.id, m]));
  const parentSlugOf = (med) => {
    const c = med ? catById.get(med.category_id) : null;
    if (!c) return null;
    return c.parent_id ? (catById.get(c.parent_id)?.slug ?? null) : c.slug;
  };
  const boostSlug = data?.ht?.primary ? (HOSPITAL_TYPE_CAT_SLUG[data.ht.primary] ?? null) : null;
  const boostCatName = boostSlug ? (cats.find((c) => c.slug === boostSlug)?.name ?? null) : null;
  const tenantMedByProduct = new Map((data?.tenantMeds ?? []).map((m) => [m.catalog_product_id, m.id]));
  let results = catalogSearch(prods, meds, term, ingMatch);
  if (boostSlug) {
    results = [...results].sort((a, b) => {
      const ba = parentSlugOf(medById.get(a.medicine_id)) === boostSlug ? 0 : 1;
      const bb = parentSlugOf(medById.get(b.medicine_id)) === boostSlug ? 0 : 1;
      return ba - bb;
    });
  }
  results = results.slice(0, 30);

  /* Ingredient links for the picked medicines (warnings ka data). */
  const pickedIds = [...new Set(items.map((i) => i.catalogMedicineId))].sort().join(",");
  useEffect(() => {
    if (!pickedIds) { setLinksByMed({}); return; }
    let alive = true;
    (async () => {
      try {
        const rows = await q(supabase.from("med_medicine_ingredients")
          .select("medicine_id,med_ingredients(name)").in("medicine_id", pickedIds.split(",")));
        const map = {};
        (rows ?? []).forEach((r) => { (map[r.medicine_id] = map[r.medicine_id] ?? []).push(r.med_ingredients?.name); });
        if (alive) setLinksByMed(map);
      } catch { if (alive) setLinksByMed({}); }
    })();
    return () => { alive = false; };
  }, [pickedIds]);

  const warnings = useMemo(() => {
    const w = [];
    const ingToMeds = new Map();
    items.forEach((it) => {
      (linksByMed[it.catalogMedicineId] ?? []).forEach((name) => {
        if (!name) return;
        if (!ingToMeds.has(name)) ingToMeds.set(name, new Set());
        ingToMeds.get(name).add(it.catalogMedicineId);
      });
    });
    ingToMeds.forEach((set, name) => {
      if (set.size > 1) w.push({ level: "danger", text: `Duplicate ingredient: ${name} is present in ${set.size} selected medicines — the dose may be duplicated.` });
    });
    const allergyText = (patient?.allergies ?? "").toLowerCase();
    if (allergyText) {
      items.forEach((it) => {
        const med = medById.get(it.catalogMedicineId);
        const names = [med?.generic_name, ...(linksByMed[it.catalogMedicineId] ?? [])].filter(Boolean);
        const hit = names.find((n) => n.length >= 4 && allergyText.includes(n.toLowerCase()));
        if (hit) w.push({ level: "danger", text: `Allergy alert: the patient's allergy record mentions "${hit}", which matches this medicine (${it.label}).` });
        if (med?.allergy_alerts) w.push({ level: "warn", text: `Catalog allergy note (${med.generic_name}): ${med.allergy_alerts}` });
      });
    }
    return w;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, linksByMed, patient]);

  function addItem(p) {
    const m = medById.get(p.medicine_id);
    if (!m) return;
    if (items.some((i) => i.productId === p.id)) { setMsg({ err: "", ok: "This medicine is already in the Rx." }); return; }
    setItems([...items, {
      key: p.id, productId: p.id, catalogMedicineId: m.id,
      label: `${p.brand_name ? p.brand_name + " (" + m.generic_name + ") " : m.generic_name + " "}${p.strength_text} ${p.dosage_form}`,
      tenantMedicineId: tenantMedByProduct.get(p.id) ?? null,
      controlled: !!m.is_controlled,
      dosage: "", frequency: "TDS", duration_days: 5, quantity: 15, instructions: "",
    }]);
  }
  function updItem(key, k, v) {
    setItems(items.map((it) => {
      if (it.key !== key) return it;
      const n = { ...it, [k]: v };
      if (k === "frequency" || k === "duration_days") {
        const per = FREQ_PER_DAY[n.frequency] ?? 0;
        if (per > 0) n.quantity = per * Number(n.duration_days || 0);
      }
      return n;
    }));
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  /* Lab ordering: the doctor picks tests from the clinic's effective
     price list (clinic prices win, then the built-in list, then the
     standard fee). Each order's fee is posted to Finance by the
     database trigger, exactly like orders from the Lab screen. */
  const allTests = [...new Set([...(data?.labPrices ? Object.keys(data.labPrices) : []), ...BUILTIN_LAB_PRICES.map((t) => t.name)])].sort((a, b) => a.localeCompare(b));
  const labResults = labTerm.trim() ? allTests.filter((n) => n.toLowerCase().includes(labTerm.trim().toLowerCase()) && !labPicks.some((pk) => pk.name === n)).slice(0, 8) : [];
  const labTotal = labPicks.reduce((sum, pk) => sum + pk.fee, 0);
  async function orderLabs() {
    if (!labPicks.length) return;
    setMsg({ err: "", ok: "" });
    try {
      setLabBusy(true);
      await q(supabase.from("lab_orders").insert(labPicks.map((pk) => ({
        tenant_id: tid, patient_id: token.patient_id, ordered_by: data?.staffId ?? null,
        test_name: pk.name,
        test_code: pk.name.split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "LAB",
        fee_pkr: pk.fee, status: "pending",
      }))));
      setMsg({ err: "", ok: `Lab tests ordered: ${labPicks.map((pk) => pk.name).join(", ")} — ${rs(labTotal)} posted to Finance.` });
      setLabPicks([]); setLabTerm("");
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setLabBusy(false);
  }

  async function save() {
    setMsg({ err: "", ok: "" });
    try {
      setBusy(true);
      const cons = await q(supabase.from("consultations").insert({
        tenant_id: tid, patient_id: token.patient_id, token_id: token.id,
        doctor_id: data?.staffId ?? null,
        chief_complaint: form.chief_complaint.trim() || null,
        diagnosis: form.diagnosis.trim() || null,
        advice: form.advice.trim() || null,
        follow_up_date: form.follow_up_date || null,
        status: "completed",
      }).select().single());
      if (items.length) {
        const rx = await q(supabase.from("prescriptions").insert({
          tenant_id: tid, consultation_id: cons.id, patient_id: token.patient_id,
          doctor_id: data?.staffId ?? null, notes: form.diagnosis.trim() || null,
        }).select().single());
        await q(supabase.from("prescription_items").insert(items.map((it) => ({
          tenant_id: tid, prescription_id: rx.id, medicine_id: it.tenantMedicineId,
          medicine_name: it.label, dosage: it.dosage.trim() || null, frequency: it.frequency,
          duration_days: Number(it.duration_days || 0), quantity: Number(it.quantity || 0),
          instructions: it.instructions.trim() || null,
        }))));
      }
      await q(supabase.from("tokens").update({ status: "completed" }).eq("id", token.id));
      setSaved(true);
      setMsg({ err: "", ok: "Consultation and prescription saved; token marked complete." });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
    setBusy(false);
  }

  return (
    <div className="card" style={{ marginTop: 14, border: "2px solid #0e7490" }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>✍️ Consultation / Rx — {patient?.full_name ?? "Patient"} <span className="muted">#{token.token_number}</span></h3>
        <button className="btn small ghost" onClick={onClose}>Close</button>
      </div>
      <Notice err={msg.err} ok={msg.ok} />
      {patient?.allergies
        ? <p style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 10px" }}>⚠ <b>Patient allergies:</b> {patient.allergies}</p>
        : <p className="muted" style={{ fontSize: 12 }}>The patient has no allergy record — safety alerts are based only on data present in the catalog and the patient record.</p>}
      {!data?.staffId && <p className="muted" style={{ fontSize: 12 }}>Note: your staff record was not found — the consultation will be saved without a doctor link.</p>}
      <div className="grid cols-3">
        <div><label>Chief complaint</label><input value={form.chief_complaint} onChange={set("chief_complaint")} /></div>
        <div><label>Diagnosis</label><input value={form.diagnosis} onChange={set("diagnosis")} /></div>
        <div><label>Follow-up date</label><input type="date" value={form.follow_up_date} onChange={set("follow_up_date")} /></div>
      </div>
      <div style={{ marginTop: 8 }}><label>Advice / notes</label><input value={form.advice} onChange={set("advice")} /></div>

      <h4 style={{ marginBottom: 6 }}>💊 Prescription — pick medicines from the catalog</h4>
      {boostSlug && boostCatName && <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>🏥 Smart filter: based on your hospital type ({data.ht.primary}), <b>{boostCatName}</b> medicines are listed first — the full catalog remains searchable.</p>}
      <input style={{ width: "100%" }} placeholder="Search: generic, brand or ingredient — e.g. amoxi, Panadol, clavulanic" value={term} onChange={(e) => setTerm(e.target.value)} />
      {term.trim() && (
        <table style={{ marginTop: 8 }}>
          <tbody>
            {results.map((p) => { const m = medById.get(p.medicine_id); const boosted = boostSlug && parentSlugOf(m) === boostSlug; return (
              <tr key={p.id}>
                <td><b>{p.brand_name ?? m?.generic_name ?? "—"}</b> <span className="muted">{p.brand_name ? m?.generic_name : ""}</span>
                  {boosted ? <span className="pill" style={{ background: "#ecfeff", color: "#155e75", marginLeft: 6 }}>🏥 Specialty</span> : null}
                  {m?.is_controlled ? <span className="pill" style={{ background: "#fee2e2", color: "#991b1b", marginLeft: 6 }}>Controlled</span> : null}</td>
                <td>{p.strength_text} {p.dosage_form}</td>
                <td><button className="btn small" onClick={() => addItem(p)}>＋ Add to Rx</button></td>
              </tr> ); })}
            {results.length === 0 && <tr><td colSpan={3} className="muted">Nothing found in the catalog.</td></tr>}
          </tbody>
        </table>
      )}
      {warnings.map((w, i) => (
        <p key={i} style={{ background: w.level === "danger" ? "#fef2f2" : "#fffbeb", border: `1px solid ${w.level === "danger" ? "#fecaca" : "#fde68a"}`, borderRadius: 8, padding: "8px 10px", marginTop: 8 }}>
          {w.level === "danger" ? "⛔" : "⚠"} {w.text}
        </p>
      ))}
      {items.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Din</th><th>Qty</th><th>Instructions</th><th></th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.key}>
                <td><b>{it.label}</b>{it.controlled ? <span className="pill" style={{ background: "#fee2e2", color: "#991b1b", marginLeft: 6 }}>Controlled</span> : null}
                  <div className="muted" style={{ fontSize: 12 }}>{it.tenantMedicineId ? "Linked to clinic stock" : "Catalog only — not in clinic stock"}</div></td>
                <td><input style={{ width: 90 }} placeholder="1 tablet" value={it.dosage} onChange={(e) => updItem(it.key, "dosage", e.target.value)} /></td>
                <td><select value={it.frequency} onChange={(e) => updItem(it.key, "frequency", e.target.value)}>
                  {Object.keys(FREQ_PER_DAY).map((fr) => <option key={fr} value={fr}>{fr}</option>)}
                </select></td>
                <td><input type="number" style={{ width: 64 }} value={it.duration_days} onChange={(e) => updItem(it.key, "duration_days", e.target.value)} /></td>
                <td><input type="number" style={{ width: 64 }} value={it.quantity} onChange={(e) => updItem(it.key, "quantity", e.target.value)} /></td>
                <td><input style={{ width: 130 }} placeholder="khane ke baad" value={it.instructions} onChange={(e) => updItem(it.key, "instructions", e.target.value)} /></td>
                <td><button className="btn small ghost" onClick={() => setItems(items.filter((x) => x.key !== it.key))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 16, borderTop: "1px dashed #cbd5e1", paddingTop: 12 }}>
        <h4 style={{ margin: "0 0 6px" }}>🧪 Lab tests</h4>
        <input placeholder="Search tests — e.g. CBC, LFT, Sugar" value={labTerm} onChange={(e) => setLabTerm(e.target.value)} />
        {labResults.length > 0 && (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, marginTop: 6 }}>
            {labResults.map((n) => { const info = labPriceInfo(n, data?.labPrices ?? null); return (
              <div key={n} className="row" style={{ padding: "6px 10px", borderBottom: "1px solid #f1f5f9" }}>
                <span>{n}</span><div className="spacer" /><span className="muted">{rs(info.price)}</span>
                <button className="btn small" onClick={() => setLabPicks([...labPicks, { name: n, fee: info.price }])}>+ Add</button>
              </div> ); })}
          </div>
        )}
        {labPicks.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {labPicks.map((pk) => <span key={pk.name} className="pill blue">{pk.name} · {rs(pk.fee)} <button className="toast-x" style={{ color: "inherit" }} onClick={() => setLabPicks(labPicks.filter((x) => x.name !== pk.name))}>✕</button></span>)}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span>Total <b>{rs(labTotal)}</b> — the fee posts to Finance automatically</span><div className="spacer" />
              <button className="btn small" disabled={labBusy} onClick={orderLabs}>{labBusy ? "Ordering…" : "Order lab tests"}</button>
            </div>
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={busy || saved} onClick={save}>{busy ? "Saving…" : "💾 Save consultation + Rx (token complete)"}</button>
        {saved && <button className="btn ghost" onClick={() => printReceipt?.({
          title: "Prescription",
          lines: [
            { k: "Patient", v: patient?.full_name ?? "" },
            { k: "MR", v: patient?.mr_number ?? "" },
            { k: "Diagnosis", v: form.diagnosis },
            ...items.map((it) => ({ k: it.label, v: `${it.dosage || ""} ${it.frequency} × ${it.duration_days} din — qty ${it.quantity}${it.instructions ? " (" + it.instructions + ")" : ""}` })),
            { k: "Advice", v: form.advice },
          ],
        })}>🖨 Print Rx</button>}
        {saved && <button className="btn" onClick={onSaved}>Done — queue par wapas</button>}
      </div>
    </div>
  );
}


export function PlatformCatalog({ profile }) {
  const PAGE = 25;
  const [term, setTerm] = useState("");
  const [parentId, setParentId] = useState("");
  const [statusF, setStatusF] = useState("");
  const [page, setPage] = useState(0);
  const [selId, setSelId] = useState(null);
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [ingMatch, setIngMatch] = useState(null);
  const [detailIng, setDetailIng] = useState([]);

  const { data, err, loading, reload } = useLoad(async () => {
    const [cats, meds, prods] = await Promise.all([
      q(supabase.from("med_categories").select("id,parent_id,name,slug").order("sort")),
      q(supabase.from("med_medicines").select("id,generic_name,normalized_name,pharm_class,therapeutic_class,category_id,is_controlled,status,indications,contraindications,warnings,common_adverse_effects,serious_adverse_effects,interactions,allergy_alerts,pregnancy_info,lactation_info,pediatric_notes,geriatric_notes,storage_requirements,source_ref,verified_at").order("generic_name").limit(1000)),
      q(supabase.from("med_products").select("id,medicine_id,brand_name,manufacturer,dosage_form,route,strength_text,pack_size,units_per_pack,rx_status,status,retail_price_pkr,barcode,registration_no").limit(2000)),
    ]);
    return { cats: cats ?? [], meds: meds ?? [], prods: prods ?? [] };
  }, []);

  /* Ingredient-name matches for the search box (server query, so a
     search for "clavulanic" finds Co-amoxiclav). */
  useEffect(() => {
    const t = term.trim();
    if (t.length < 2) { setIngMatch(null); return; }
    let alive = true;
    (async () => {
      try {
        const ings = await q(supabase.from("med_ingredients").select("id").ilike("name", `%${t}%`).limit(50));
        if (!ings?.length) { if (alive) setIngMatch(new Set()); return; }
        const links = await q(supabase.from("med_medicine_ingredients").select("medicine_id").in("ingredient_id", ings.map((i) => i.id)).limit(500));
        if (alive) setIngMatch(new Set((links ?? []).map((l) => l.medicine_id)));
      } catch { if (alive) setIngMatch(new Set()); }
    })();
    return () => { alive = false; };
  }, [term]);

  /* Ingredient chips for the open medicine. */
  useEffect(() => {
    if (!selId) { setDetailIng([]); return; }
    let alive = true;
    (async () => {
      try {
        const rows = await q(supabase.from("med_medicine_ingredients").select("med_ingredients(name)").eq("medicine_id", selId));
        if (alive) setDetailIng((rows ?? []).map((r) => r.med_ingredients?.name).filter(Boolean));
      } catch { if (alive) setDetailIng([]); }
    })();
    return () => { alive = false; };
  }, [selId]);

  const cats = data?.cats ?? [];
  const meds = data?.meds ?? [];
  const prods = data?.prods ?? [];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const parents = cats.filter((c) => !c.parent_id);
  const catPath = (id) => {
    const c = catById.get(id);
    if (!c) return "—";
    const p = c.parent_id ? catById.get(c.parent_id) : null;
    return p ? `${p.name} › ${c.name}` : c.name;
  };
  const vCount = new Map();
  prods.forEach((p) => vCount.set(p.medicine_id, (vCount.get(p.medicine_id) ?? 0) + 1));

  const t = term.trim().toLowerCase();
  const brandMatch = t ? new Set(prods.filter((p) => (p.brand_name ?? "").toLowerCase().includes(t)).map((p) => p.medicine_id)) : new Set();
  const allowedCats = parentId ? new Set([parentId, ...cats.filter((c) => c.parent_id === parentId).map((c) => c.id)]) : null;
  const filtered = meds.filter((m) => {
    if (allowedCats && !allowedCats.has(m.category_id)) return false;
    if (statusF && m.status !== statusF) return false;
    if (!t) return true;
    return m.generic_name.toLowerCase().includes(t) || brandMatch.has(m.id) || (ingMatch?.has(m.id) ?? false);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const pageRows = filtered.slice(cur * PAGE, cur * PAGE + PAGE);
  const sel = meds.find((m) => m.id === selId) ?? null;
  const selProds = sel ? prods.filter((p) => p.medicine_id === sel.id) : [];

  const pendingN = meds.filter((m) => m.status === "pending_verification").length;
  const verifiedN = meds.filter((m) => m.status === "verified").length;
  const controlledN = meds.filter((m) => m.is_controlled).length;
  const noMfr = prods.filter((p) => !p.manufacturer).length;
  const withPrice = prods.filter((p) => p.retail_price_pkr != null).length;

  async function verifyMed(id) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("med_medicines").update({ status: "verified", verified_at: todayStr() }).eq("id", id));
      setMsg({ err: "", ok: "Medicine marked as verified." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  async function verifyProd(id) {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("med_products").update({ status: "verified" }).eq("id", id));
      setMsg({ err: "", ok: "Variant marked as verified." });
      reload();
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }
  const statusPill = (s) => s === "verified"
    ? <span className="pill" style={{ background: "#dcfce7", color: "#166534" }}>Verified</span>
    : s === "discontinued"
      ? <span className="pill" style={{ background: "#fee2e2", color: "#991b1b" }}>Discontinued</span>
      : <span className="pill" style={{ background: "#fef3c7", color: "#92400e" }}>Pending</span>;
  const field = (label, val) => (
    <div>
      <div className="muted" style={{ fontSize: 12, fontWeight: 700 }}>{label}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{val || <span className="muted">No data available — will be added from a verified source.</span>}</div>
    </div>
  );

  return (
    <div>
      <div className="pagehead">
        <div>
          <h2 style={{ margin: 0 }}>💊 Medicine Catalog</h2>
          <div className="muted">Global reference catalog — shared by all clinics. Each clinic's own stock is kept separate.</div>
        </div>
      </div>
      <Notice err={msg.err || err} ok={msg.ok} />
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <span className="modchip">Medicines: {meds.length}</span>
        <span className="modchip">Variants: {prods.length}</span>
        <span className="modchip">Categories: {cats.length}</span>
        <span className="modchip">Pending verification: {pendingN}</span>
        <span className="modchip">Verified: {verifiedN}</span>
        <span className="modchip">Controlled: {controlledN}</span>
        <span className="modchip">Variants without manufacturer: {noMfr}</span>
        <span className="modchip">Variants with price: {withPrice}</span>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input style={{ flex: "2 1 240px" }} placeholder="Search: generic, brand or ingredient — e.g. amoxi, Panadol, clavulanic" value={term}
            onChange={(e) => { setTerm(e.target.value); setPage(0); }} />
          <select style={{ flex: "1 1 200px" }} value={parentId} onChange={(e) => { setParentId(e.target.value); setPage(0); }}>
            <option value="">Saari categories</option>
            {parents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select style={{ flex: "1 1 160px" }} value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(0); }}>
            <option value="">Har status</option>
            <option value="pending_verification">Pending verification</option>
            <option value="verified">Verified</option>
            <option value="discontinued">Discontinued</option>
          </select>
        </div>
        {loading ? <p className="muted">Loading…</p> : (
          <>
            <table>
              <thead><tr><th>Generic name</th><th>Category</th><th>Class</th><th>Variants</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {pageRows.map((m) => (
                  <tr key={m.id} style={selId === m.id ? { background: "#f0fdfa" } : undefined}>
                    <td><b>{m.generic_name}</b>{m.is_controlled ? <span className="pill" style={{ background: "#fee2e2", color: "#991b1b", marginLeft: 6 }}>Controlled</span> : null}</td>
                    <td>{catPath(m.category_id)}</td>
                    <td>{m.pharm_class ?? "—"}</td>
                    <td>{vCount.get(m.id) ?? 0}</td>
                    <td>{statusPill(m.status)}</td>
                    <td><button className="btn small" onClick={() => setSelId(selId === m.id ? null : m.id)}>{selId === m.id ? "Close" : "Detail"}</button></td>
                  </tr>
                ))}
                {pageRows.length === 0 && <tr><td colSpan={6} className="muted">No medicine found — try changing the search or filter.</td></tr>}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" disabled={cur === 0} onClick={() => setPage(cur - 1)}>← Pichla</button>
              <span className="muted">Page {cur + 1} / {pages} — kul {filtered.length} medicines</span>
              <button className="btn small" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Agla →</button>
            </div>
          </>
        )}
      </div>

      {sel && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>{sel.generic_name}</h3>
            <div className="row" style={{ gap: 8 }}>
              {statusPill(sel.status)}
              {sel.status !== "verified" && <button className="btn small" onClick={() => verifyMed(sel.id)}>✓ Mark as verified</button>}
            </div>
          </div>
          <p className="muted" style={{ marginTop: 4 }}>{catPath(sel.category_id)} · {sel.pharm_class ?? ""}{sel.is_controlled ? " · Controlled medicine" : ""}{sel.verified_at ? ` · Verified: ${sel.verified_at}` : ""}</p>
          <div style={{ marginBottom: 10 }}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 700 }}>INGREDIENTS</div>
            {detailIng.length ? detailIng.map((n) => <span key={n} className="modchip">{n}</span>)
              : <span className="muted">No ingredient data available.</span>}
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 300px", display: "grid", gap: 12 }}>
              {field("Indications", sel.indications)}
              {field("Contraindications", sel.contraindications)}
              {field("Warnings", sel.warnings)}
              {field("Interactions", sel.interactions)}
            </div>
            <div style={{ flex: "1 1 300px", display: "grid", gap: 12 }}>
              {field("Common side effects", sel.common_adverse_effects)}
              {field("Serious side effects", sel.serious_adverse_effects)}
              {field("Pregnancy / Breastfeeding", [sel.pregnancy_info, sel.lactation_info].filter(Boolean).join(" ") || null)}
              {field("Storage", sel.storage_requirements)}
            </div>
          </div>
          {sel.source_ref && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Source: {sel.source_ref}</p>}
          <h4 style={{ marginBottom: 6 }}>Product variants ({selProds.length})</h4>
          <table>
            <thead><tr><th>Brand</th><th>Manufacturer</th><th>Form</th><th>Strength</th><th>Pack</th><th>Rx</th><th>Price</th><th>DRAP No.</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {selProds.map((p) => (
                <tr key={p.id}>
                  <td>{p.brand_name ?? <span className="muted">Generic</span>}</td>
                  <td>{p.manufacturer ?? "—"}</td>
                  <td>{p.dosage_form}</td>
                  <td>{p.strength_text}</td>
                  <td>{p.pack_size ?? "—"}</td>
                  <td>{p.rx_status}</td>
                  <td>{p.retail_price_pkr != null ? rs(p.retail_price_pkr) : "—"}</td>
                  <td>{p.registration_no ?? "—"}</td>
                  <td>{statusPill(p.status)}</td>
                  <td>{p.status !== "verified" && <button className="btn small" onClick={() => verifyProd(p.id)}>✓ Verify</button>}</td>
                </tr>
              ))}
              {selProds.length === 0 && <tr><td colSpan={10} className="muted">This medicine has no variants in the catalog yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {data && <CatalogImport cats={cats} meds={meds} prods={prods} profile={profile} onDone={reload} />}
    </div>
  );
}

/* ---------------- Salary slips + My Profile ---------------- */
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(ym) {
  const [y, m] = String(ym ?? "").split("-");
  const name = MONTH_NAMES[Number(m) - 1];
  return name ? `${name} ${y}` : String(ym ?? "");
}
export function paySlipDoc(name, role, r) {
  const slipPaper = "A4";
  const net = r.net_salary || ((r.basic_salary ?? 0) + (r.allowances ?? 0) - (r.deductions ?? 0) - (r.late_deduction ?? 0) - (r.absent_deduction ?? 0));
  return {
    paper: slipPaper,
    title: "Salary Slip",
    big: rs(net),
    lines: [
      { k: "Employee", v: name },
      { k: "Role", v: String(role ?? "").replaceAll("_", " ") },
      { k: "Month", v: monthLabel(`${r.period_year}-${String(r.period_month ?? "").padStart(2, "0")}`) },
      { k: "Basic salary", v: rs(r.basic_salary ?? 0) },
      { k: "Allowances", v: rs(r.allowances ?? 0) },
      { k: "Deductions", v: rs(r.deductions ?? 0) },
      { k: "Net pay", v: rs(net) },
      { k: "Status", v: r.status ?? "" },
      ...(r.paid_at ? [{ k: "Paid date", v: String(r.paid_at).slice(0, 10) }] : []),
    ],
  };
}

/* Every staff member's own corner of the app: profile photo + name /
   phone, and — through the my_salary_details() database function —
   ONLY their own employment and salary record (joining date, basic
   salary, allowances, and every payslip with its paid status). Other
   people's salary data stays invisible, exactly as the database
   rules already enforce everywhere else. */
export function MyProfile({ profile }) {
  const { printReceipt } = usePrint() ?? {};
  const [me, setMe] = useState(null);
  const [form, setForm] = useState({ full_name: "", phone: "" });
  const [sal, setSal] = useState(undefined);
  const [msg, setMsg] = useState({ err: "", ok: "" });
  const [photoBusy, setPhotoBusy] = useState(false);
  const [myStaffId, setMyStaffId] = useState("");
  const myQr = useQrUrl(myStaffId);
  const [myAtt, setMyAtt] = useState(undefined);
  const [clinicName, setClinicName] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("user_profiles").select("*").eq("id", profile.id).maybeSingle();
        if (data) { setMe(data); setForm({ full_name: data.full_name ?? "", phone: data.phone ?? "" }); }
      } catch { /* profile prop still renders */ }
      try {
        const sd = await supabase.from("staff_directory").select("id").eq("user_profile_id", profile.id).maybeSingle();
        if (sd.data?.id) setMyStaffId(sd.data.id);
      } catch { /* QR card simply stays hidden */ }
      try {
        const ra = await supabase.rpc("my_attendance");
        setMyAtt(ra.error ? null : (ra.data ?? []));
      } catch { setMyAtt(null); }
      try {
        if (profile.tenant_id) {
          const br = await supabase.from("settings").select("value").eq("tenant_id", profile.tenant_id).eq("key", "clinic_branding").maybeSingle();
          if (br.data?.value?.name) setClinicName(br.data.value.name);
        }
      } catch { /* card falls back to a generic header */ }
      const r = await supabase.rpc("my_salary_details");
      setSal(r.error ? null : (r.data ?? null));
    })();
  }, [profile.id]);

  async function saveProfile() {
    setMsg({ err: "", ok: "" });
    try {
      if (!form.full_name.trim()) throw new Error("Your name cannot be empty.");
      await q(supabase.from("user_profiles").update({ full_name: form.full_name.trim(), phone: form.phone || null }).eq("id", profile.id));
      setMe((m) => ({ ...(m ?? {}), full_name: form.full_name.trim(), phone: form.phone || null }));
      setMsg({ ok: "Profile saved. Your new name appears in the sidebar the next time you sign in.", err: "" });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMsg({ err: "", ok: "" });
    setPhotoBusy(true);
    try {
      const url = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const max = 160;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/jpeg", 0.82));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
      await q(supabase.from("user_profiles").update({ avatar_url: url }).eq("id", profile.id));
      setMe((m) => ({ ...(m ?? {}), avatar_url: url }));
      setMsg({ ok: "Profile photo saved. It appears in the sidebar the next time you sign in.", err: "" });
    } catch (err) {
      setMsg({ err: "Photo could not be saved yet — it needs a one-time setup by the clinic admin. Your name and phone can still be saved below.", ok: "" });
    } finally { setPhotoBusy(false); }
  }

  async function removePhoto() {
    setMsg({ err: "", ok: "" });
    try {
      await q(supabase.from("user_profiles").update({ avatar_url: null }).eq("id", profile.id));
      setMe((m) => ({ ...(m ?? {}), avatar_url: null }));
      setMsg({ ok: "Profile photo removed.", err: "" });
    } catch (e) { setMsg({ err: e.message, ok: "" }); }
  }

  const staff = sal?.staff ?? null;
  const salary = sal?.salary ?? null;
  const payroll = sal?.payroll ?? [];
  const totalPaid = payroll.filter((r) => r.status === "paid").reduce((a, r) => a + (r.net_salary || ((r.basic_salary ?? 0) + (r.allowances ?? 0) - (r.deductions ?? 0) - (r.late_deduction ?? 0) - (r.absent_deduction ?? 0))), 0);

  return (
    <div>
      <h2>My Profile</h2>
      <p className="muted" style={{ marginTop: 0 }}>Your own details — only you can see this page.</p>
      <Notice err={msg.err} ok={msg.ok} />
      <div className="grid cols-2">
        <div className="card">
          <h3>Profile</h3>
          <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
            {me?.avatar_url
              ? <img src={me.avatar_url} alt="" style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover" }} />
              : <span className="brandmark" style={{ width: 72, height: 72, fontSize: 32, borderRadius: "50%" }}>👤</span>}
            <div>
              <label style={{ display: "inline-block", cursor: "pointer" }} className="btn small ghost">
                {photoBusy ? "Saving…" : "Add / change photo"}
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={onPhoto} disabled={photoBusy} />
              </label>
              {me?.avatar_url && <button className="btn small ghost" style={{ marginLeft: 8 }} onClick={removePhoto}>Remove</button>}
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>A small photo is stored with your account.</div>
            </div>
          </div>
          <div style={{ marginBottom: 10 }}><label>Full name</label><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
          <div style={{ marginBottom: 10 }}><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div style={{ marginBottom: 10 }}><label>Email (sign-in)</label><input value={me?.email ?? profile.email ?? ""} disabled /></div>
          <div style={{ marginBottom: 12 }}><label>Role</label><input value={String(me?.role ?? profile.role ?? "").replaceAll("_", " ")} disabled /></div>
          <button className="btn" onClick={saveProfile}>Save profile</button>
        </div>
        <div className="card">
          <h3>My employment & salary</h3>
          {sal === undefined && <p className="muted">Loading…</p>}
          {sal === null && <p className="muted">Your salary view will appear here once the clinic completes a one-time setup. Please ask your clinic admin — it takes a minute.</p>}
          {sal !== undefined && sal !== null && !staff && <p className="muted">No staff record is linked to your login yet. Your clinic admin can fix this from the HR screen.</p>}
          {staff && (
            <div>
              <div className="r-line" style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">Designation</span><b>{staff.designation || String(staff.role ?? "").replaceAll("_", " ")}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">Joined on</span><b>{staff.joining_date ? String(staff.joining_date).slice(0, 10) : "—"}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">Basic salary</span><b>{salary ? rs(salary.basic_salary ?? 0) : "Not set"}</b></div>
              {salary?.doctor_share_percent != null && <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">Doctor share</span><b>{salary.doctor_share_percent}%</b></div>}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">Total paid to date</span><b>{rs(totalPaid)}</b></div>
            </div>
          )}
        </div>
      </div>
      {myStaffId && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>My attendance QR</h3>
          <div className="row" style={{ alignItems: "center", gap: 18 }}>
            {myQr ? <img src={myQr} alt="My attendance QR" style={{ width: 180, height: 180 }} /> : <p className="muted">Preparing QR…</p>}
            <div>
              <p className="muted" style={{ marginTop: 0 }}>Show this code at the HR desk — your attendance is marked by scanning it. It also works straight off your phone screen.</p>
              <button className="btn" onClick={() => myQr && printQrBadge(me?.full_name ?? profile.full_name ?? "", staff?.designation || profile.role, myQr, { clinic: clinicName, photo: me?.avatar_url })}>Print my ID card</button>
            </div>
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 14 }}>
        <h3>My attendance</h3>
        {myAtt === undefined && <p className="muted">Loading…</p>}
        {myAtt === null && <p className="muted">Your attendance view will appear here once the clinic completes a one-time setup. Please ask your clinic admin — it takes a minute.</p>}
        {Array.isArray(myAtt) && (myAtt.length === 0
          ? <p className="muted">No attendance records yet. Your attendance is marked at the HR desk (QR scan or manual).</p>
          : (
            <table>
              <thead><tr><th>Date</th><th>Status</th><th>Method</th><th>Check-in</th><th>Check-out</th></tr></thead>
              <tbody>
                {myAtt.slice(0, 30).map((a) => (
                  <tr key={a.id}>
                    <td>{String(a.attendance_date ?? "").slice(0, 10)}</td>
                    <td><span className={`pill ${a.status === "present" ? "green" : "amber"}`}>{a.status}</span></td>
                    <td>{a.method ?? ""}</td>
                    <td>{a.check_in_at ? String(a.check_in_at).slice(11, 16) : "—"}</td>
                    <td>{a.check_out_at ? String(a.check_out_at).slice(11, 16) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
      {staff && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>My payslips</h3>
          {payroll.length === 0
            ? <p className="muted">No payslips yet. When Finance or HR generates your salary slip, it will appear here.</p>
            : (
              <table>
                <thead><tr><th>Month</th><th>Basic</th><th>Allowances</th><th>Deductions</th><th>Net pay</th><th>Status</th><th>Paid date</th><th></th></tr></thead>
                <tbody>
                  {payroll.map((r) => (
                    <tr key={r.id}>
                      <td>{monthLabel(`${r.period_year}-${String(r.period_month ?? "").padStart(2, "0")}`)}</td>
                      <td>{rs(r.basic_salary ?? 0)}</td>
                      <td>{rs(r.allowances ?? 0)}</td>
                      <td>{rs(r.deductions ?? 0)}</td>
                      <td><b>{rs(r.net_salary || ((r.basic_salary ?? 0) + (r.allowances ?? 0) - (r.deductions ?? 0) - (r.late_deduction ?? 0) - (r.absent_deduction ?? 0)))}</b></td>
                      <td><span className={`pill ${r.status === "paid" ? "green" : "amber"}`}>{payrollStatusLabel(r.status)}</span></td>
                      <td>{r.paid_at ? String(r.paid_at).slice(0, 10) : "—"}</td>
                      <td><button className="btn small ghost" onClick={() => printReceipt?.(paySlipDoc(staff.full_name, staff.role, r))}>Print</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </div>
  );
}
