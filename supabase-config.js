(() => {
  const SUPABASE_URL = 'https://nzbsbofuvdiyooqljlvv.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_2NgFdUGvEY0CxDZoir7Z7Q_E3Odk0VY'; // Поставете тук вашия реален ключ

  const isConfigured =
    SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' &&
    SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY' &&
    !SUPABASE_ANON_KEY.includes('ТУК_ПОСТАВЕТЕ');

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
