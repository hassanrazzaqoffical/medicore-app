# MediCore

**Multi-tenant SaaS Medical POS & Clinic / Hospital Management System** built for clinics and hospitals in Pakistan (PKR, English UI).

🌐 **Live:** https://medicore-pk.vercel.app

MediCore runs the full patient visit on one linked record — **Token → Doctor → Prescription → Pharmacy / Lab → Bill → Finance** — so nothing is entered twice and every rupee posts to Finance automatically.

---

## What it does

| Module | Highlights |
|---|---|
| **Tokens / OPD** | One-step "Create patient + Issue token", per-department daily numbering, New visit / Follow-up fees, duplicate-phone warning, auto-printed token slip |
| **TV Queue Board** | Full-screen waiting-room display — NOW SERVING hero, up next, waiting strip, auto-refresh |
| **Patients** | Registration, MR numbers, search + server pagination, visit history |
| **Doctor** | Queue, consultations, prescriptions with a global medicine-catalog picker, allergy / ingredient alerts, follow-up dates |
| **Nursing** | Vitals, admitted patients, medication due, care queue |
| **Pharmacy POS** | Cart checkout, barcode scanning, FEFO batch picking, discount (% / Rs), Cash / Card / Credit, itemized receipts + reprint, stock movements, returns, low-stock alerts |
| **Laboratory** | Test orders with per-clinic prices, result entry with unit / reference range / High-Low flags, Pakistani-format A4 lab report, separate payment slip |
| **Finance** | Cash book (debit / credit), income & expense categories, salary approvals, invoice register with short display numbers (e.g. `OPD-0001`, `PH-…`) |
| **HR** | Staff records, departments & designations, duty roster, leaves, QR-code attendance, payroll & salary slips, salary advances |
| **Operations** | Procedure scheduling with automatic fee posting on completion |
| **Reports & Settings** | Clinic branding & receipt footers, Fees & Prices setup, clinic backup (ZIP export), Google Sheets one-way sync |
| **Platform (Super Admin)** | Tenants, plans & subscriptions with module gating, global medicine catalog + import centre, platform counts only — no access to clinic clinical/financial data |

## Roles & panels

Each role lands on its own fast dashboard and sees only its own screens — enforced in the **menu, the route, and the database (RLS)**:

`super_admin` · `clinic_admin` · `doctor` · `nurse` · `pharmacist` · `token_operator` · `accountant` · `hr_manager` · `lab_operator` · `display` (TV board) · `employee` (My Profile self-service: salary details, payslips, QR attendance)

## Tech stack

- **Frontend:** Vite + React (SPA), deployed on **Vercel**
- **Backend:** **Supabase** — PostgreSQL with Row Level Security, Auth, and Deno Edge Functions
- **Payments in-app:** Cash / Card / Credit recording (subscription billing is handled manually)

## Repository layout

```
medicore-app/   Frontend app (Vercel Root Directory points here)
backend/        Database SQL (schema, hardening, seed) and Edge Function sources
README-START-HERE.md   Original setup notes
```

## Run locally

```bash
cd medicore-app
npm install
npm run dev
```

The app reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the environment; without them it falls back to the project's hosted Supabase defaults baked into `src/supabaseClient.js`. Only the publishable (anon) key is ever used in the frontend — the `service_role` key exists **only** inside Edge Functions.

## Deployment

Push to `main` → Vercel builds from `medicore-app/` and deploys automatically to [medicore-pk.vercel.app](https://medicore-pk.vercel.app).

## Security model

- **Tenant isolation:** every clinic's data is scoped by `tenant_id`, enforced by restrictive RLS policies on all tenant tables — clinics cannot see each other's data, including through database views.
- **Super Admin privacy:** the platform owner sees counts and subscription state only. Clinical and financial rows are blocked at the database level.
- **Support access:** a clinic admin can grant the Super Admin time-boxed access to their clinic only (maximum 7 days), revocable instantly.
- **2FA:** Super Admin data and user management require an aal2 (TOTP) session.
- **Audit:** an append-only audit log records data changes.
- **Fee integrity:** OPD, lab, and operation fees are posted by database triggers, so invoices cannot be double-posted or skipped by the UI.

## Status

In production use by real clinics. Known scope notes: subscription payments are collected manually (no online gateway yet), printing uses the browser print pipeline (80mm + A4), and the queue board refreshes by polling.

---

**MediCore · Developed by Hassan Chand**
