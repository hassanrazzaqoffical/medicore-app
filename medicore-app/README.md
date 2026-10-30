# MediCore — Standalone App (Downloadable Project)

Ye MediCore ki **screens wali app** ka apna project hai — yehi app
jo Muse par hosted hai, usi design aur flow ke saath, lekin ab
**aap ke apne computer par chalegi** aur seedha aap ke Supabase
project se connect hogi.

## Chalane ka tareeka (sirf 3 step)

Zaroori: computer par **Node.js** laga ho (nodejs.org se LTS wala).

1. Is folder mein terminal / PowerShell kholo.
2. Pehli dafa sirf ye command chalao:
   `npm install`
3. Phir jab bhi chalana ho:
   `npm run dev`
   Browser mein ye address kholo: **http://localhost:5173**

Band karne ke liye terminal mein `Ctrl + C` dabao.

## Login

Wohi accounts jo hosted app ke hain — masalan:

- Clinic Admin (Al-Shifa): `admin@alshifa.pk` / `Demo@12345`
- Doctor: `doctor@alshifa.pk` · Nurse: `nurse@alshifa.pk`
- Super Admin: `admin@medicore.pk` / `Demo@12345`
- TV board ke liye: `display@alshifa.pk`

(Asal istemal se pehle ye demo passwords lazmi badal dein.)

## Connection

App pehle se aap ke live Supabase project par set hai
(`gpxtcbeovvjypwbsnlor.supabase.co`). Settings `src/supabaseClient.js`
mein hain, ya `.env` file se badli ja sakti hain (dekho `.env.example`).
Sirf **publishable key** istemal hoti hai — service_role key is app
mein kabhi nahi aati; wo sirf Edge Function ke andar rehti hai.

## Kya kya shamil hai

- Real login (Supabase Auth), role ke hisaab se menu aur dashboards
- Tokens: token issue (number khud lagta hai), OPD fee Finance
  mein auto-post, live queue (5 second refresh). **One-step
  Patient + Token:** "New patient" mode mein naam (lazmi), phone,
  age, gender likh kar aik hi click mein patient bhi ban jata hai
  aur token bhi issue ho jata hai. Phone pehle se kisi patient ka
  ho to app warn karti hai aur purana record istemal karne ka
  option deti hai (khamoshi se duplicate nahi banta)
- TV Queue Board (display account se khud khul jata hai)
- Patients: add + list
- Doctor aur Nursing queues: Start / Complete
- Pharmacy POS: sale (oversell database se block), stock, low-stock
  aur expiring alerts
- Finance: invoices, revenue hisaab, payments (Cash Book)
- HR: staff directory, attendance — manual buttons aur QR scan
  (jahan browser BarcodeDetector + camera support kare; staff QR
  mein sirf staff id hota hai), salary sirf authorized roles ko
- Lab orders list + effective lab test price list, Reports,
  Settings se naye users banana (create-clinic-user Edge Function
  ke zariye)
- Settings → **Fees & Prices** (sirf Clinic Admin / Super Admin):
  OPD fee aur follow-up fee clinic ke hisaab se badlein (settings
  key `fee_setup` — Token screen foran nayi fee dikhati hai). Lab
  test prices bhi yahin se control hoti hain (settings key
  `lab_prices`): pehli dafa built-in list se editor bharta hai,
  phir admin price badal sakta hai, naya test add kar sakta hai,
  test hata sakta hai. Jahan lab fee lagti/dikhti hai, pehle clinic
  ki saved price, warna built-in list, warna labelled standard fee
- Settings → **Hospital type & departments (Phase 1):** 20 hospital
  types mein se aik ya zyada chunein, aik ko Primary mark karein
  (settings key `hospital_types`). "Apply templates" se chuni hui
  types ke departments `departments` table mein add ho jate hain —
  jo pehle se hain wo skip (idempotent). Departments ki list,
  custom department add karna, rename aur deactivate bhi yahin se
  hota hai. Yehi departments Token screen ke dropdown mein ate
  hain.
- Settings → **Specialties & Services (Phase 2A):** usi "Hospital
  type & departments" hisse mein har department ke andar
  specialties, aur har specialty ke andar clinical services
  add/rename/remove karein. Clinic ki apni list settings key
  `specialty_catalog` mein department id ke hisaab se rehti hai.
  "Load template suggestions" mashhoor departments (masalan General
  Ophthalmology, General Cardiology, Gynecology, Radiology waghera)
  ke liye tayyar specialty names bhar deta hai — sirf un departments
  ke liye jin ke paas abhi koi specialty nahi (idempotent);
  services templates se nahi atin, wo admin khud add karta hai.
- Settings → **Doctor assignments (Phase 2A):** har doctor ko
  departments aur specialties assign karein (settings key
  `doctor_assignments`). Token screen par department chunte hi
  Doctor dropdown sirf us department ke assigned doctors dikhata
  hai — basharte ke koi doctor us department ko assigned ho; warna
  tamam doctors nazar ate hain (khaali dead-end kabhi nahi). Token
  screen par department ki specialties mein se aik **optional
  Specialty** bhi chuni ja sakti hai — wo token ki receipt aur
  "abhi issue hua" bar par print/dikhti hai (token record par save
  nahi hoti)
- **Token doctor mapping (bug fix):** database mein `tokens.doctor_id`
  asal mein **staff table** ki taraf ishara karta hai, user profile ki
  taraf nahi. Is liye Token screen doctor select hone par us ke
  profile id ko `staff_directory.user_profile_id` ke zariye staff id
  mein badal kar bhejti hai (warna token 409 FK error se fail ho
  jata tha). Jis doctor ki staff entry (HR) maujood na ho, us ke
  liye token baghair doctor ke issue ho jata hai aur screen par
  note nazar ata hai — queue kabhi rukti nahi. Token lists/receipts
  par doctor ka naam bhi staff record se resolve hota hai.
- **Operations (OT) — Phase 2B:** operation schedule karein —
  patient, procedure ka naam (lazmi), department, surgeon, OT room,
  date/time, fee aur notes; patient chunein to us ke **aaj ke tokens**
  mein se aik token bhi link kar sakte hain (optional — token na ho
  to bhi operation schedule ho jata hai). List mein aaj ke aur aane
  wale operations pehle (waqt ke hisaab se), phir purane. Har
  operation par **Start → Complete**, ya **Cancel**; record delete
  sirf Clinic Admin kar sakta hai; operation slip print bhi hoti
  hai. Data `operations` table mein rehta hai (RLS: sirf apni
  clinic ka data; likhne ka haq sirf Clinic Admin / Doctor / Nurse
  ko). **Note:** operation ki fee sirf operation record par rehti
  hai — OPD/lab ki tarah is ke liye koi trigger nahi hai, is liye
  app is ki invoice/payment NAHI banata.
- **Modules on/off — Phase 3:** har clinic apne ghair-zaroori
  optional modules — **Lab, Nursing, HR & Attendance, Operations
  (OT)** — Settings → "Modules on/off" card se band kar sakta hai;
  band module us clinic ke tamam staff ke menu se gayab ho jata
  hai (doosri clinics par koi asar nahi). Core modules — Dashboard,
  Tokens, Live Queue/TV Board, Patients, Doctor, Pharmacy,
  Finance, Reports, Settings — kabhi band nahi hote. Setting
  per-clinic settings key `enabled_modules` mein save hoti hai,
  sirf Clinic Admin badal sakta hai. **Default rule:** jo module
  kabhi save na ho wo **ON** rehta hai — koi clinic setting save
  kiye baghair koi screen nahi khota. TV/Display board is bandish
  se mutasir nahi hota. (Super Admin ab platform-only hai — purana
  "super admin ko sab nazar aata hai" wala bypass khatam; neeche
  Privacy lockdown dekhein.)
- Settings: clinic branding/receipts, apni clinic ka poora backup
  ZIP download (har table ki CSV), "Sync to Sheets" button
  (sheets-sync Edge Function) with last-sync time
- **Privacy lockdown — Super Admin sirf platform:**
  - Super Admin (platform owner) ko kisi clinic ka andar ka data —
    patients, visits, consultations, prescriptions, lab, invoices,
    payments, payroll, staff ki salary/CNIC (`staff_private`) —
    **database (RLS) level par band** hai; sirf app mein chhupaya
    nahi gaya. App mein bhi Super Admin ki screens sirf platform
    wali hain: **Platform Dashboard, Tenants, Plans, Subscriptions,
    Users**. Platform Dashboard par har clinic ki sirf **ginati
    (counts)** — users, patients, pichle 30 din ke tokens/invoices
    (`platform_usage_stats()` function se, jo sirf super_admin ko
    rows deta hai) — aur subscription ki halat nazar ati hai;
    row-level clinic data kabhi nahi.
  - **Support Access:** support ke liye clinic ka apna Clinic
    Admin Settings → "Support Access" card se Super Admin ko
    **waqti** ijazat de sakta hai — duration 1 hour, 6 hours,
    24 hours, 3 days ya zyada se zyada **7 din** (database bhi
    7 din se zyada allow nahi karta). Muddat khatam hote hi rasaai
    **khud band** ho jati hai, aur beech mein **Revoke** bhi ho
    sakti hai. Super Admin khud grant nahi bana sakta — Platform
    Dashboard par usay sirf active grants ki list (clinic, reason,
    expiry) read-only nazar ati hai.
  - **Users:** Super Admin ab kisi ka password **set nahi** karta
    — "Set password" tool khatam kar diya gaya hai. Us ke bajaye
    **Send reset email** (admin-user-ops Edge Function ki
    `send_reset` action) — user apna password khud rakhta hai.
    Super Admin sirf **Clinic Admin** accounts bana sakta hai;
    clinic ke andar ke users us clinic ka apna admin banata hai.
    Super Admin ke tamam actions (user create / delete / reset)
    **audit log** mein record hote hain, aur audit_logs append-only
    hain — update/delete sab ke liye band hai.
  - **2FA (Super Admin ke liye lazmi):** Super Admin ke login par
    **TOTP two-factor authentication** ka gate hai — password ke
    baad authenticator app (Google Authenticator / Microsoft
    Authenticator) ka 6-digit code dena padta hai, warna app nahi
    khulti. Pehli dafa QR code scan karke setup hota hai (secret
    manually likhne ka option bhi hai). Baqi tamam roles par koi
    2FA gate nahi hai.
- Login hifazat: 5 ghalat koshishon par 5 minute lockout (countdown
  ke sath), 30 minute inactivity par auto sign-out (1 minute pehle
  warning)
- Subscription bandish: clinic suspend ho ya subscription khatam,
  to us clinic ke users ko login ke baad block screen milti hai —
  koi data load nahi hota

## Token fee — zaroori note

OPD fee ki invoice aur cash payment ab **database trigger**
(`post_opd_fee_for_token`) khud banata hai, token insert hote hi.
Is liye app token issue karte waqt **apni taraf se invoice NAHI
banata** — warna har fee Finance mein double count hogi. App sirf
trigger ki bani hui invoice parh kar receipt par dikhata hai.
Fee 0 ho to koi invoice nahi banti.

## Farq jo zehen mein rakhein

- Ye hosted app ka **dobara banaya hua downloadable version** hai —
  saare asal kaam (data, login, hisaab) wohi hain, lekin chhoti
  designing tafseelat mein mamuli farq ho sakta hai.
- Print abhi browser ke print (Save as PDF) se hota hai.
- Local chalane par internet lazmi hai, kyunke data aap ke
  Supabase (cloud) mein rehta hai.
