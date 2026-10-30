import { createClient } from "@supabase/supabase-js";

// Defaults point at the live MediCore project. Override with a .env file
// (see .env.example) if you ever run against a local Supabase stack.
const url =
  import.meta.env.VITE_SUPABASE_URL ??
  "https://gpxtcbeovvjypwbsnlor.supabase.co";
const anonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  "sb_publishable_7GPipzyfc08GgxfUERz_FQ_msMQpx5D";

export const supabase = createClient(url, anonKey);
export const SUPABASE_URL = url;
