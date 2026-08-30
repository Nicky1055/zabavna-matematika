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

  async function getAuthenticatedContext() {
    if (!window.authService) return { ok: false, reason: 'auth_unavailable' };
    return window.authService.getCurrentProfile();
  }

  function generateClassCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const values = new Uint32Array(6);

    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(values);
    } else {
      for (let index = 0; index < values.length; index++) {
        values[index] = Math.floor(Math.random() * alphabet.length);
      }
    }

    const suffix = Array.from(values, value => alphabet[value % alphabet.length]).join('');
    return `MAT-${suffix}`;
  }

  async function getTeacherClasses() {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const auth = await getAuthenticatedContext();
      if (!auth.ok) return auth;

      let query = window.supabaseClient
        .from('classes')
        .select('id, teacher_id, class_name, school_name, class_code, created_at')
        .order('created_at', { ascending: false });

      if (auth.profile.role !== 'admin') {
        query = query.eq('teacher_id', auth.user.id);
      }

      const { data, error } = await query;
      if (error) {
        logWarning('Classes could not be loaded', error);
        return { ok: false, error };
      }

      return { ok: true, data: data || [] };
    } catch (error) {
      logWarning('Classes could not be loaded', error);
      return { ok: false, error };
    }
  }

  async function createClass(className, schoolName) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const auth = await getAuthenticatedContext();
      if (!auth.ok) return auth;

      const cleanName = String(className || '').trim();
      const cleanSchool = String(schoolName || auth.profile.school_name || '').trim();
      if (!cleanName || !cleanSchool) return { ok: false, reason: 'missing_fields' };

      for (let attempt = 0; attempt < 5; attempt++) {
        const payload = {
          teacher_id: auth.user.id,
          class_name: cleanName,
          school_name: cleanSchool,
          class_code: generateClassCode(),
        };

        const { data, error } = await window.supabaseClient
          .from('classes')
          .insert(payload)
          .select('id, teacher_id, class_name, school_name, class_code, created_at')
          .single();

        if (!error) return { ok: true, data };
        if (error.code !== '23505') {
          logWarning('Class could not be created', error);
          return { ok: false, error };
        }
      }

      const error = new Error('Could not generate a unique class code');
      logWarning('Class could not be created', error);
      return { ok: false, error };
    } catch (error) {
      logWarning('Class could not be created', error);
      return { ok: false, error };
    }
  }

  async function getStudentsByClass(classId) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const { data, error } = await window.supabaseClient
        .from('students')
        .select('id, class_id, student_number, display_name, created_at')
        .eq('class_id', classId)
        .order('student_number', { ascending: true });

      if (error) {
        logWarning('Students could not be loaded', error);
        return { ok: false, error };
      }

      return { ok: true, data: data || [] };
    } catch (error) {
      logWarning('Students could not be loaded', error);
      return { ok: false, error };
    }
  }

  async function addStudentToClass(classId, studentNumber, displayName, pinCode) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const parsedNumber = Number(studentNumber);
      const cleanName = String(displayName || '').trim();
      const cleanPin = String(pinCode || '').trim();

      if (!classId || !Number.isInteger(parsedNumber) || parsedNumber < 1 || !cleanName || !/^\d{4}$/.test(cleanPin)) {
        return { ok: false, reason: 'invalid_student_data' };
      }

      const { data, error } = await window.supabaseClient
        .from('students')
        .insert({
          class_id: classId,
          student_number: parsedNumber,
          display_name: cleanName,
          pin_code: cleanPin,
        })
        .select('id, class_id, student_number, display_name, created_at')
        .single();

      if (error) {
        logWarning('Student could not be added', error);
        return { ok: false, error };
      }

      return { ok: true, data };
    } catch (error) {
      logWarning('Student could not be added', error);
      return { ok: false, error };
    }
  }

  async function deleteStudent(studentId) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const auth = await getAuthenticatedContext();
      if (!auth.ok) return auth;
      if (!studentId) return { ok: false, reason: 'missing_fields' };

      const { data, error } = await window.supabaseClient
        .from('students')
        .delete()
        .eq('id', studentId)
        .select('id')
        .maybeSingle();

      if (error) {
        logWarning('Student could not be deleted', error);
        return { ok: false, error };
      }
      if (!data) return { ok: false, reason: 'not_found' };

      return { ok: true, data };
    } catch (error) {
      logWarning('Student could not be deleted', error);
      return { ok: false, error };
    }
  }

  async function deleteClass(classId) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const auth = await getAuthenticatedContext();
      if (!auth.ok) return auth;
      if (!classId) return { ok: false, reason: 'missing_fields' };

      const { data, error } = await window.supabaseClient
        .from('classes')
        .delete()
        .eq('id', classId)
        .select('id')
        .maybeSingle();

      if (error) {
        logWarning('Class could not be deleted', error);
        return { ok: false, error };
      }
      if (!data) return { ok: false, reason: 'not_found' };

      return { ok: true, data };
    } catch (error) {
      logWarning('Class could not be deleted', error);
      return { ok: false, error };
    }
  }

  async function getClassResults(classId) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const { data, error } = await window.supabaseClient
        .from('game_results')
        .select('id, student_id, class_id, student_name, game_key, score, total_questions, stars, time_spent_seconds, played_at')
        .eq('class_id', classId)
        .order('played_at', { ascending: false })
        .limit(200);

      if (error) {
        logWarning('Class results could not be loaded', error);
        return { ok: false, error };
      }

      return { ok: true, data: data || [] };
    } catch (error) {
      logWarning('Class results could not be loaded', error);
      return { ok: false, error };
    }
  }

  async function getAdminOverview() {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const auth = await getAuthenticatedContext();
      if (!auth.ok) return auth;
      if (auth.profile.role !== 'admin') return { ok: false, reason: 'forbidden' };

      const teacherQuery = window.supabaseClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'teacher');
      const classQuery = window.supabaseClient.from('classes').select('id', { count: 'exact', head: true });
      const studentQuery = window.supabaseClient.from('students').select('id', { count: 'exact', head: true });
      const resultQuery = window.supabaseClient.from('game_results').select('id', { count: 'exact', head: true });
      const responses = await Promise.all([teacherQuery, classQuery, studentQuery, resultQuery]);
      const failedResponse = responses.find(response => response.error);

      if (failedResponse) {
        logWarning('Admin overview could not be loaded', failedResponse.error);
        return { ok: false, error: failedResponse.error };
      }

      return {
        ok: true,
        data: {
          teachers: responses[0].count || 0,
          classes: responses[1].count || 0,
          students: responses[2].count || 0,
          games: responses[3].count || 0,
        },
      };
    } catch (error) {
      logWarning('Admin overview could not be loaded', error);
      return { ok: false, error };
    }
  }

  window.dbService = Object.freeze({
    checkConnection,
    saveGameResult,
    getLocalResults,
    getTeacherClasses,
    createClass,
    getStudentsByClass,
    addStudentToClass,
    deleteStudent,
    deleteClass,
    getClassResults,
    getAdminOverview,
  });
})();
