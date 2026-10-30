-- ============================================================
-- MediCore Security Hardening Patch (run AFTER the main schema,
-- BEFORE the seed). Single copy-paste block for the SQL Editor.
-- 1) has_permission: default-DENY + per-tenant matrix auto-seed
-- 2) Salary / CNIC moved to staff_private (restricted roles only)
-- 3) Same-tenant enforcement for child-table foreign keys
-- 4) Delete restricted to clinic_admin (and super_admin)
-- 5) TV queue board: dedicated display role, no anon access
-- ============================================================

-- ---------- 1A. has_permission becomes default-DENY ----------
create or replace function public.has_permission(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from public.role_permissions
    where tenant_id = public.current_tenant_id()
      and role = public.current_app_role()
      and module = p_module
      and allowed = true
      and (action = p_action or action = 'manage')
  )
$$;

delete from public.role_permissions where action = 'delete' and role <> 'clinic_admin';
delete from public.role_permissions where role in ('nurse', 'token_operator') and module in ('finance', 'hr');

-- ---------- 1B. Default permission matrix (seed function) ----------
create or replace function public.seed_role_permissions(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as
$$
begin
  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'clinic_admin', m, a, true
  from unnest(array['dashboard','tokens','patients','consultations','prescriptions','nursing','pharmacy','lab','finance','hr','reports','settings']) as m
  cross join unnest(array['view','create','edit','delete']) as a
  on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'doctor', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view'),
    ('patients','view'),('patients','edit'),
    ('consultations','view'),('consultations','create'),('consultations','edit'),
    ('prescriptions','view'),('prescriptions','create'),('prescriptions','edit'),
    ('pharmacy','view'),('lab','view'),('lab','create'),('nursing','view'),('reports','view')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'nurse', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view'),
    ('patients','view'),('patients','edit'),
    ('nursing','view'),('nursing','create'),('nursing','edit'),
    ('prescriptions','view'),('pharmacy','view'),('lab','view'),('reports','view')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'pharmacist', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view'),
    ('patients','view'),('reports','view'),
    ('pharmacy','view'),('pharmacy','create'),('pharmacy','edit'),
    ('prescriptions','view'),('prescriptions','edit')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'token_operator', v.module, v.action, true from (values
    ('dashboard','view'),('settings','view'),
    ('tokens','view'),('tokens','create'),('tokens','edit'),
    ('patients','view'),('patients','create')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'accountant', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view'),
    ('patients','view'),('pharmacy','view'),('hr','view'),
    ('finance','view'),('finance','create'),('finance','edit'),
    ('reports','view'),('reports','create'),('reports','edit')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'hr_manager', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view'),('reports','view'),
    ('hr','view'),('hr','create'),('hr','edit'),
    ('finance','view'),('finance','create'),('finance','edit')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'lab_operator', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view'),
    ('patients','view'),('consultations','view'),('reports','view'),
    ('lab','view'),('lab','create'),('lab','edit')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;

  insert into public.role_permissions (tenant_id, role, module, action, allowed)
  select p_tenant_id, 'display', v.module, v.action, true from (values
    ('dashboard','view'),('tokens','view'),('settings','view')
  ) as v(module, action) on conflict (tenant_id, role, module, action) do nothing;
end
$$;

-- ---------- 1C. Auto-seed the matrix for every new tenant ----------
create or replace function public.trg_seed_permissions_on_tenant() returns trigger
language plpgsql security definer set search_path = public as
$$ begin perform public.seed_role_permissions(new.id); return new; end $$;

drop trigger if exists trg_tenants_seed_permissions on public.tenants;
create trigger trg_tenants_seed_permissions after insert on public.tenants
  for each row execute function public.trg_seed_permissions_on_tenant();

do $$
declare t uuid;
begin
  for t in select id from public.tenants loop
    perform public.seed_role_permissions(t);
  end loop;
end $$;

-- ---------- 1D. Delete is clinic_admin-only on every tenant table ----------
do $$
declare t text; cond text;
begin
  cond := 'public.is_super_admin() or (tenant_id = public.current_tenant_id() and public.current_app_role() = ''clinic_admin'')';
  foreach t in array array['subscriptions','departments','role_permissions','settings','staff','patients','visits','tokens','queue_events','vitals','consultations','medicines','suppliers','medicine_batches','stock_movements','purchase_orders','purchase_items','prescriptions','prescription_items','lab_orders','lab_results','wards','beds','nursing_notes','medication_administration','sales','sale_items','returns','invoices','payments','expenses','doctor_commissions','shifts','attendance','duty_roster','leave_requests','payroll','notifications']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', t || '_delete', t, cond);
  end loop;
end $$;

-- ---------- 2A. staff_private: salary and CNIC leave the staff table ----------
create table if not exists public.staff_private (
  staff_id uuid primary key references public.staff(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cnic text, basic_salary numeric(12,2) not null default 0,
  doctor_share_percent numeric(5,2) not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'basic_salary') then
    insert into public.staff_private (staff_id, tenant_id, cnic, basic_salary, doctor_share_percent)
    select id, tenant_id, cnic, coalesce(basic_salary, 0), coalesce(doctor_share_percent, 0) from public.staff
    on conflict (staff_id) do nothing;
  end if;
end $$;

alter table public.staff drop column if exists cnic;
alter table public.staff drop column if exists basic_salary;
alter table public.staff drop column if exists doctor_share_percent;

drop trigger if exists trg_staff_private_updated on public.staff_private;
create trigger trg_staff_private_updated before update on public.staff_private
  for each row execute function public.set_updated_at();

alter table public.staff_private enable row level security;
create index if not exists idx_staff_private_tenant on public.staff_private (tenant_id);
drop policy if exists staff_private_select on public.staff_private;
create policy staff_private_select on public.staff_private for select to authenticated
  using (public.is_super_admin() or (tenant_id = public.current_tenant_id() and public.current_app_role() in ('hr_manager','accountant','clinic_admin')));
drop policy if exists staff_private_insert on public.staff_private;
create policy staff_private_insert on public.staff_private for insert to authenticated
  with check (public.is_super_admin() or (tenant_id = public.current_tenant_id() and public.current_app_role() in ('hr_manager','accountant','clinic_admin')));
drop policy if exists staff_private_update on public.staff_private;
create policy staff_private_update on public.staff_private for update to authenticated
  using (public.is_super_admin() or (tenant_id = public.current_tenant_id() and public.current_app_role() in ('hr_manager','accountant','clinic_admin')))
  with check (public.is_super_admin() or (tenant_id = public.current_tenant_id() and public.current_app_role() in ('hr_manager','accountant','clinic_admin')));
drop policy if exists staff_private_delete on public.staff_private;
create policy staff_private_delete on public.staff_private for delete to authenticated
  using (public.is_super_admin() or (tenant_id = public.current_tenant_id() and public.current_app_role() = 'clinic_admin'));

-- ---------- 2B. staff_directory view: safe columns for every clinic role ----------
create or replace view public.staff_directory with (security_barrier = true) as
select id, tenant_id, user_profile_id, department_id, full_name, role, designation,
       phone, email, joining_date, is_active
from public.staff
where public.is_super_admin() or tenant_id = public.current_tenant_id();

revoke all on public.staff_directory from anon;
grant select on public.staff_directory to authenticated;

-- ---------- 3. Same-tenant foreign keys (composite FKs) ----------
do $$
declare t text;
begin
  foreach t in array array['departments','staff','patients','visits','tokens','medicines','suppliers','medicine_batches','purchase_orders','prescriptions','prescription_items','consultations','lab_orders','wards','sales','invoices','shifts']
  loop
    begin
      execute format('alter table public.%I add constraint %I unique (tenant_id, id)', t, 'uq_' || t || '_tenant_id');
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('visits','patient_id','patients'),('visits','department_id','departments'),('visits','doctor_id','staff'),
    ('tokens','patient_id','patients'),('tokens','visit_id','visits'),('tokens','department_id','departments'),('tokens','doctor_id','staff'),
    ('queue_events','token_id','tokens'),
    ('vitals','patient_id','patients'),('vitals','visit_id','visits'),('vitals','token_id','tokens'),
    ('consultations','patient_id','patients'),('consultations','visit_id','visits'),('consultations','token_id','tokens'),('consultations','doctor_id','staff'),
    ('medicine_batches','medicine_id','medicines'),('medicine_batches','supplier_id','suppliers'),
    ('stock_movements','medicine_id','medicines'),('stock_movements','batch_id','medicine_batches'),
    ('purchase_orders','supplier_id','suppliers'),
    ('purchase_items','purchase_order_id','purchase_orders'),('purchase_items','medicine_id','medicines'),
    ('prescriptions','consultation_id','consultations'),('prescriptions','patient_id','patients'),('prescriptions','doctor_id','staff'),
    ('prescription_items','prescription_id','prescriptions'),('prescription_items','medicine_id','medicines'),
    ('lab_orders','patient_id','patients'),('lab_orders','visit_id','visits'),('lab_orders','consultation_id','consultations'),('lab_orders','ordered_by','staff'),
    ('lab_results','lab_order_id','lab_orders'),('lab_results','patient_id','patients'),
    ('beds','ward_id','wards'),('beds','patient_id','patients'),
    ('nursing_notes','patient_id','patients'),('nursing_notes','visit_id','visits'),('nursing_notes','nurse_id','staff'),
    ('medication_administration','patient_id','patients'),('medication_administration','prescription_id','prescriptions'),
    ('medication_administration','prescription_item_id','prescription_items'),('medication_administration','medicine_id','medicines'),
    ('sales','patient_id','patients'),('sales','prescription_id','prescriptions'),
    ('sale_items','sale_id','sales'),('sale_items','medicine_id','medicines'),('sale_items','batch_id','medicine_batches'),
    ('returns','sale_id','sales'),('returns','medicine_id','medicines'),('returns','batch_id','medicine_batches'),
    ('invoices','patient_id','patients'),('invoices','visit_id','visits'),('invoices','sale_id','sales'),
    ('payments','invoice_id','invoices'),('payments','sale_id','sales'),
    ('doctor_commissions','doctor_id','staff'),
    ('staff','department_id','departments'),('staff_private','staff_id','staff'),
    ('attendance','staff_id','staff'),
    ('duty_roster','staff_id','staff'),('duty_roster','shift_id','shifts'),('duty_roster','department_id','departments'),
    ('leave_requests','staff_id','staff'),('payroll','staff_id','staff')
  ) as v(child_tbl, fk_col, parent_tbl) loop
    begin
      execute format('alter table public.%I add constraint %I foreign key (tenant_id, %I) references public.%I (tenant_id, id)',
        r.child_tbl, 'fk_tenant_' || r.child_tbl || '_' || r.fk_col, r.fk_col, r.parent_tbl);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- 5. TV queue board: display role, no anon access ----------
alter table public.user_profiles drop constraint if exists user_profiles_role_check;
alter table public.user_profiles add constraint user_profiles_role_check
  check (role in ('super_admin','clinic_admin','doctor','nurse','pharmacist','token_operator','accountant','hr_manager','lab_operator','display'));
alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check
  check (role in ('super_admin','clinic_admin','doctor','nurse','pharmacist','token_operator','accountant','hr_manager','lab_operator','display'));

do $$
declare t uuid;
begin
  for t in select id from public.tenants loop
    perform public.seed_role_permissions(t);
  end loop;
end $$;

create or replace view public.tv_queue_board with (security_barrier = true) as
select tok.id, tok.tenant_id, tok.token_number, tok.token_date,
       tok.department_id, dep.name as department_name,
       tok.doctor_id, st.full_name as doctor_name,
       tok.status, tok.priority, tok.created_at
from public.tokens tok
left join public.departments dep on dep.id = tok.department_id
left join public.staff st on st.id = tok.doctor_id
where tok.token_date = current_date
  and (public.is_super_admin() or tok.tenant_id = public.current_tenant_id());

revoke all on public.tv_queue_board from anon;
grant select on public.tv_queue_board to authenticated;
revoke all on all tables in schema public from anon;
grant select on public.tv_queue_board to authenticated;
grant select on public.staff_directory to authenticated;

-- ============================================================
-- End of patch. Next: run the Seed SQL, then deploy the
-- create-clinic-user Edge Function.
-- ============================================================
