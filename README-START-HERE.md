# MediCore — Complete Project Package

Ye ZIP poora project hai: app (medicore-app) + backend files (backend).
Database aur user accounts is ZIP mein nahi hain — wo aap ke Supabase
cloud project mein hain. Isi liye dusre computer par bhi wahi data aur
wahi logins chalenge; bas internet chahiye.

## Chalana (localhost par)
1. Node.js LTS install karein (nodejs.org se)
2. medicore-app folder ke andar terminal / CMD kholen
3. npm install        (sirf pehli dafa)
4. npm run dev
5. Terminal jo address de (maslan http://localhost:5173) browser mein kholen

## Hospital ki pehli setup
- Super Admin (admin@medicore.pk) se login karein, 2FA code dein
- Tenants mein apna hospital / clinic add karein
- Us clinic ke Clinic Admin se login karke Settings mein staff users banayein
- Seed / demo passwords zaroor badlein (sab accounts ke)
- Settings -> Clinic branding mein apna logo upload karein
- Waqt par Settings se Backup ZIP le kar mehfooz jagah rakhein

## backend/ folder (reference / backup)
- sql/ — database ki SQL files tartib se: hardening, seed, 2FA (aal2),
  medicine catalog schema (05) aur catalog seed (06)
- supabase/functions/ — Edge Functions v3: create-clinic-user,
  admin-user-ops, sheets-sync
- apps-script/Code.gs — Google Sheets sync script
Ye sab live system par pehle se laga hua hai; ye files sirf
backup aur dobara setup ke liye hain.




