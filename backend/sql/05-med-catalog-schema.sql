-- ============================================================
-- MediCore Medicine Catalog — Phase 1: global catalog schema
-- + category taxonomy (17 parent categories, 155 subcategories).
-- NEW global reference tables only (prefix med_). The existing
-- per-tenant pharmacy (medicines, medicine_batches, suppliers,
-- stock_movements, POS) is NOT changed, except one nullable link
-- column on medicines (catalog_product_id) for later phases.
-- Global catalog: readable by every signed-in clinic user;
-- writable ONLY by super_admin, and only in an aal2 (TOTP)
-- session — same helpers as the platform tables.
-- Idempotent: safe to re-run. Run in the Supabase SQL Editor.
-- ============================================================

create extension if not exists pg_trgm;

-- ---------- Category taxonomy (hierarchical) ----------
create table if not exists public.med_categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.med_categories(id),
  slug text not null unique,
  name text not null,
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists med_categories_parent_idx on public.med_categories (parent_id);

-- ---------- Ingredients (INN) ----------
create table if not exists public.med_ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null unique,
  created_at timestamptz not null default now()
);

-- ---------- Generic-level medicine identity ----------
-- One row per generic / fixed combination. Brand names do NOT
-- create new identities; they live in med_products.
create table if not exists public.med_medicines (
  id uuid primary key default gen_random_uuid(),
  generic_name text not null,
  normalized_name text not null unique,
  atc_code text,
  pharm_class text,
  therapeutic_class text,
  category_id uuid references public.med_categories(id),
  indications text,
  contraindications text,
  warnings text,
  common_adverse_effects text,
  serious_adverse_effects text,
  interactions text,
  allergy_alerts text,
  pregnancy_info text,
  lactation_info text,
  pediatric_notes text,
  geriatric_notes text,
  storage_requirements text,
  is_controlled boolean not null default false,
  status text not null default 'pending_verification'
    check (status in ('verified','pending_verification','discontinued')),
  source_ref text,
  verified_at date,
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists med_medicines_category_idx on public.med_medicines (category_id);
create index if not exists med_medicines_name_trgm on public.med_medicines using gin (generic_name gin_trgm_ops);

-- ---------- Medicine <-> ingredient lines (with strengths) ----------
create table if not exists public.med_medicine_ingredients (
  id uuid primary key default gen_random_uuid(),
  medicine_id uuid not null references public.med_medicines(id) on delete cascade,
  ingredient_id uuid not null references public.med_ingredients(id),
  strength_value numeric(12,3),
  strength_unit text,
  unique (medicine_id, ingredient_id, strength_value, strength_unit)
);
create index if not exists med_med_ing_medicine_idx on public.med_medicine_ingredients (medicine_id);
create index if not exists med_med_ing_ingredient_idx on public.med_medicine_ingredients (ingredient_id);

-- ---------- Product variants (brand / SKU level) ----------
-- A variant is one medicine + brand + strength + form + pack.
-- Different strengths / forms / routes are NEVER merged.
-- Prices and registration numbers stay NULL unless sourced
-- and dated — nothing is invented.
create table if not exists public.med_products (
  id uuid primary key default gen_random_uuid(),
  medicine_id uuid not null references public.med_medicines(id) on delete cascade,
  brand_name text,
  manufacturer text,
  mah text,
  country_of_origin text,
  dosage_form text not null,
  route text,
  strength_text text not null,
  pack_size text,
  units_per_pack int,
  barcode text,
  registration_no text,
  registration_status text,
  rx_status text not null default 'rx'
    check (rx_status in ('otc','rx','controlled','hospital')),
  wholesale_price_pkr numeric(12,2),
  retail_price_pkr numeric(12,2),
  price_as_of date,
  shelf_life_months int,
  source_url text,
  status text not null default 'pending_verification'
    check (status in ('verified','pending_verification','discontinued')),
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists med_products_medicine_idx on public.med_products (medicine_id);
create unique index if not exists med_products_barcode_uniq on public.med_products (barcode) where barcode is not null;
create unique index if not exists med_products_variant_uniq on public.med_products
  (medicine_id, coalesce(brand_name, ''), strength_text, dosage_form, coalesce(pack_size, ''));
create index if not exists med_products_brand_trgm on public.med_products using gin (brand_name gin_trgm_ops);

-- ---------- Import batches (audit + rollback handle) ----------
create table if not exists public.med_import_batches (
  id uuid primary key default gen_random_uuid(),
  imported_by uuid references public.user_profiles(id),
  source_label text,
  file_name text,
  total_rows int not null default 0,
  inserted_count int not null default 0,
  updated_count int not null default 0,
  duplicate_count int not null default 0,
  rejected_count int not null default 0,
  errors jsonb,
  status text not null default 'completed'
    check (status in ('completed','failed','rolled_back')),
  created_at timestamptz not null default now()
);
-- Link the batch references now that the table exists.
alter table public.med_medicines drop constraint if exists med_medicines_import_batch_fk;
alter table public.med_medicines add constraint med_medicines_import_batch_fk
  foreign key (import_batch_id) references public.med_import_batches(id);
alter table public.med_products drop constraint if exists med_products_import_batch_fk;
alter table public.med_products add constraint med_products_import_batch_fk
  foreign key (import_batch_id) references public.med_import_batches(id);

-- ---------- Link from existing tenant medicines (nullable) ----------
alter table public.medicines add column if not exists catalog_product_id uuid references public.med_products(id);
create index if not exists medicines_catalog_product_idx on public.medicines (catalog_product_id);

-- ---------- RLS: global read, super_admin (aal2) write ----------
alter table public.med_categories enable row level security;
alter table public.med_ingredients enable row level security;
alter table public.med_medicines enable row level security;
alter table public.med_medicine_ingredients enable row level security;
alter table public.med_products enable row level security;
alter table public.med_import_batches enable row level security;

-- Catalog tables: any signed-in user may read; only super_admin may write.
drop policy if exists med_catalog_read on public.med_categories;
create policy med_catalog_read on public.med_categories for select to authenticated using (true);
drop policy if exists med_catalog_write on public.med_categories;
create policy med_catalog_write on public.med_categories for all to authenticated
  using (public.caller_is_super_admin()) with check (public.caller_is_super_admin());
drop policy if exists super_admin_requires_aal2 on public.med_categories;
create policy super_admin_requires_aal2 on public.med_categories as restrictive for all to authenticated
  using (public.super_admin_aal2_ok()) with check (public.super_admin_aal2_ok());

drop policy if exists med_catalog_read on public.med_ingredients;
create policy med_catalog_read on public.med_ingredients for select to authenticated using (true);
drop policy if exists med_catalog_write on public.med_ingredients;
create policy med_catalog_write on public.med_ingredients for all to authenticated
  using (public.caller_is_super_admin()) with check (public.caller_is_super_admin());
drop policy if exists super_admin_requires_aal2 on public.med_ingredients;
create policy super_admin_requires_aal2 on public.med_ingredients as restrictive for all to authenticated
  using (public.super_admin_aal2_ok()) with check (public.super_admin_aal2_ok());

drop policy if exists med_catalog_read on public.med_medicines;
create policy med_catalog_read on public.med_medicines for select to authenticated using (true);
drop policy if exists med_catalog_write on public.med_medicines;
create policy med_catalog_write on public.med_medicines for all to authenticated
  using (public.caller_is_super_admin()) with check (public.caller_is_super_admin());
drop policy if exists super_admin_requires_aal2 on public.med_medicines;
create policy super_admin_requires_aal2 on public.med_medicines as restrictive for all to authenticated
  using (public.super_admin_aal2_ok()) with check (public.super_admin_aal2_ok());

drop policy if exists med_catalog_read on public.med_medicine_ingredients;
create policy med_catalog_read on public.med_medicine_ingredients for select to authenticated using (true);
drop policy if exists med_catalog_write on public.med_medicine_ingredients;
create policy med_catalog_write on public.med_medicine_ingredients for all to authenticated
  using (public.caller_is_super_admin()) with check (public.caller_is_super_admin());
drop policy if exists super_admin_requires_aal2 on public.med_medicine_ingredients;
create policy super_admin_requires_aal2 on public.med_medicine_ingredients as restrictive for all to authenticated
  using (public.super_admin_aal2_ok()) with check (public.super_admin_aal2_ok());

drop policy if exists med_catalog_read on public.med_products;
create policy med_catalog_read on public.med_products for select to authenticated using (true);
drop policy if exists med_catalog_write on public.med_products;
create policy med_catalog_write on public.med_products for all to authenticated
  using (public.caller_is_super_admin()) with check (public.caller_is_super_admin());
drop policy if exists super_admin_requires_aal2 on public.med_products;
create policy super_admin_requires_aal2 on public.med_products as restrictive for all to authenticated
  using (public.super_admin_aal2_ok()) with check (public.super_admin_aal2_ok());

-- Import batches are platform-only data (not even readable by clinics).
drop policy if exists med_import_admin on public.med_import_batches;
create policy med_import_admin on public.med_import_batches for all to authenticated
  using (public.caller_is_super_admin()) with check (public.caller_is_super_admin());
drop policy if exists super_admin_requires_aal2 on public.med_import_batches;
create policy super_admin_requires_aal2 on public.med_import_batches as restrictive for all to authenticated
  using (public.super_admin_aal2_ok()) with check (public.super_admin_aal2_ok());

-- ---------- Taxonomy seed (idempotent) ----------
-- Subcategory slugs are computed from the names in SQL, so this
-- list only carries the names exactly as specified.
insert into public.med_categories (slug, name, sort) values
  ('pain-fever','Pain & Fever',1),
  ('antibiotics','Antibiotics & Antibacterials',2),
  ('antivirals-antifungals','Antivirals & Antifungals',3),
  ('cardiovascular','Cardiovascular Medicines',4),
  ('diabetes-endocrine','Diabetes & Endocrinology',5),
  ('gastroenterology','Gastroenterology',6),
  ('respiratory-allergy','Respiratory & Allergy',7),
  ('neuro-psychiatry','Neurology & Psychiatry',8),
  ('dermatology','Dermatology',9),
  ('eye-ent','Eye & ENT',10),
  ('renal-urology','Renal & Urology',11),
  ('obgyn-fertility','Obstetrics, Gynecology & Fertility',12),
  ('pediatrics','Pediatrics & Neonatology',13),
  ('oncology-hematology','Oncology & Hematology',14),
  ('emergency-critical-care','Emergency, Anesthesia & Critical Care',15),
  ('vitamins-nutrition','Vitamins, Minerals & Nutrition',16),
  ('vaccines-immunology','Vaccines, Immunology & Specialty Products',17)
on conflict (slug) do nothing;

insert into public.med_categories (parent_id, slug, name, sort)
select p.id,
       p.slug || '-' || trim(both '-' from regexp_replace(lower(replace(replace(c.name, '&', 'and'), '''', '')), '[^a-z0-9]+', '-', 'g')),
       c.name, c.sort
from (values
  ('pain-fever','Paracetamol / Acetaminophen',1),
  ('pain-fever','NSAIDs',2),
  ('pain-fever','Ibuprofen',3),
  ('pain-fever','Diclofenac',4),
  ('pain-fever','Naproxen',5),
  ('pain-fever','Ketorolac',6),
  ('pain-fever','Opioid Analgesics',7),
  ('pain-fever','Antispasmodics',8),
  ('antibiotics','Penicillins',1),
  ('antibiotics','Cephalosporins',2),
  ('antibiotics','Macrolides',3),
  ('antibiotics','Tetracyclines',4),
  ('antibiotics','Fluoroquinolones',5),
  ('antibiotics','Aminoglycosides',6),
  ('antibiotics','Carbapenems',7),
  ('antibiotics','Sulfonamides',8),
  ('antibiotics','Nitroimidazoles',9),
  ('antibiotics','Other Antibacterial Classes',10),
  ('antivirals-antifungals','Antiviral Medicines',1),
  ('antivirals-antifungals','Antiretroviral Medicines',2),
  ('antivirals-antifungals','Systemic Antifungals',3),
  ('antivirals-antifungals','Topical Antifungals',4),
  ('antivirals-antifungals','Antifungal Shampoos',5),
  ('antivirals-antifungals','Antiparasitic Medicines',6),
  ('antivirals-antifungals','Antimalarial Medicines',7),
  ('antivirals-antifungals','Antihelminthic Medicines',8),
  ('cardiovascular','Antihypertensives',1),
  ('cardiovascular','ACE Inhibitors',2),
  ('cardiovascular','ARBs',3),
  ('cardiovascular','Beta Blockers',4),
  ('cardiovascular','Calcium Channel Blockers',5),
  ('cardiovascular','Diuretics',6),
  ('cardiovascular','Antianginal Medicines',7),
  ('cardiovascular','Antiplatelets',8),
  ('cardiovascular','Anticoagulants',9),
  ('cardiovascular','Antiarrhythmics',10),
  ('cardiovascular','Lipid-Lowering Medicines',11),
  ('cardiovascular','Heart Failure Medicines',12),
  ('cardiovascular','Emergency Cardiovascular Medicines',13),
  ('diabetes-endocrine','Insulins',1),
  ('diabetes-endocrine','Biguanides',2),
  ('diabetes-endocrine','Sulfonylureas',3),
  ('diabetes-endocrine','DPP-4 Inhibitors',4),
  ('diabetes-endocrine','SGLT2 Inhibitors',5),
  ('diabetes-endocrine','GLP-1 Receptor Agonists',6),
  ('diabetes-endocrine','Other Antidiabetic Medicines',7),
  ('diabetes-endocrine','Thyroid Medicines',8),
  ('diabetes-endocrine','Corticosteroids',9),
  ('diabetes-endocrine','Hormonal Preparations',10),
  ('diabetes-endocrine','Other Endocrine Medicines',11),
  ('gastroenterology','Antacids',1),
  ('gastroenterology','Proton Pump Inhibitors',2),
  ('gastroenterology','H2 Blockers',3),
  ('gastroenterology','Antiemetics',4),
  ('gastroenterology','Laxatives',5),
  ('gastroenterology','Antidiarrheals',6),
  ('gastroenterology','Oral Rehydration Salts',7),
  ('gastroenterology','Antispasmodics',8),
  ('gastroenterology','Digestive Enzymes',9),
  ('gastroenterology','Inflammatory Bowel Disease Medicines',10),
  ('gastroenterology','Liver-Related Medicines',11),
  ('respiratory-allergy','Bronchodilators',1),
  ('respiratory-allergy','Inhaled Corticosteroids',2),
  ('respiratory-allergy','Combination Inhalers',3),
  ('respiratory-allergy','Antihistamines',4),
  ('respiratory-allergy','Nasal Sprays',5),
  ('respiratory-allergy','Decongestants',6),
  ('respiratory-allergy','Cough Preparations',7),
  ('respiratory-allergy','Mucolytics',8),
  ('respiratory-allergy','Asthma Medicines',9),
  ('respiratory-allergy','COPD Medicines',10),
  ('neuro-psychiatry','Antiepileptics',1),
  ('neuro-psychiatry','Antidepressants',2),
  ('neuro-psychiatry','Antipsychotics',3),
  ('neuro-psychiatry','Anxiolytics',4),
  ('neuro-psychiatry','Mood Stabilizers',5),
  ('neuro-psychiatry','Parkinson''s Disease Medicines',6),
  ('neuro-psychiatry','Migraine Medicines',7),
  ('neuro-psychiatry','Neuropathic Pain Medicines',8),
  ('neuro-psychiatry','Dementia Medicines',9),
  ('neuro-psychiatry','Sleep-Related Medicines',10),
  ('dermatology','Topical Corticosteroids',1),
  ('dermatology','Topical Antibiotics',2),
  ('dermatology','Antifungals',3),
  ('dermatology','Acne Medicines',4),
  ('dermatology','Psoriasis Medicines',5),
  ('dermatology','Emollients & Moisturizers',6),
  ('dermatology','Scabies & Lice Treatments',7),
  ('dermatology','Wound-Care Preparations',8),
  ('dermatology','Hair & Scalp Preparations',9),
  ('dermatology','Dermatological Antihistamines',10),
  ('dermatology','Pigmentation-Related Preparations',11),
  ('eye-ent','Ophthalmic Antibiotics',1),
  ('eye-ent','Ophthalmic Lubricants',2),
  ('eye-ent','Glaucoma Medicines',3),
  ('eye-ent','Mydriatics',4),
  ('eye-ent','Anti-Inflammatory Eye Drops',5),
  ('eye-ent','Antiallergic Eye Drops',6),
  ('eye-ent','Ear Drops',7),
  ('eye-ent','Nasal Preparations',8),
  ('eye-ent','ENT-Specific Medicines',9),
  ('renal-urology','Diuretics',1),
  ('renal-urology','Electrolyte Preparations',2),
  ('renal-urology','Renal-Related Medicines',3),
  ('renal-urology','Urinary Antiseptics',4),
  ('renal-urology','Prostate Medicines',5),
  ('renal-urology','Overactive Bladder Medicines',6),
  ('renal-urology','Erectile Dysfunction Medicines',7),
  ('renal-urology','Dialysis-Related Medicines',8),
  ('obgyn-fertility','Contraceptives',1),
  ('obgyn-fertility','Hormonal Preparations',2),
  ('obgyn-fertility','Fertility Medicines',3),
  ('obgyn-fertility','Prenatal Vitamins',4),
  ('obgyn-fertility','Uterotonic Medicines',5),
  ('obgyn-fertility','Gynecological Anti-Infectives',6),
  ('obgyn-fertility','Menopause-Related Medicines',7),
  ('pediatrics','Pediatric Formulations',1),
  ('pediatrics','Neonatal Medicines',2),
  ('pediatrics','Pediatric Antibiotics',3),
  ('pediatrics','Pediatric Antipyretics',4),
  ('pediatrics','Oral Rehydration Products',5),
  ('pediatrics','Pediatric Vitamins',6),
  ('pediatrics','Age-Appropriate Liquid Formulations',7),
  ('oncology-hematology','Antineoplastic Medicines',1),
  ('oncology-hematology','Chemotherapy Agents',2),
  ('oncology-hematology','Targeted Therapies',3),
  ('oncology-hematology','Immunotherapy Medicines',4),
  ('oncology-hematology','Hematopoietic Growth Factors',5),
  ('oncology-hematology','Hematinics',6),
  ('oncology-hematology','Iron Preparations',7),
  ('oncology-hematology','Hemophilia-Related Medicines',8),
  ('emergency-critical-care','Emergency Resuscitation Medicines',1),
  ('emergency-critical-care','Anesthetic Agents',2),
  ('emergency-critical-care','Sedatives',3),
  ('emergency-critical-care','Vasopressors',4),
  ('emergency-critical-care','Emergency Anticonvulsants',5),
  ('emergency-critical-care','Emergency Antidotes',6),
  ('emergency-critical-care','ICU Medicines',7),
  ('emergency-critical-care','IV Fluids & Electrolytes',8),
  ('vitamins-nutrition','Multivitamins',1),
  ('vitamins-nutrition','Vitamin B Complex',2),
  ('vitamins-nutrition','Vitamin B12',3),
  ('vitamins-nutrition','Vitamin D',4),
  ('vitamins-nutrition','Calcium',5),
  ('vitamins-nutrition','Iron',6),
  ('vitamins-nutrition','Zinc',7),
  ('vitamins-nutrition','Magnesium',8),
  ('vitamins-nutrition','Electrolyte Supplements',9),
  ('vitamins-nutrition','Enteral Nutritional Products',10),
  ('vaccines-immunology','Vaccines',1),
  ('vaccines-immunology','Immunoglobulins',2),
  ('vaccines-immunology','Immunosuppressants',3),
  ('vaccines-immunology','Immunomodulators',4),
  ('vaccines-immunology','Biological Medicines',5),
  ('vaccines-immunology','Specialty Injectable Products',6)
) as c(parent_slug, name, sort)
join public.med_categories p on p.slug = c.parent_slug
on conflict (slug) do nothing;

-- Rollback (only if ever needed):
-- drop table if exists public.med_import_batches cascade;
-- drop table if exists public.med_products cascade;
-- drop table if exists public.med_medicine_ingredients cascade;
-- drop table if exists public.med_medicines cascade;
-- drop table if exists public.med_ingredients cascade;
-- drop table if exists public.med_categories cascade;
-- alter table public.medicines drop column if exists catalog_product_id;
