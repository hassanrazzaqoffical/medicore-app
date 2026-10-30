# MediCore — Local Run Guide (Backend Pack)

Ye ZIP tumhare MediCore system ka **backend pack** hai: database SQL,
Edge Function, settings file aur hidayat. App ki screens wala hissa
Muse par hosted hai (Library > Artifacts se khulta hai) aur isi
Supabase backend se connected hai — is liye ye pack wohi cheez hai jo
local chalane ke liye asal mein chahiye hoti hai.

## Is pack mein kya hai
- `README.md` — system ki tafseel aur connection status
- `.env.example` — Supabase URL / keys ki settings (service_role sirf server par)
- `TEST-LOGINS.txt` — is pack ke seed ke test accounts
- `sql/02-hardening-patch.sql` — security patch (default-DENY permissions, staff_private, display role)
- `sql/03-seed-devtab.sql` — demo data: 2 clinics, users, patients, medicines
- `supabase/functions/create-clinic-user/index.ts` — app se naye users banane wala Edge Function

## Ek zaroori note (seed ke baare mein)
Tum ne apne live project par **chat wala seed** chalaya tha
(password Demo@12345, display@ wale accounts). Is pack ka seed
Developer-tab wala hai (password MediCore@123, tv@ wale accounts).
**Dono seed ek hi project par mat chalana** — sirf ek chuno.
Live project ke liye kuch badalne ki zaroorat nahi; ye pack sirf
local copy / backup ke liye hai.

## Local par chalane ka tareeka (apne PC par poora backend)
Zaroori cheezen: **Docker Desktop** aur **Supabase CLI**
(Windows par: `winget install Supabase.CLI` ya supabase.com/docs se).

1. Is ZIP ko ek folder mein kholo (extract), phir us folder mein
   terminal / PowerShell kholo.
2. Apne live project se main schema ki file nikalo (ye command
   tumhare mojooda project ka poora database structure le aati hai):
   `supabase login`
   `supabase link --project-ref gpxtcbeovvjypwbsnlor`
   `supabase db dump -f sql/01-main-schema.sql`
3. Local Supabase shuru karo:
   `supabase init`  (agar config pehle se na ho)
   `supabase start`
   Aakhir mein local keys aur address print honge — unhe note kar lo.
   Local dashboard: http://127.0.0.1:54323
4. Local dashboard ke **SQL Editor** mein files is tartib se chalao:
   pehle `sql/01-main-schema.sql`, phir `sql/02-hardening-patch.sql`,
   phir `sql/03-seed-devtab.sql`.
5. Edge Function local par chalao:
   `supabase functions serve create-clinic-user`
6. `.env.example` ko `.env` bana kar local values bhar do
   (local URL aam tor par http://127.0.0.1:54321 hota hai; keys
   `supabase start` wale output se milti hain).

## Rukna / band karna
`supabase stop` — local backend band ho jata hai, data mehfooz rehta hai.

## Live project (jo abhi chal raha hai)
Tumhara asal system isi address par hai:
https://gpxtcbeovvjypwbsnlor.supabase.co
App Muse ki Library > Artifacts > "Medical POS & Clinic Management
System" se khulti hai aur isi backend se connected hai. Local copy
sirf test / backup ke liye hai — asal clinic ka kaam live wale par hoga.
