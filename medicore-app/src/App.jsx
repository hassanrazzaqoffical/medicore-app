import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient.js";
import {
  Dashboard, Tokens, TvBoard, Patients, CareQueue, Pharmacy,
  Finance, HR, Lab, Operations, Reports, Settings,
  PlatformDashboard, PlatformTenants, PlatformPlans, PlatformSubscriptions, PlatformUsers,
  PlatformCatalog,
  PrintProvider, ToastProvider, moduleEnabled,
  MyProfile,
} from "./modules.jsx";

/* PRIVACY LOCKDOWN: super_admin appears ONLY in the five platform
   entries at the bottom (Platform Dashboard, Tenants, Plans,
   Subscriptions, Users) — it has no clinical/financial module at
   all, matching the database-level tenant guard. Other roles are
   unchanged. */
/* Each role lands on its own work screen — the panels are fully
   separate: a role's sidebar contains only the screens for its own
   job, and its home is the main one of those. */
const HOME_BY_ROLE = {
  clinic_admin: "dashboard", doctor: "doctor", nurse: "nursing",
  pharmacist: "pharmacy", token_operator: "tokens", accountant: "finance",
  hr_manager: "hr", lab_operator: "lab", display: "tv", super_admin: "platform",
};
const NAV = [
  { key: "dashboard", label: "Dashboard", icon: "🏠", roles: ["clinic_admin"] },
  { key: "tokens", label: "Tokens / OPD", icon: "🎫", roles: ["clinic_admin", "token_operator"] },
  { key: "patients", label: "Patients", icon: "🧑", roles: ["clinic_admin", "doctor", "nurse"] },
  { key: "doctor", label: "Doctor Queue", icon: "🩺", roles: ["doctor", "clinic_admin"] },
  { key: "nursing", label: "Nursing", icon: "💉", roles: ["nurse", "clinic_admin"] },
  { key: "pharmacy", label: "Pharmacy POS", icon: "💊", roles: ["pharmacist", "clinic_admin"] },
  { key: "lab", label: "Lab", icon: "🧪", roles: ["lab_operator", "clinic_admin", "doctor"] },
  { key: "operations", label: "Operations (OT)", icon: "🏥", roles: ["clinic_admin", "doctor", "nurse"] },
  { key: "finance", label: "Finance", icon: "💰", roles: ["accountant", "clinic_admin"] },
  { key: "hr", label: "HR & Attendance", icon: "👥", roles: ["hr_manager", "clinic_admin"] },
  { key: "reports", label: "Reports", icon: "📈", roles: ["clinic_admin", "accountant"] },
  { key: "tv", label: "TV Queue Board", icon: "📺", roles: ["clinic_admin", "display"] },
  { key: "settings", label: "Settings / Users", icon: "⚙️", roles: ["clinic_admin"] },
  { key: "myprofile", label: "My Profile", icon: "👤", roles: ["clinic_admin", "doctor", "nurse", "pharmacist", "token_operator", "accountant", "hr_manager", "lab_operator"] },
  { key: "platform", label: "Platform Dashboard", icon: "📊", roles: ["super_admin"] },
  { key: "tenants", label: "Tenants", icon: "🏥", roles: ["super_admin"] },
  { key: "plans", label: "Plans", icon: "💳", roles: ["super_admin"] },
  { key: "subscriptions", label: "Subscriptions", icon: "🗓️", roles: ["super_admin"] },
  { key: "users", label: "Users", icon: "👥", roles: ["super_admin"] },
  { key: "catalog", label: "Medicine Catalog", icon: "💊", roles: ["super_admin"] },
];

/* Login lockout (app-level, per email, on top of Supabase's own limits):
   5 failed attempts -> form locked for 5 minutes, stored in localStorage. */
const lockKeyFor = (email) => `medicore_login_lock_${email.trim().toLowerCase()}`;
function readLock(email) {
  try { return JSON.parse(localStorage.getItem(lockKeyFor(email)) ?? "null"); } catch { return null; }
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockSecs, setLockSecs] = useState(0);

  useEffect(() => {
    const tick = () => {
      const rec = email.trim() ? readLock(email) : null;
      const left = rec?.lockedUntil ? Math.ceil((rec.lockedUntil - Date.now()) / 1000) : 0;
      setLockSecs(left > 0 ? left : 0);
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [email]);
  const locked = lockSecs > 0;
  const lockText = `${Math.floor(lockSecs / 60)}:${String(lockSecs % 60).padStart(2, "0")}`;

  async function signIn(e) {
    e.preventDefault();
    const em = email.trim();
    const rec = readLock(em);
    if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
      setErr(`Too many failed attempts — sign-in is locked for ${Math.ceil((rec.lockedUntil - Date.now()) / 60000)} minute(s).`);
      return;
    }
    setBusy(true); setErr(""); setOk("");
    const { error } = await supabase.auth.signInWithPassword({ email: em, password });
    if (error) {
      const count = (rec?.count ?? 0) + 1;
      if (count >= 5) {
        localStorage.setItem(lockKeyFor(em), JSON.stringify({ count, lockedUntil: Date.now() + 5 * 60 * 1000 }));
        setErr("5 failed attempts — sign-in is locked for 5 minutes.");
      } else {
        localStorage.setItem(lockKeyFor(em), JSON.stringify({ count }));
        setErr(`${error.message} (Attempt ${count} of 5)`);
      }
    } else {
      localStorage.removeItem(lockKeyFor(em));
    }
    setBusy(false);
  }
  async function forgot() {
    if (!email.trim()) { setErr("Enter your email first, then press Forgot password."); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (error) setErr(error.message);
    else setOk("Password reset email sent — please check the inbox.");
  }
  return (
    <div className="loginwrap">
      <form className="logincard" onSubmit={signIn}>
        <div style={{ fontSize: 26, fontWeight: 800 }}><span className="loginmark">✚</span>MediCore</div>
        <p className="muted" style={{ marginTop: 2 }}>Medical POS & Clinic Management</p>
        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        {ok && <div className="ok" style={{ marginBottom: 10 }}>{ok}</div>}
        {locked && <div className="err" style={{ marginBottom: 10 }}>🔒 Too many failed attempts — sign-in is locked for {lockText}.</div>}
        <div style={{ marginBottom: 10 }}><label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@alshifa.pk" required disabled={locked} /></div>
        <div style={{ marginBottom: 14 }}><label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={locked} /></div>
        <button className="btn" style={{ width: "100%" }} disabled={busy || locked}>{locked ? `Locked — ${lockText}` : busy ? "Signing in…" : "Sign In"}</button>
        <button type="button" className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={forgot}>Forgot password</button>
      </form>
    </div>
  );
}

/* ---- TOTP 2FA gate — Super Admin ONLY ----
   After password sign-in, a super_admin session must reach AAL2
   before the app renders anything:
   - no verified TOTP factor yet -> mandatory enrollment: enroll(),
     show the QR (totp.qr_code is an SVG data URI) + the secret for
     manual entry, then challenge() + verify() with the 6-digit code
   - a verified factor exists but the session is still AAL1 ->
     challenge() + verify() only
   Any other role never sees this component. Sign out is always
   available as an escape. */
function SuperAdminMfaGate({ onPassed }) {
  const [phase, setPhase] = useState("checking"); // checking | enroll | challenge | error
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalErr) throw aalErr;
        if (aal?.currentLevel === "aal2") { if (live) onPassed(); return; }
        const { data: lf, error: lfErr } = await supabase.auth.mfa.listFactors();
        if (lfErr) throw lfErr;
        const verified = (lf?.totp ?? []).find((fa) => fa.status === "verified");
        if (verified) { if (live) { setFactorId(verified.id); setPhase("challenge"); } return; }
        // Remove any abandoned unverified TOTP factors, then enroll fresh.
        for (const fa of (lf?.all ?? []).filter((x) => x.factor_type === "totp" && x.status !== "verified")) {
          try { await supabase.auth.mfa.unenroll({ factorId: fa.id }); } catch { /* best effort */ }
        }
        const { data: enr, error: enrErr } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "MediCore Super Admin" });
        if (enrErr) throw enrErr;
        if (live) { setFactorId(enr.id); setQr(enr.totp.qr_code); setSecret(enr.totp.secret); setPhase("enroll"); }
      } catch (e) { if (live) { setErr(e.message ?? String(e)); setPhase("error"); } }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
      if (chErr) throw chErr;
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: code.trim() });
      if (vErr) throw vErr;
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === "aal2") onPassed();
      else throw new Error("The code was accepted but the session did not reach AAL2 — please try again.");
    } catch (e2) { setErr(e2.message ?? String(e2)); }
    setBusy(false);
  }

  return (
    <div className="loginwrap">
      <div className="logincard">
        <div style={{ fontSize: 24, fontWeight: 800 }}>🔐 Super Admin — 2FA</div>
        <p className="muted" style={{ marginTop: 2 }}>Two-factor authentication is required for the platform account.</p>
        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        {phase === "checking" && <p className="muted">Checking 2FA status…</p>}
        {phase === "error" && <p className="muted">2FA could not continue because of the error above. Refresh the page and try again.</p>}
        {(phase === "enroll" || phase === "challenge") && (
          <form onSubmit={verify}>
            {phase === "enroll" ? (
              <>
                <p style={{ marginTop: 0 }}><b>Step 1:</b> Scan this QR code with an authenticator app (Google Authenticator / Microsoft Authenticator):</p>
                {qr && (
                  <div style={{ textAlign: "center", margin: "10px 0" }}>
                    <img src={qr} alt="TOTP QR code" style={{ width: 180, height: 180, background: "#fff", padding: 8, border: "1px solid var(--line)", borderRadius: 10 }} />
                  </div>
                )}
                <p className="muted" style={{ fontSize: 13 }}>If you cannot scan the QR, enter this secret manually: <code style={{ wordBreak: "break-all" }}>{secret}</code></p>
                <p style={{ marginBottom: 6 }}><b>Step 2:</b> Enter the 6-digit code shown in the app:</p>
              </>
            ) : (
              <p style={{ marginTop: 0 }}>Enter the <b>6-digit code</b> for MediCore from your authenticator app:</p>
            )}
            <div style={{ marginBottom: 12 }}><label>6-digit code</label>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" required /></div>
            <button className="btn" style={{ width: "100%" }} disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : phase === "enroll" ? "Complete setup" : "Verify"}
            </button>
          </form>
        )}
        <button type="button" className="btn ghost" style={{ width: "100%", marginTop: 10 }} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [fatal, setFatal] = useState("");
  const [page, setPage] = useState("dashboard");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    (async () => {
      const { data, error } = await supabase
        .from("user_profiles").select("*").eq("id", session.user.id).maybeSingle();
      if (error) setFatal(error.message);
      else if (!data) setFatal("No profile found for this account. Please contact the administrator.");
      else { setFatal(""); setProfile(data); }
    })();
  }, [session]);

  /* ---- Subscription enforcement: a suspended tenant, or a latest
     subscription that has ended, blocks the whole app for that clinic's
     users (super_admin is never blocked). No module renders — and so no
     module data loads — until this check has passed. ---- */
  const [subChecked, setSubChecked] = useState(false);
  const [subBlock, setSubBlock] = useState(null);
  useEffect(() => {
    if (!profile) { setSubChecked(false); setSubBlock(null); return; }
    if (profile.role === "super_admin" || !profile.tenant_id) { setSubChecked(true); setSubBlock(null); return; }
    let live = true;
    (async () => {
      try {
        const { data: tenant } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).maybeSingle();
        const { data: subs, error: subErr } = await supabase.from("subscriptions")
          .select("*").eq("tenant_id", profile.tenant_id)
          .order("ends_on", { ascending: false }).limit(1);
        if (!live) return;
        const today = new Date().toISOString().slice(0, 10);
        if (tenant && tenant.status === "suspended") {
          setSubBlock({ clinic: tenant.name, reason: "suspended", endsOn: subs?.[0]?.ends_on ?? null });
        } else if (!subErr && subs && subs.length) {
          const s = subs[0];
          if ((s.ends_on && s.ends_on < today) || ["expired", "cancelled", "suspended"].includes(s.status)) {
            setSubBlock({ clinic: tenant?.name ?? "Clinic", reason: "expired", endsOn: s.ends_on ?? null });
          }
        }
        setSubChecked(true);
      } catch { if (live) setSubChecked(true); }
    })();
    return () => { live = false; };
  }, [profile]);

  /* ---- TOTP 2FA gate state (Super Admin only). Reset whenever the
     signed-in user changes, so a fresh password sign-in must pass
     the gate again; a same-user session refresh (e.g. the token
     refresh after MFA verify) does not reset it. ---- */
  const [mfaOk, setMfaOk] = useState(false);
  useEffect(() => { setMfaOk(false); }, [session?.user?.id]);

  /* ---- Phase 3: module gating. Tenant users lose the nav entries of
     optional modules their clinic switched off in Settings
     (settings key 'enabled_modules'; see OPTIONAL_MODULES in
     modules.jsx). Default rule (moduleEnabled): key absent or a module
     missing => ENABLED, and a failed read also leaves everything on.
     PRIVACY LOCKDOWN (supersedes the old Phase-3 super_admin bypass):
     super_admin has no clinical/financial modules in its nav at all —
     it is platform-only — so there is nothing left to bypass, and the
     gating read is skipped for it. The read re-runs on page change,
     so a toggle an admin just saved in Settings applies as soon as
     they navigate. ---- */
  const [enabledMods, setEnabledMods] = useState(null);
  useEffect(() => {
    if (!profile || profile.role === "super_admin" || !profile.tenant_id) { setEnabledMods(null); return; }
    let live = true;
    supabase.from("settings").select("value")
      .eq("tenant_id", profile.tenant_id).eq("key", "enabled_modules").maybeSingle()
      .then(({ data }) => { if (live) setEnabledMods(data?.value ?? null); })
      .catch(() => { if (live) setEnabledMods(null); });
    return () => { live = false; };
  }, [profile, page]);

  /* ---- Session timeout: sign out after 30 minutes of inactivity,
     with a warning 1 minute before. Any activity resets the timer. ---- */
  const [idleWarn, setIdleWarn] = useState(false);
  const lastActRef = useRef(Date.now());
  useEffect(() => {
    if (!session) { setIdleWarn(false); return; }
    lastActRef.current = Date.now();
    const bump = () => { lastActRef.current = Date.now(); setIdleWarn(false); };
    const events = ["mousedown", "keydown", "touchstart", "click"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      const idle = Date.now() - lastActRef.current;
      if (idle >= 30 * 60 * 1000) supabase.auth.signOut();
      else if (idle >= 29 * 60 * 1000) setIdleWarn(true);
    }, 10000);
    return () => { events.forEach((e) => window.removeEventListener(e, bump)); clearInterval(iv); };
  }, [session]);
  const idleBanner = idleWarn ? (
    <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 18, zIndex: 60, background: "#fef3c7", border: "1px solid #f59e0b", color: "#92400e", borderRadius: 10, padding: "10px 14px", display: "flex", gap: 12, alignItems: "center", boxShadow: "0 10px 30px rgba(0,0,0,.25)" }}>
      <span>⚠ You have been inactive for 30 minutes — you will be signed out automatically in 1 minute.</span>
      <button className="btn small" onClick={() => { lastActRef.current = Date.now(); setIdleWarn(false); }}>Stay signed in</button>
    </div>
  ) : null;

  if (!ready) return <div style={{ padding: 30 }} className="muted">Loading…</div>;
  if (!session) return <Login />;
  if (profile && !subChecked) return <div style={{ padding: 30 }} className="muted">Loading…</div>;
  if (profile && subBlock) {
    return (
      <div className="loginwrap">
        <div className="logincard" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>🔒</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>Subscription {subBlock.reason === "suspended" ? "Suspended" : "Expired"}</div>
          <p className="muted">
            <b>{subBlock.clinic}</b>'s MediCore subscription {subBlock.reason === "suspended" ? "has been suspended" : "has expired"}
            {subBlock.endsOn ? <> (end date: {subBlock.endsOn})</> : null}.
            Access is paused. Please contact the platform admin to renew.
          </p>
          <button className="btn" style={{ width: "100%" }} onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  /* Super Admin must clear the TOTP gate before anything renders. */
  if (profile?.role === "super_admin" && !mfaOk) {
    return <SuperAdminMfaGate onPassed={() => setMfaOk(true)} />;
  }

  if (profile?.role === "display" && page !== "tv") {
    return (
      <div>
        <TvBoard profile={profile} />
        {idleBanner}
        <div style={{ position: "fixed", bottom: 12, right: 12 }}>
          <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  const nav = NAV.filter((n) => profile && n.roles.includes(profile.role) && moduleEnabled(enabledMods, n.key));
  /* If the open page is not in the (role + module) filtered nav — e.g.
     its module was just switched off — fall back to the role's home
     instead of rendering a screen the clinic disabled (Platform
     Dashboard for super_admin, Dashboard for everyone else). "tv" is
     a core module rendered full-screen above and is never gated. */
  const homeKey = HOME_BY_ROLE[profile?.role] ?? "dashboard";
  const activePage = page === "tv" || nav.some((n) => n.key === page) ? page : homeKey;
  const view = {
    dashboard: <Dashboard profile={profile ?? {}} />,
    tokens: <Tokens profile={profile ?? {}} />,
    patients: <Patients profile={profile ?? {}} />,
    doctor: <CareQueue profile={profile ?? {}} title="Doctor — Consultation Queue" />,
    nursing: <CareQueue profile={profile ?? {}} title="Nursing — Patient Queue" />,
    pharmacy: <Pharmacy profile={profile ?? {}} />,
    lab: <Lab profile={profile ?? {}} />,
    operations: <Operations profile={profile ?? {}} />,
    finance: <Finance />,
    hr: <HR profile={profile ?? {}} session={session} />,
    reports: <Reports />,
    tv: <Tokens profile={profile ?? {}} tvMode />,
    settings: <Settings profile={profile ?? {}} session={session} />,
    myprofile: <MyProfile profile={profile ?? {}} />,
    platform: <PlatformDashboard />,
    tenants: <PlatformTenants session={session} />,
    plans: <PlatformPlans />,
    subscriptions: <PlatformSubscriptions />,
    users: <PlatformUsers profile={profile ?? {}} session={session} />,
    catalog: <PlatformCatalog profile={profile} />,
  }[activePage] ?? <Dashboard profile={profile ?? {}} />;

  if (page === "tv" && profile) {
    return (
      <div>
        <TvBoard profile={profile} />
        {idleBanner}
        <div style={{ position: "fixed", bottom: 12, right: 12 }}>
          <button className="btn ghost" onClick={() => setPage("dashboard")}>← Back to app</button>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
    <PrintProvider tenantId={profile?.tenant_id ?? null}>
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brandmark">✚</span>MediCore<small>MEDICAL POS · CLINIC SUITE</small></div>
        {profile && <div className="navsec">{profile.role === "super_admin" ? "Platform" : "Clinic"}</div>}
        {nav.map((n) => (
          <button key={n.key} className={`navitem ${activePage === n.key ? "active" : ""}`} onClick={() => setPage(n.key)}>{n.icon ? <span className="nic">{n.icon}</span> : null}{n.label}</button>
        ))}
        <div className="sideuser" style={{ marginTop: 18, padding: "10px", borderTop: "1px solid #164e5e" }}>
          {profile?.avatar_url ? <img src={profile.avatar_url} alt="" style={{ width: 46, height: 46, borderRadius: "50%", objectFit: "cover", marginBottom: 6 }} /> : null}
          <div style={{ fontWeight: 700, color: "#fff" }}>{profile?.full_name ?? "…"}</div>
          <div style={{ fontSize: 12 }} className="muted">{profile?.email ?? ""}</div>
          <div style={{ fontSize: 12 }}>{profile?.role ?? ""}</div>
          <button className="btn small" style={{ marginTop: 10 }} onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {fatal ? <div className="err">{fatal}</div> : profile ? view : <p className="muted">Loading profile…</p>}
      </main>
      {idleBanner}
    </div>
    </PrintProvider>
    </ToastProvider>
  );
}
