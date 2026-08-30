(() => {
  function unavailableStatus() {
    const isConfigured = Boolean(window.supabaseConfig && window.supabaseConfig.isConfigured);
    return {
      ok: false,
      skipped: !isConfigured,
      reason: isConfigured ? 'client_unavailable' : 'not_configured',
    };
  }

  async function checkConnection() {
    try {
      if (!window.supabaseClient) return unavailableStatus();

      const { error } = await window.supabaseClient
        .from('game_results')
        .select('id', { head: true, count: 'exact' });

      if (error) return { ok: false, error };
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function saveGameResult(resultData) {
    try {
      if (!window.supabaseClient) return unavailableStatus();

      const { data, error } = await window.supabaseClient
        .from('game_results')
        .insert(resultData);

      if (error) return { ok: false, error };
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function getLocalResults() {
    try {
      const savedResults = window.localStorage.getItem('mathLog');
      const parsedResults = savedResults ? JSON.parse(savedResults) : [];

      if (!Array.isArray(parsedResults)) {
        return { ok: false, error: new Error('Invalid mathLog data'), data: [] };
      }

      return { ok: true, data: parsedResults };
    } catch (error) {
      return { ok: false, error, data: [] };
    }
  }

  window.dbService = Object.freeze({
    checkConnection,
    saveGameResult,
    getLocalResults,
  });
})();
