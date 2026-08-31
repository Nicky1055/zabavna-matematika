(() => {
  const STUDENT_SESSION_KEY = 'mathStudentSession';

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

  function getStudentSession() {
    try {
      const rawSession = window.localStorage.getItem(STUDENT_SESSION_KEY);
      const session = rawSession ? JSON.parse(rawSession) : null;
      if (!session || !/^[a-f0-9]{64}$/.test(session.sessionToken || '')
        || !(Date.parse(session.expiresAt) > Date.now())) return null;
      return session;
    } catch (error) {
      return null;
    }
  }

  function normalizeClassCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  async function checkConnection() {
    return callRpc('math_check_connection', {});
  }

  async function callRpc(name, args) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const { data, error } = await window.supabaseClient.rpc(name, args);
      if (error) {
        // Do not include RPC arguments, PINs or session tokens in diagnostics.
        logWarning(`${name} failed`);
        return { ok: false, reason: 'network_or_database_error' };
      }
      return data && typeof data.ok === 'boolean' ? data : { ok: false, reason: 'invalid_response' };
    } catch (error) {
      logWarning(`${name} unavailable`);
      return { ok: false, reason: 'network_or_database_error' };
    }
  }

  async function validateStudentSession(sessionToken) {
    return callRpc('math_student_session', { p_session_token: sessionToken });
  }

  async function revokeStudentSession(sessionToken) {
    return callRpc('math_student_logout', { p_session_token: sessionToken });
  }

  async function saveGameResult(resultData) {
    try {
      const activeRole = window.accessControl && typeof window.accessControl.getCurrentRole === 'function'
        ? window.accessControl.getCurrentRole()
        : 'guest';
      if (activeRole !== 'student') return { ok: true, skipped: true, reason: 'guest_mode' };

      const studentSession = getStudentSession();
      if (!studentSession) return { ok: false, reason: 'session_expired' };
      if (!window.supabaseClient) return unavailableStatus();

      const rawTimeSpent = resultData.timeSpentSeconds ?? resultData.time_spent_seconds;
      const parsedTimeSpent = Number(rawTimeSpent);
      const payload = {
        p_session_token: studentSession.sessionToken,
        p_game_key: String(resultData.gameKey || resultData.game_key || 'unknown'),
        p_score: Number(resultData.score) || 0,
        p_total_questions: Number(resultData.totalQuestions ?? resultData.total_questions) || 0,
        p_stars: Number(resultData.stars) || 0,
        p_time_spent_seconds: Number.isFinite(parsedTimeSpent) ? Math.max(0, Math.floor(parsedTimeSpent)) : null,
      };

      const result = await callRpc('math_save_game_result', payload);
      if (result.ok) console.info('[dbService] Game result synced successfully.');
      else logWarning('Game result remains in the local journal');
      return result;
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
    const auth = await window.authService.getCurrentProfile();
    if (!auth.ok) return auth;
    if (!auth.user || !auth.profile || auth.profile.id !== auth.user.id
      || !['teacher', 'admin'].includes(auth.profile.role)) {
      return { ok: false, reason: 'forbidden' };
    }
    return auth;
  }

  // UI-side guard for clear errors; the database must enforce the same ownership with RLS.
  async function getOwnedClass(classId) {
    const auth = await getAuthenticatedContext();
    if (!auth.ok) return auth;
    if (!classId) return { ok: false, reason: 'missing_fields' };
    let query = window.supabaseClient.from('classes').select('id, teacher_id').eq('id', classId);
    if (auth.profile.role !== 'admin') query = query.eq('teacher_id', auth.user.id);
    const { data, error } = await query.maybeSingle();
    if (error) return { ok: false, error };
    if (!data) return { ok: false, reason: 'forbidden' };
    return { ok: true, data, auth };
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

  async function getClassByCode(classCode) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const cleanCode = normalizeClassCode(classCode);
      if (!cleanCode) return { ok: false, reason: 'missing_class_code' };

      return callRpc('math_find_class', { p_class_code: cleanCode });
    } catch (error) {
      logWarning('Class code lookup failed', error);
      return { ok: false, error };
    }
  }

  async function getStudentsForLogin(classId, classCode) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      if (!classId) return { ok: false, reason: 'missing_fields' };

      return callRpc('math_students_for_login', {
        p_class_id: classId, p_class_code: normalizeClassCode(classCode),
      });
    } catch (error) {
      logWarning('Student login list could not be loaded', error);
      return { ok: false, error };
    }
  }

  async function verifyStudentPin(studentId, classId, pinCode, classCode) {
    try {
      if (!window.supabaseClient) return unavailableStatus();
      const cleanPin = String(pinCode || '').trim();
      if (!studentId || !classId || !/^\d{4}$/.test(cleanPin)) {
        return { ok: false, reason: 'invalid_pin' };
      }

      return callRpc('math_student_login', {
        p_student_id: studentId, p_class_id: classId,
        p_class_code: normalizeClassCode(classCode), p_pin: cleanPin,
      });
    } catch (error) {
      logWarning('Student PIN check failed', error);
      return { ok: false, error };
    }
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
      const cleanSchool = String(auth.profile.role === 'admin'
        ? schoolName || auth.profile.school_name || ''
        : auth.profile.school_name || '').trim();
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
      const ownership = await getOwnedClass(classId);
      if (!ownership.ok) return ownership;
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

      const ownership = await getOwnedClass(classId);
      if (!ownership.ok) return ownership;

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

      const student = await window.supabaseClient.from('students')
        .select('id, class_id').eq('id', studentId).maybeSingle();
      if (student.error) return { ok: false, error: student.error };
      if (!student.data) return { ok: false, reason: 'forbidden' };
      const ownership = await getOwnedClass(student.data.class_id);
      if (!ownership.ok) return ownership;

      const { data, error } = await window.supabaseClient
        .from('students')
        .delete()
        .eq('id', studentId)
        .eq('class_id', student.data.class_id)
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
      const ownership = await getOwnedClass(classId);
      if (!ownership.ok) return ownership;

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
      const ownership = await getOwnedClass(classId);
      if (!ownership.ok) return ownership;
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
    getClassByCode,
    getStudentsForLogin,
    verifyStudentPin,
    validateStudentSession,
    revokeStudentSession,
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
