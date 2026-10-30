/* Shared catalogs for MediCore — SINGLE source of truth.
   Used by Settings (fees, lab prices, hospital types & departments) and by
   the Lab screen. Do not copy these lists into individual components. */

/* ---------------- Lab test prices (built-in defaults) ----------------
   Per-tenant overrides live in the settings table under key 'lab_prices'
   (JSON map: test name -> price). Resolution order in labPriceInfo():
   clinic's saved price -> built-in list below -> STANDARD_LAB_FEE
   (clearly labelled as the standard fee wherever it is shown). */
export const STANDARD_LAB_FEE = 800;

export const BUILTIN_LAB_PRICES = [
  /* Hematology */
  { name: "CBC (Complete Blood Count)", price: 650, cat: "Hematology" },
  { name: "ESR", price: 300, cat: "Hematology" },
  { name: "Hemoglobin (Hb)", price: 250, cat: "Hematology" },
  { name: "Platelet Count", price: 300, cat: "Hematology" },
  { name: "Peripheral Blood Smear", price: 600, cat: "Hematology" },
  { name: "Reticulocyte Count", price: 800, cat: "Hematology" },
  { name: "Blood Group", price: 300, cat: "Hematology" },
  { name: "Cross Match", price: 800, cat: "Hematology" },
  { name: "Serum Ferritin", price: 1800, cat: "Hematology" },
  { name: "Serum Iron", price: 1200, cat: "Hematology" },
  { name: "TIBC", price: 1500, cat: "Hematology" },
  { name: "Coombs Test (Direct)", price: 900, cat: "Hematology" },
  { name: "G6PD Screening", price: 1500, cat: "Hematology" },
  { name: "Bone Marrow Examination", price: 5000, cat: "Hematology" },
  /* Biochemistry */
  { name: "LFT (Liver Function Test)", price: 1200, cat: "Biochemistry" },
  { name: "RFT (Urea & Creatinine)", price: 900, cat: "Biochemistry" },
  { name: "SGPT (ALT)", price: 400, cat: "Biochemistry" },
  { name: "SGOT (AST)", price: 400, cat: "Biochemistry" },
  { name: "Alkaline Phosphatase (ALP)", price: 400, cat: "Biochemistry" },
  { name: "Serum Bilirubin (Total & Direct)", price: 500, cat: "Biochemistry" },
  { name: "Serum Albumin", price: 400, cat: "Biochemistry" },
  { name: "Total Protein", price: 400, cat: "Biochemistry" },
  { name: "Serum Urea", price: 350, cat: "Biochemistry" },
  { name: "Serum Creatinine", price: 350, cat: "Biochemistry" },
  { name: "Serum Electrolytes", price: 800, cat: "Biochemistry" },
  { name: "Serum Sodium", price: 350, cat: "Biochemistry" },
  { name: "Serum Potassium", price: 350, cat: "Biochemistry" },
  { name: "Serum Chloride", price: 350, cat: "Biochemistry" },
  { name: "Serum Calcium", price: 500, cat: "Biochemistry" },
  { name: "Serum Phosphorus", price: 500, cat: "Biochemistry" },
  { name: "Serum Magnesium", price: 600, cat: "Biochemistry" },
  { name: "Uric Acid", price: 400, cat: "Biochemistry" },
  { name: "Serum Amylase", price: 700, cat: "Biochemistry" },
  { name: "Serum Lipase", price: 900, cat: "Biochemistry" },
  { name: "LDH", price: 800, cat: "Biochemistry" },
  { name: "CPK (Total)", price: 700, cat: "Biochemistry" },
  { name: "GGT", price: 500, cat: "Biochemistry" },
  { name: "Lipid Profile", price: 1500, cat: "Biochemistry" },
  { name: "Total Cholesterol", price: 500, cat: "Biochemistry" },
  { name: "Triglycerides", price: 500, cat: "Biochemistry" },
  { name: "HDL Cholesterol", price: 500, cat: "Biochemistry" },
  { name: "LDL Cholesterol", price: 500, cat: "Biochemistry" },
  /* Cardiac Markers */
  { name: "Troponin I", price: 2500, cat: "Cardiac Markers" },
  { name: "CK-MB", price: 1200, cat: "Cardiac Markers" },
  { name: "NT-proBNP", price: 4500, cat: "Cardiac Markers" },
  /* Diabetes */
  { name: "Blood Sugar Fasting", price: 200, cat: "Diabetes" },
  { name: "Blood Sugar Random", price: 200, cat: "Diabetes" },
  { name: "HbA1c", price: 1200, cat: "Diabetes" },
  { name: "Glucose Tolerance Test (GTT)", price: 900, cat: "Diabetes" },
  { name: "Urine Microalbumin", price: 1000, cat: "Diabetes" },
  /* Thyroid & Hormones */
  { name: "TFT (T3, T4, TSH)", price: 2500, cat: "Thyroid & Hormones" },
  { name: "TSH", price: 1200, cat: "Thyroid & Hormones" },
  { name: "T3 (Total)", price: 900, cat: "Thyroid & Hormones" },
  { name: "T4 (Total)", price: 900, cat: "Thyroid & Hormones" },
  { name: "Free T3", price: 1200, cat: "Thyroid & Hormones" },
  { name: "Free T4", price: 1200, cat: "Thyroid & Hormones" },
  { name: "Anti-TPO Antibodies", price: 2500, cat: "Thyroid & Hormones" },
  { name: "Testosterone (Total)", price: 2500, cat: "Thyroid & Hormones" },
  { name: "LH", price: 1800, cat: "Thyroid & Hormones" },
  { name: "FSH", price: 1800, cat: "Thyroid & Hormones" },
  { name: "Prolactin", price: 1800, cat: "Thyroid & Hormones" },
  { name: "Estradiol (E2)", price: 2200, cat: "Thyroid & Hormones" },
  { name: "Progesterone", price: 2200, cat: "Thyroid & Hormones" },
  { name: "Serum Cortisol", price: 2000, cat: "Thyroid & Hormones" },
  { name: "PTH (Intact)", price: 3000, cat: "Thyroid & Hormones" },
  /* Serology & Immunology */
  { name: "CRP", price: 900, cat: "Serology & Immunology" },
  { name: "Dengue NS1 Antigen", price: 1800, cat: "Serology & Immunology" },
  { name: "Dengue IgG / IgM", price: 2000, cat: "Serology & Immunology" },
  { name: "Malaria Parasite (MP)", price: 400, cat: "Serology & Immunology" },
  { name: "Typhidot", price: 700, cat: "Serology & Immunology" },
  { name: "Widal Test", price: 500, cat: "Serology & Immunology" },
  { name: "HBsAg (Hepatitis B)", price: 800, cat: "Serology & Immunology" },
  { name: "Anti-HCV (Hepatitis C)", price: 900, cat: "Serology & Immunology" },
  { name: "HIV Screening", price: 1000, cat: "Serology & Immunology" },
  { name: "ASO Titre", price: 800, cat: "Serology & Immunology" },
  { name: "RA Factor", price: 800, cat: "Serology & Immunology" },
  { name: "ANA (Antinuclear Antibody)", price: 2000, cat: "Serology & Immunology" },
  { name: "Anti-HAV IgM (Hepatitis A)", price: 1200, cat: "Serology & Immunology" },
  { name: "Anti-HEV IgM (Hepatitis E)", price: 1500, cat: "Serology & Immunology" },
  { name: "HBeAg", price: 1500, cat: "Serology & Immunology" },
  { name: "Anti-HBs", price: 1500, cat: "Serology & Immunology" },
  { name: "HBV DNA (PCR)", price: 6500, cat: "Serology & Immunology" },
  { name: "HCV RNA (PCR)", price: 6500, cat: "Serology & Immunology" },
  { name: "VDRL (Syphilis)", price: 600, cat: "Serology & Immunology" },
  { name: "H. Pylori Antibody", price: 1200, cat: "Serology & Immunology" },
  { name: "H. Pylori Stool Antigen", price: 1500, cat: "Serology & Immunology" },
  { name: "Chikungunya IgM", price: 2500, cat: "Serology & Immunology" },
  /* Microbiology & Cultures */
  { name: "Blood Culture & Sensitivity", price: 2500, cat: "Microbiology & Cultures" },
  { name: "Urine Culture & Sensitivity", price: 1500, cat: "Microbiology & Cultures" },
  { name: "Stool Culture & Sensitivity", price: 1500, cat: "Microbiology & Cultures" },
  { name: "Pus Culture & Sensitivity", price: 1800, cat: "Microbiology & Cultures" },
  { name: "Sputum Culture & Sensitivity", price: 1500, cat: "Microbiology & Cultures" },
  { name: "Throat Swab Culture", price: 1200, cat: "Microbiology & Cultures" },
  { name: "Wound Swab Culture", price: 1500, cat: "Microbiology & Cultures" },
  { name: "Sputum AFB (ZN Stain)", price: 500, cat: "Microbiology & Cultures" },
  { name: "Gram Stain", price: 400, cat: "Microbiology & Cultures" },
  { name: "CSF Culture & Sensitivity", price: 2500, cat: "Microbiology & Cultures" },
  { name: "Semen Culture & Sensitivity", price: 1500, cat: "Microbiology & Cultures" },
  /* Urine, Stool & Body Fluids */
  { name: "Urine DR (Urinalysis)", price: 400, cat: "Urine, Stool & Body Fluids" },
  { name: "Stool DR", price: 400, cat: "Urine, Stool & Body Fluids" },
  { name: "Stool for Occult Blood", price: 600, cat: "Urine, Stool & Body Fluids" },
  { name: "Stool Reducing Substances", price: 500, cat: "Urine, Stool & Body Fluids" },
  { name: "CSF DR (Routine Exam)", price: 1500, cat: "Urine, Stool & Body Fluids" },
  /* Pregnancy & Fertility */
  { name: "Beta hCG (Pregnancy)", price: 1200, cat: "Pregnancy & Fertility" },
  { name: "Urine Pregnancy Test", price: 300, cat: "Pregnancy & Fertility" },
  { name: "AMH (Anti-Mullerian Hormone)", price: 4500, cat: "Pregnancy & Fertility" },
  { name: "Semen Analysis", price: 1500, cat: "Pregnancy & Fertility" },
  /* Coagulation */
  { name: "PT / INR", price: 600, cat: "Coagulation" },
  { name: "APTT", price: 600, cat: "Coagulation" },
  { name: "D-Dimer", price: 2500, cat: "Coagulation" },
  { name: "Fibrinogen", price: 1500, cat: "Coagulation" },
  { name: "Bleeding & Clotting Time", price: 300, cat: "Coagulation" },
  /* Vitamins & Minerals */
  { name: "Vitamin D (25-OH)", price: 3500, cat: "Vitamins & Minerals" },
  { name: "Vitamin B12", price: 3000, cat: "Vitamins & Minerals" },
  { name: "Serum Folate", price: 2500, cat: "Vitamins & Minerals" },
  { name: "Serum Zinc", price: 2000, cat: "Vitamins & Minerals" },
  /* Tumor Markers */
  { name: "PSA (Total)", price: 2000, cat: "Tumor Markers" },
  { name: "AFP (Alpha-Fetoprotein)", price: 2000, cat: "Tumor Markers" },
  { name: "CEA", price: 2200, cat: "Tumor Markers" },
  { name: "CA-125", price: 2500, cat: "Tumor Markers" },
  { name: "CA 19-9", price: 2500, cat: "Tumor Markers" },
  /* Radiology & Imaging */
  { name: "ECG", price: 500, cat: "Radiology & Imaging" },
  { name: "Echocardiography (Echo)", price: 3500, cat: "Radiology & Imaging" },
  { name: "ETT (Stress Test)", price: 3000, cat: "Radiology & Imaging" },
  { name: "X-Ray Chest", price: 800, cat: "Radiology & Imaging" },
  { name: "X-Ray Abdomen (KUB)", price: 800, cat: "Radiology & Imaging" },
  { name: "X-Ray PNS (Sinuses)", price: 700, cat: "Radiology & Imaging" },
  { name: "X-Ray Knee Joint", price: 700, cat: "Radiology & Imaging" },
  { name: "X-Ray Lumbar Spine", price: 900, cat: "Radiology & Imaging" },
  { name: "X-Ray Hand", price: 600, cat: "Radiology & Imaging" },
  { name: "Ultrasound Abdomen", price: 1500, cat: "Radiology & Imaging" },
  { name: "Ultrasound Pelvis", price: 1500, cat: "Radiology & Imaging" },
  { name: "Ultrasound KUB", price: 1500, cat: "Radiology & Imaging" },
  { name: "Ultrasound Obstetric", price: 1800, cat: "Radiology & Imaging" },
  { name: "Ultrasound Thyroid", price: 2000, cat: "Radiology & Imaging" },
  { name: "Venous Doppler (One Leg)", price: 3500, cat: "Radiology & Imaging" },
  { name: "CT Scan Brain (Plain)", price: 4500, cat: "Radiology & Imaging" },
  { name: "CT Scan Abdomen (Contrast)", price: 8500, cat: "Radiology & Imaging" },
  { name: "CT Scan KUB", price: 6500, cat: "Radiology & Imaging" },
  { name: "MRI Brain (Plain)", price: 9500, cat: "Radiology & Imaging" },
  { name: "MRI Lumbar Spine", price: 9500, cat: "Radiology & Imaging" },
  { name: "Mammography", price: 3500, cat: "Radiology & Imaging" },
];

/* Effective price for one test. savedMap is the tenant's 'lab_prices'
   settings value (object map) or null. Returns { price, source } where
   source is 'clinic' | 'builtin' | 'standard'. Name matching is
   case-insensitive and ignores extra spaces. */
export function labPriceInfo(testName, savedMap) {
  const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const want = norm(testName);
  if (savedMap && typeof savedMap === "object") {
    for (const [k, v] of Object.entries(savedMap)) {
      if (norm(k) === want) return { price: Number(v) || 0, source: "clinic" };
    }
  }
  const b = BUILTIN_LAB_PRICES.find((t) => norm(t.name) === want);
  if (b) return { price: b.price, source: "builtin" };
  return { price: STANDARD_LAB_FEE, source: "standard" };
}

/* ---------------- Hospital types & department templates ---------------- */
export const HOSPITAL_TYPES = [
  "General Hospital",
  "Multi-Specialty Hospital",
  "Eye Hospital",
  "Cardiac / Heart Hospital",
  "Neurology & Neurosurgery Hospital",
  "Orthopedic Hospital",
  "Women & Maternity Hospital",
  "Children / Pediatric Hospital",
  "Dermatology / Skin Hospital",
  "Dental Hospital",
  "Kidney & Urology Hospital",
  "Cancer / Oncology Hospital",
  "Chest & Pulmonology Hospital",
  "Gastroenterology & Liver Hospital",
  "Mental Health / Psychiatric Hospital",
  "ENT Hospital",
  "Rehabilitation & Physiotherapy Center",
  "Diagnostic & Imaging Center",
  "General Clinic",
  "Specialized Clinic",
];

const T = {
  "General Hospital": [
    "General Medicine / Internal Medicine", "General Physician / Family Medicine", "General Surgery",
    "Emergency & Trauma", "Critical Care / ICU", "Pediatrics", "Gynecology & Obstetrics", "Orthopedics",
    "ENT", "Dermatology", "Cardiology", "Neurology", "Nephrology", "Gastroenterology", "Pulmonology",
    "Urology", "Ophthalmology", "Radiology & Imaging", "Laboratory & Pathology", "Pharmacy",
    "Physiotherapy & Rehabilitation", "Anesthesiology",
  ],
  "Eye Hospital": [
    "General Ophthalmology", "Cataract Surgery", "Retina & Vitreous", "Glaucoma",
    "Cornea & External Eye Diseases", "Pediatric Ophthalmology", "Oculoplasty",
    "Refractive Surgery / LASIK", "Neuro-Ophthalmology", "Uveitis", "Optometry & Vision Testing",
    "Optical Services", "Eye Diagnostics", "Ophthalmic Surgery",
  ],
  "Cardiac / Heart Hospital": [
    "General Cardiology", "Interventional Cardiology", "Clinical Electrophysiology", "Cardiac Surgery",
    "Pediatric Cardiology", "Heart Failure Clinic", "Preventive Cardiology", "ECG", "Echocardiography",
    "Stress Testing", "Holter Monitoring", "Angiography & Angioplasty",
    "Cardiac Catheterization Laboratory", "Cardiac ICU / CCU", "Cardiac Rehabilitation",
  ],
  "Neurology & Neurosurgery Hospital": [
    "General Neurology", "Neurosurgery", "Stroke Clinic / Stroke Unit", "Epilepsy Clinic",
    "Movement Disorders", "Headache Clinic", "Spine Surgery", "Neurodiagnostics / EEG / EMG",
    "Neurocritical Care", "Neuro Rehabilitation",
  ],
  "Orthopedic Hospital": [
    "General Orthopedics", "Trauma & Fracture Care", "Joint Replacement", "Spine Orthopedics",
    "Sports Medicine", "Pediatric Orthopedics", "Hand Surgery", "Foot & Ankle Surgery",
    "Arthroscopy", "Physiotherapy", "Rehabilitation",
  ],
  "Women & Maternity Hospital": [
    "Gynecology", "Obstetrics", "Antenatal Clinic", "High-Risk Pregnancy", "Labor & Delivery",
    "Fertility / Reproductive Medicine", "Gynecological Surgery", "Maternal-Fetal Medicine",
    "Family Planning", "Neonatology", "NICU",
  ],
  "Children / Pediatric Hospital": [
    "General Pediatrics", "Neonatology", "Pediatric Surgery", "Pediatric Cardiology",
    "Pediatric Neurology", "Pediatric Orthopedics", "Pediatric Pulmonology",
    "Pediatric Gastroenterology", "Pediatric Nephrology", "Pediatric Emergency", "PICU / NICU",
    "Vaccination Clinic",
  ],
  "Dermatology / Skin Hospital": [
    "General Dermatology", "Clinical Dermatology", "Cosmetic Dermatology", "Acne Clinic",
    "Hair & Scalp Clinic", "Nail Disorders", "Allergy & Eczema Clinic", "Psoriasis Clinic",
    "Skin Infection Clinic", "Dermatologic Surgery", "Laser Dermatology", "Skin Cancer Screening",
  ],
  "Dental Hospital": [
    "General Dentistry", "Orthodontics", "Endodontics / Root Canal", "Periodontics",
    "Prosthodontics", "Oral & Maxillofacial Surgery", "Pediatric Dentistry", "Dental Implants",
    "Cosmetic Dentistry", "Oral Medicine", "Dental Radiology",
  ],
  "Kidney & Urology Hospital": [
    "Nephrology", "Urology", "Dialysis Unit", "Kidney Transplant Services",
    "Kidney Stone Treatment", "Uro-Oncology", "Pediatric Urology", "Prostate Clinic",
    "Urinary Tract Disorders",
  ],
  "Cancer / Oncology Hospital": [
    "Medical Oncology", "Surgical Oncology", "Radiation Oncology", "Hematology / Hemato-Oncology",
    "Chemotherapy Day Care", "Cancer Diagnostics", "Breast Oncology", "Gynecologic Oncology",
    "Palliative Care", "Pain Management",
  ],
  "Chest & Pulmonology Hospital": [
    "General Pulmonology", "Asthma Clinic", "COPD Clinic", "Tuberculosis Clinic", "Sleep Medicine",
    "Bronchoscopy", "Respiratory Diagnostics", "Respiratory ICU",
  ],
  "Gastroenterology & Liver Hospital": [
    "Gastroenterology", "Hepatology", "Endoscopy", "Colonoscopy", "Liver Disease Clinic",
    "Pancreatic & Biliary Disorders", "Inflammatory Bowel Disease Clinic", "Liver Surgery",
    "Liver Transplant Services",
  ],
  "Mental Health / Psychiatric Hospital": [
    "Psychiatry", "Clinical Psychology", "Psychotherapy", "Addiction Treatment",
    "Child & Adolescent Psychiatry", "Anxiety & Depression Clinic", "Psychiatric Emergency Services",
  ],
  "ENT Hospital": [
    "General ENT", "Rhinology & Sinus Surgery", "Otology", "Hearing & Audiology",
    "Voice & Laryngology", "Head & Neck Surgery", "Pediatric ENT", "Balance & Vestibular Clinic",
  ],
  "Rehabilitation & Physiotherapy Center": [
    "Physiotherapy", "Occupational Therapy", "Speech Therapy", "Orthopedic Rehabilitation",
    "Neuro Rehabilitation", "Sports Rehabilitation", "Pain Management",
  ],
  "Diagnostic & Imaging Center": [
    "Clinical Laboratory", "Hematology", "Biochemistry", "Microbiology", "Histopathology",
    "Radiology", "X-Ray", "Ultrasound", "CT Scan", "MRI", "Mammography", "ECG / Echo",
    "Sample Collection",
  ],
  "General Clinic": [
    "General Physician", "Family Medicine", "General Consultation", "Basic Procedures",
    "Vaccination", "Basic Diagnostics", "Referral Services",
  ],
  "Specialized Clinic": [
    "General Consultation",
  ],
};

/* Union of department names for the given hospital types, order preserved,
   duplicates removed (case-insensitive). */
export function departmentsForTypes(types) {
  const seen = new Set();
  const out = [];
  for (const t of types ?? []) {
    for (const d of T[t] ?? []) {
      const k = d.trim().toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(d); }
    }
  }
  return out;
}

/* Multi-Specialty = union of every other type's template. */
T["Multi-Specialty Hospital"] = departmentsForTypes(
  HOSPITAL_TYPES.filter((t) => t !== "Multi-Specialty Hospital")
);

export const TYPE_DEPARTMENTS = T;

/* ---------------- Specialty templates (Phase 2A) ----------------
   Suggestions keyed by FLAGSHIP DEPARTMENT name (the department names the
   Phase 1 templates create, e.g. "General Ophthalmology"). These only SEED
   a clinic's own list — the live data lives per tenant in the settings
   table under key 'specialty_catalog', keyed by department id:
     { "<department_id>": { "specialties": [ { "name": "...",
                                               "services": ["..."] } ] } }
   Services are NOT seeded from templates; admins add them in Settings. */
export const SPECIALTY_TEMPLATES = {
  "General Ophthalmology": [
    "Cataract Surgery", "Retina & Vitreous", "Glaucoma", "Cornea & External Eye Diseases",
    "Pediatric Ophthalmology", "Oculoplasty", "Refractive Surgery / LASIK",
    "Neuro-Ophthalmology", "Uveitis", "Optometry & Vision Testing",
  ],
  "General Cardiology": [
    "Interventional Cardiology", "Clinical Electrophysiology", "Pediatric Cardiology",
    "Heart Failure Clinic", "Preventive Cardiology",
  ],
  "General Neurology": [
    "Stroke Clinic / Stroke Unit", "Epilepsy Clinic", "Movement Disorders",
    "Headache Clinic", "Neurodiagnostics / EEG / EMG",
  ],
  "General Orthopedics": [
    "Trauma & Fracture Care", "Joint Replacement", "Spine Orthopedics", "Sports Medicine",
    "Pediatric Orthopedics", "Hand Surgery", "Foot & Ankle Surgery", "Arthroscopy",
  ],
  "Gynecology": [
    "Obstetrics", "Antenatal Clinic", "High-Risk Pregnancy",
    "Fertility / Reproductive Medicine", "Gynecological Surgery",
    "Maternal-Fetal Medicine", "Family Planning",
  ],
  "General Pediatrics": [
    "Neonatology", "Pediatric Surgery", "Pediatric Cardiology", "Pediatric Neurology",
    "Pediatric Orthopedics", "Pediatric Pulmonology", "Pediatric Gastroenterology",
    "Pediatric Nephrology",
  ],
  "General Dermatology": [
    "Cosmetic Dermatology", "Acne Clinic", "Hair & Scalp Clinic",
    "Allergy & Eczema Clinic", "Psoriasis Clinic", "Dermatologic Surgery",
    "Laser Dermatology",
  ],
  "General Dentistry": [
    "Orthodontics", "Endodontics / Root Canal", "Periodontics", "Prosthodontics",
    "Oral & Maxillofacial Surgery", "Pediatric Dentistry", "Dental Implants",
    "Cosmetic Dentistry",
  ],
  "Nephrology": [
    "Dialysis Unit", "Kidney Transplant Services", "Kidney Stone Treatment",
  ],
  "Urology": [
    "Uro-Oncology", "Pediatric Urology", "Prostate Clinic",
  ],
  "Medical Oncology": [
    "Surgical Oncology", "Radiation Oncology", "Hematology / Hemato-Oncology",
    "Chemotherapy Day Care", "Breast Oncology", "Gynecologic Oncology", "Palliative Care",
  ],
  "General Pulmonology": [
    "Asthma Clinic", "COPD Clinic", "Tuberculosis Clinic", "Sleep Medicine", "Bronchoscopy",
  ],
  "Gastroenterology": [
    "Hepatology", "Endoscopy", "Colonoscopy", "Liver Disease Clinic",
    "Pancreatic & Biliary Disorders", "Inflammatory Bowel Disease Clinic",
  ],
  "Psychiatry": [
    "Clinical Psychology", "Psychotherapy", "Addiction Treatment",
    "Child & Adolescent Psychiatry", "Anxiety & Depression Clinic",
  ],
  "General ENT": [
    "Rhinology & Sinus Surgery", "Otology", "Hearing & Audiology",
    "Voice & Laryngology", "Head & Neck Surgery", "Pediatric ENT",
  ],
  "Clinical Laboratory": [
    "Hematology", "Biochemistry", "Microbiology", "Histopathology",
  ],
  "Radiology": [
    "X-Ray", "Ultrasound", "CT Scan", "MRI", "Mammography",
  ],
};

/* Template specialty names for a department name (case-insensitive,
   extra spaces ignored), or null when the department has no template. */
export function specialtyTemplateFor(departmentName) {
  const want = String(departmentName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  for (const [k, v] of Object.entries(SPECIALTY_TEMPLATES)) {
    if (k.toLowerCase().replace(/\s+/g, " ") === want) return v;
  }
  return null;
}
