(() => {
  function logWarning(message, error) {
    const detail = error && error.message ? ` ${error.message}` : '';
    console.warn(`[dbService] ${message}.${detail}`);
  }

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
        .from('classes')
        .select('*')
        .limit(1);

      if (error) {
        logWarning('Connection check failed', error);
        return { ok: false, error };
      }

      console.info('[dbService] Supabase connection is active.');
      return { ok: true };
    } catch (error) {
      logWarning('Connection check failed', error);
      return { ok: false, error };
    }
  }

  async function saveGameResult(resultData) {
    try {
      if (!window.supabaseClient) return unavailableStatus();

      const studentName = (window.localStorage.getItem('mathStudent') || '').trim() || 'Гост';
      const rawTimeSpent = resultData.timeSpentSeconds ?? resultData.time_spent_seconds;
      const parsedTimeSpent = Number(rawTimeSpent);
      const payload = {
        student_name: studentName,
        game_key: String(resultData.gameKey || resultData.game_key || 'unknown'),
        score: Number(resultData.score) || 0,
        total_questions: Number(resultData.totalQuestions ?? resultData.total_questions) || 0,
        stars: Number(resultData.stars) || 0,
        time_spent_seconds: Number.isFinite(parsedTimeSpent) ? Math.max(0, Math.floor(parsedTimeSpent)) : null,
      };

      const { data, error } = await window.supabaseClient
        .from('game_results')
        .insert(payload);

      if (error) {
        logWarning('Game result could not be synced', error);
        return { ok: false, error };
      }

      console.info('[dbService] Game result synced successfully.');
      return { ok: true, data, payload };
    } catch (error) {
      logWarning('Game result could not be synced', error);
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
