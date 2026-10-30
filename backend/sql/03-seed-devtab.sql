-- ============================================================
-- MediCore SEED \u2014 run in Supabase SQL Editor AFTER the main schema
-- and the security hardening patch. Safe to re-run (idempotent-ish).
-- Creates: 2 clinics (Al-Shifa Lahore, City Care Multan), one Auth
-- user per role per clinic + super_admin + TV display users,
-- departments + fee setup, staff (+ salary/CNIC in staff_private),
-- sample patients, medicines/batches, wards/beds, shifts, tokens.
-- Password for ALL seed users: MediCore@123  (change after login)
-- ============================================================

-- ---------- 1. Tenants (fixed UUIDs so tests can reference them) ----------
insert into public.tenants (id, name, slug, city, phone, email, address, status) values
  ('11111111-1111-4111-8111-111111111111', 'Al-Shifa Medical Centre', 'al-shifa-lahore', 'Lahore', '042-3577-1234', 'info@alshifa.pk', 'Main Boulevard, Gulberg III, Lahore', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'City Care Clinic', 'city-care-multan', 'Multan', '061-651-2233', 'care@citycare.pk', 'Bosan Road, Multan', 'active')
on conflict (id) do nothing;
-- Note: the tenant INSERT trigger auto-seeds role_permissions (default-DENY matrix).

-- ---------- 2. Subscriptions ----------
insert into public.subscriptions (tenant_id, plan_id, status, starts_on, ends_on, amount_pkr)
select '11111111-1111-4111-8111-111111111111', id, 'active', current_date, current_date + interval '1 year', price_pkr
from public.plans where name = 'Pro'
  and not exists (select 1 from public.subscriptions where tenant_id = '11111111-1111-4111-8111-111111111111');
insert into public.subscriptions (tenant_id, plan_id, status, starts_on, ends_on, amount_pkr)
select '22222222-2222-4222-8222-222222222222', id, 'active', current_date, current_date + interval '1 year', price_pkr
from public.plans where name = 'Basic'
  and not exists (select 1 from public.subscriptions where tenant_id = '22222222-2222-4222-8222-222222222222');

-- ---------- 3. Departments + fee setup (settings: department_fees) ----------
insert into public.departments (tenant_id, name, code)
select t.id, d.name, d.code from public.tenants t
cross join (values ('General OPD','OPD'), ('Gynae','GYN'), ('Paeds','PED'), ('Dental','DEN'), ('Emergency','ER')) as d(name, code)
where t.id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')
on conflict (tenant_id, name) do nothing;

insert into public.settings (tenant_id, key, value)
select id, 'department_fees', '{"General OPD":800,"Gynae":1200,"Paeds":800,"Dental":1000,"Emergency":1500}'::jsonb
from public.tenants where id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')
on conflict (tenant_id, key) do update set value = excluded.value;

-- ---------- 4. Auth users + profiles (one per role per clinic) ----------
-- Users are created directly in auth.users with a bcrypt password.
-- This only works from the SQL Editor (postgres role). The app itself
-- creates users ONLY through the create-clinic-user Edge Function.
do $$
declare
  u record;
  v_tenant_a uuid := '11111111-1111-4111-8111-111111111111';
  v_tenant_b uuid := '22222222-2222-4222-8222-222222222222';
begin
  for u in select * from (values
    ('a0000000-0000-4000-8000-000000000001'::uuid, 'super@medicore.pk',   'Hassan \u2014 Platform Owner', 'super_admin',    null),
    ('a0000000-0000-4000-8000-000000000101'::uuid, 'admin@alshifa.pk',    'Dr. Ayesha Khan',         'clinic_admin',   v_tenant_a),
    ('a0000000-0000-4000-8000-000000000102'::uuid, 'doctor@alshifa.pk',   'Dr. Ahmed Raza',          'doctor',         v_tenant_a),
    ('a0000000-0000-4000-8000-000000000103'::uuid, 'nurse@alshifa.pk',    'Nurse Sana Tariq',        'nurse',          v_tenant_a),
    ('a0000000-0000-4000-8000-000000000104'::uuid, 'pharmacy@alshifa.pk', 'Bilal Hussain',           'pharmacist',     v_tenant_a),
    ('a0000000-0000-4000-8000-000000000105'::uuid, 'token@alshifa.pk',    'Maryam Aslam',            'token_operator', v_tenant_a),
    ('a0000000-0000-4000-8000-000000000106'::uuid, 'accounts@alshifa.pk', 'Usman Ali',               'accountant',     v_tenant_a),
    ('a0000000-0000-4000-8000-000000000107'::uuid, 'hr@alshifa.pk',       'Hira Shah',               'hr_manager',     v_tenant_a),
    ('a0000000-0000-4000-8000-000000000108'::uuid, 'lab@alshifa.pk',      'Kamran Iqbal',            'lab_operator',   v_tenant_a),
    ('a0000000-0000-4000-8000-000000000109'::uuid, 'tv@alshifa.pk',       'Al-Shifa TV Board',       'display',        v_tenant_a),
    ('a0000000-0000-4000-8000-000000000201'::uuid, 'admin@citycare.pk',   'Dr. Mahnoor Fatima',      'clinic_admin',   v_tenant_b),
    ('a0000000-0000-4000-8000-000000000202'::uuid, 'doctor@citycare.pk',  'Dr. Bilal Ahmed',         'doctor',         v_tenant_b),
    ('a0000000-0000-4000-8000-000000000203'::uuid, 'nurse@citycare.pk',   'Nurse Areeba Khan',       'nurse',          v_tenant_b),
    ('a0000000-0000-4000-8000-000000000204'::uuid, 'pharmacy@citycare.pk','Hamza Sheikh',            'pharmacist',     v_tenant_b),
    ('a0000000-0000-4000-8000-000000000205'::uuid, 'token@citycare.pk',   'Zainab Bibi',             'token_operator', v_tenant_b),
    ('a0000000-0000-4000-8000-000000000206'::uuid, 'accounts@citycare.pk','Ali Raza',                'accountant',     v_tenant_b),
    ('a0000000-0000-4000-8000-000000000207'::uuid, 'hr@citycare.pk',      'Sadia Malik',             'hr_manager',     v_tenant_b),
    ('a0000000-0000-4000-8000-000000000208'::uuid, 'lab@citycare.pk',     'Waqas Ahmad',             'lab_operator',   v_tenant_b),
    ('a0000000-0000-4000-8000-000000000209'::uuid, 'tv@citycare.pk',      'City Care TV Board',      'display',        v_tenant_b)
  ) as v(id, email, full_name, role, tenant_id)
  loop
    if not exists (select 1 from auth.users where email = u.email) then
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
        created_at, updated_at, last_sign_in_at, confirmation_token, recovery_token,
        email_change_token_new, email_change)
      values (u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        u.email, crypt('MediCore@123', gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', u.full_name, 'role', u.role, 'tenant_id', u.tenant_id),
        false, now(), now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
      values (u.id, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
        'email', u.id::text, now(), now(), now());
    end if;
    insert into public.user_profiles (id, tenant_id, role, full_name, email, is_active)
    values (u.id, u.tenant_id, u.role, u.full_name, u.email, true)
    on conflict (id) do update set role = excluded.role, tenant_id = excluded.tenant_id, full_name = excluded.full_name;
  end loop;
end $$;

-- ---------- 5. Staff rows (+ private salary/CNIC) from profiles ----------
insert into public.staff (tenant_id, user_profile_id, full_name, role, designation, phone, email)
select p.tenant_id, p.id, p.full_name, p.role,
  case p.role when 'doctor' then 'Consultant' when 'nurse' then 'Staff Nurse'
    when 'pharmacist' then 'Pharmacist' when 'token_operator' then 'Receptionist'
    when 'accountant' then 'Accountant' when 'hr_manager' then 'HR Manager'
    when 'lab_operator' then 'Lab Technologist' when 'clinic_admin' then 'Clinic Admin'
    else 'Display' end,
  '0300-1001' || right(p.email, 3), p.email
from public.user_profiles p
where p.tenant_id is not null
  and not exists (select 1 from public.staff s where s.user_profile_id = p.id);

insert into public.staff_private (staff_id, tenant_id, cnic, basic_salary, doctor_share_percent)
select s.id, s.tenant_id,
  '35202-' || lpad((row_number() over (order by s.id))::text, 7, '0') || '-1',
  case s.role when 'doctor' then 280000 when 'clinic_admin' then 350000 when 'accountant' then 90000
    when 'hr_manager' then 85000 when 'pharmacist' then 75000 when 'lab_operator' then 70000
    when 'nurse' then 65000 when 'token_operator' then 48000 else 40000 end,
  case when s.role = 'doctor' then 40 else 0 end
from public.staff s
on conflict (staff_id) do nothing;

-- One extra doctor for Al-Shifa (Gynae) without a login
insert into public.staff (tenant_id, full_name, role, designation, phone, email)
select '11111111-1111-4111-8111-111111111111', 'Dr. Fatima Noor', 'doctor', 'Gynaecologist', '0300-1001102', 'fatima@alshifa.pk'
where not exists (select 1 from public.staff where email = 'fatima@alshifa.pk');

-- ---------- 6. Shifts ----------
insert into public.shifts (tenant_id, name, start_time, end_time)
select t.id, s.name, s.st, s.et from public.tenants t
cross join (values ('Morning','08:00','14:00'), ('Evening','14:00','20:00'), ('Night','20:00','08:00')) as s(name, st, et)
where t.id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')
  and not exists (select 1 from public.shifts x where x.tenant_id = t.id and x.name = s.name);

-- ---------- 7. Sample patients ----------
insert into public.patients (tenant_id, mr_number, full_name, gender, age_years, phone, city, blood_group, allergies) values
  ('11111111-1111-4111-8111-111111111111','MRN-1001','Muhammad Iqbal','Male',54,'0300-1112233','Lahore','B+','Penicillin'),
  ('11111111-1111-4111-8111-111111111111','MRN-1002','Amina Bibi','Female',29,'0321-4455667','Lahore','O+',''),
  ('11111111-1111-4111-8111-111111111111','MRN-1003','Ali Hassan','Male',8,'0333-7788990','Lahore','A+',''),
  ('11111111-1111-4111-8111-111111111111','MRN-1004','Shazia Parveen','Female',41,'0345-2233445','Lahore','AB-','Sulfa'),
  ('11111111-1111-4111-8111-111111111111','MRN-1005','Chaudhry Naseer','Male',67,'0301-9988776','Lahore','O-',''),
  ('22222222-2222-4222-8222-222222222222','MRN-2001','Rukhsana Kausar','Female',36,'0308-2223344','Multan','B-',''),
  ('22222222-2222-4222-8222-222222222222','MRN-2002','Imran Haider','Male',45,'0322-9988112','Multan','A-',''),
  ('22222222-2222-4222-8222-222222222222','MRN-2003','Noor Fatima','Female',12,'0334-6677889','Multan','O+','')
on conflict (tenant_id, mr_number) do nothing;

-- ---------- 8. Medicines + batches (FEFO: earliest expiry first) ----------
insert into public.medicines (tenant_id, name, generic_name, barcode, category, unit, reorder_level, sale_price, purchase_price) values
  ('11111111-1111-4111-8111-111111111111','Paracetamol 500mg','Paracetamol','896400001001','Analgesic','tablet',20,60,38),
  ('11111111-1111-4111-8111-111111111111','Amoxicillin 250mg','Amoxicillin','896400001002','Antibiotic','capsule',20,180,120),
  ('11111111-1111-4111-8111-111111111111','Cetirizine 10mg','Cetirizine','896400001003','Antihistamine','tablet',20,90,55),
  ('11111111-1111-4111-8111-111111111111','Omeprazole 20mg','Omeprazole','896400001004','PPI','capsule',20,220,145),
  ('11111111-1111-4111-8111-111111111111','ORS Sachet','Oral Rehydration Salts','896400001005','Electrolyte','sachet',20,45,25),
  ('22222222-2222-4222-8222-222222222222','Paracetamol 500mg','Paracetamol','896400001001','Analgesic','tablet',20,65,40),
  ('22222222-2222-4222-8222-222222222222','Ibuprofen 400mg','Ibuprofen','896400001006','NSAID','tablet',20,120,80),
  ('22222222-2222-4222-8222-222222222222','Cetirizine 10mg','Cetirizine','896400001003','Antihistamine','tablet',20,95,58)
on conflict (tenant_id, barcode) do nothing;

insert into public.medicine_batches (tenant_id, medicine_id, batch_no, expiry_date, quantity, purchase_price, sale_price)
select m.tenant_id, m.id, b.no, b.exp::date, b.qty, m.purchase_price, m.sale_price
from public.medicines m
join (values
  ('Paracetamol 500mg','PC-2601','2027-06-30',480), ('Paracetamol 500mg','PC-2512','2026-12-31',120),
  ('Amoxicillin 250mg','AM-118','2026-11-15',14), ('Cetirizine 10mg','CT-77','2027-03-31',260),
  ('Omeprazole 20mg','OM-31','2027-01-31',190), ('ORS Sachet','OR-09','2026-11-30',8),
  ('Ibuprofen 400mg','IB-01','2027-05-31',150)
) as b(med, no, exp, qty) on b.med = m.name
on conflict (tenant_id, medicine_id, batch_no) do nothing;

-- ---------- 9. Suppliers, wards, beds ----------
insert into public.suppliers (tenant_id, name, phone, balance_pkr) values
  ('11111111-1111-4111-8111-111111111111','Pharma Distributors Lahore','042-3722-8899',45000),
  ('22222222-2222-4222-8222-222222222222','Multan MedSupply','061-622-7788',12000)
on conflict do nothing;

insert into public.wards (tenant_id, name, ward_type, total_beds)
select '11111111-1111-4111-8111-111111111111','General Ward A','General',4
where not exists (select 1 from public.wards where tenant_id = '11111111-1111-4111-8111-111111111111' and name = 'General Ward A');

insert into public.beds (tenant_id, ward_id, bed_number, status, patient_id)
select w.tenant_id, w.id, b.num,
  case when b.num in ('A-1','A-4') then 'occupied' else 'available' end,
  case when b.num = 'A-1' then (select id from public.patients where tenant_id = w.tenant_id and mr_number = 'MRN-1001')
       when b.num = 'A-4' then (select id from public.patients where tenant_id = w.tenant_id and mr_number = 'MRN-1005') end
from public.wards w cross join (values ('A-1'),('A-2'),('A-3'),('A-4')) as b(num)
where w.tenant_id = '11111111-1111-4111-8111-111111111111' and w.name = 'General Ward A'
on conflict (tenant_id, ward_id, bed_number) do nothing;

-- ---------- 10. Today's queue for Al-Shifa + matching OPD invoices ----------
insert into public.tokens (tenant_id, token_number, token_date, patient_id, department_id, doctor_id, status, fee_pkr)
select t.tenant_id, v.num, current_date, p.id, d.id, s.id, v.st, v.fee
from (values
  ('MRN-1001','General OPD','doctor@alshifa.pk',1,'calling',800),
  ('MRN-1002','Gynae','fatima@alshifa.pk',1,'waiting',1200),
  ('MRN-1003','Paeds','doctor@alshifa.pk',1,'waiting',800),
  ('MRN-1004','General OPD','doctor@alshifa.pk',2,'waiting',800)
) as v(mrn, dept, doc_email, num, st, fee)
join public.patients p on p.mr_number = v.mrn and p.tenant_id = '11111111-1111-4111-8111-111111111111'
join public.departments d on d.name = v.dept and d.tenant_id = p.tenant_id
join public.staff s on s.email = v.doc_email and s.tenant_id = p.tenant_id
cross join lateral (select p.tenant_id) t
on conflict (tenant_id, token_date, department_id, token_number) do nothing;

insert into public.invoices (tenant_id, invoice_number, patient_id, invoice_type, subtotal, total_amount, amount_paid, balance_amount, status)
select tk.tenant_id, 'SEED-OPD-' || tk.token_number || '-' || coalesce(p.mr_number,'X'), tk.patient_id, 'opd',
  tk.fee_pkr, tk.fee_pkr, tk.fee_pkr, 0, 'paid'
from public.tokens tk join public.patients p on p.id = tk.patient_id
where tk.tenant_id = '11111111-1111-4111-8111-111111111111' and tk.token_date = current_date
on conflict (tenant_id, invoice_number) do nothing;

insert into public.notifications (tenant_id, type, title, message)
select '11111111-1111-4111-8111-111111111111','low_stock','Low stock: Amoxicillin 250mg','Only 14 left (reorder at 20)'
where not exists (select 1 from public.notifications where tenant_id = '11111111-1111-4111-8111-111111111111' and type = 'low_stock');

-- ---------- DONE ----------
-- Test logins (password for all: MediCore@123):
--   Platform : super@medicore.pk (super_admin, no tenant)
--   Al-Shifa : admin@ / doctor@ / nurse@ / pharmacy@ / token@ /
--              accounts@ / hr@ / lab@ / tv@  ->  @alshifa.pk
--   City Care: same local parts @citycare.pk
