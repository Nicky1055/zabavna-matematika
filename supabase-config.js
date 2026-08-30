(() => {
  const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
  const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

  const isConfigured =
    SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' &&
    SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';

  const supabase = (() => {
    if (!isConfigured) return null;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;

    try {
      return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (error) {
      return null;
    }
  })();

  window.supabaseConfig = Object.freeze({ isConfigured });
  window.supabaseClient = supabase;
})();
