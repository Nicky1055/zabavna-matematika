(() => {
  const PROFILE_FIELDS = 'id, email, full_name, school_name, role, created_at';

  function getClient() {
    return window.supabaseClient || null;
  }

  function failed(action, error) {
    const detail = error && error.message ? ` ${error.message}` : '';
    console.warn(`[authService] ${action} failed.${detail}`);
    return { ok: false, error };
  }

  function normalizedText(value) {
    return String(value || '').trim();
  }

  async function ensureTeacherProfile(user) {
    try {
      const client = getClient();
      if (!client || !user) return { ok: false, reason: 'not_available' };

      const { data: existingProfile, error: profileError } = await client
        .from('profiles')
        .select(PROFILE_FIELDS)
        .eq('id', user.id)
        .maybeSingle();

      if (profileError) return failed('Profile lookup', profileError);
      if (existingProfile) return { ok: true, data: existingProfile };

      const metadata = user.user_metadata || {};
      const profileData = {
        id: user.id,
        email: user.email || '',
        full_name: normalizedText(metadata.full_name) || 'Учител',
        school_name: normalizedText(metadata.school_name),
        role: 'teacher',
      };

      const { data: createdProfile, error: createError } = await client
        .from('profiles')
        .insert(profileData)
        .select(PROFILE_FIELDS)
        .single();

      if (createError) {
        if (createError.code === '23505') {
          const { data: concurrentProfile, error: retryError } = await client
            .from('profiles')
            .select(PROFILE_FIELDS)
            .eq('id', user.id)
            .single();
          if (!retryError) return { ok: true, data: concurrentProfile };
        }
        return failed('Profile creation', createError);
      }

      return { ok: true, data: createdProfile };
    } catch (error) {
      return failed('Profile setup', error);
    }
  }

  async function registerTeacher(email, password, fullName, schoolName) {
    try {
      const client = getClient();
      if (!client) return { ok: false, reason: 'not_configured' };

      const cleanEmail = normalizedText(email).toLowerCase();
      const cleanName = normalizedText(fullName);
      const cleanSchool = normalizedText(schoolName);

      if (!cleanEmail || !password || !cleanName || !cleanSchool) {
        return { ok: false, reason: 'missing_fields' };
      }

      const { data, error } = await client.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: {
            full_name: cleanName,
            school_name: cleanSchool,
            role: 'teacher',
          },
        },
      });

      if (error) return failed('Teacher registration', error);

      let profile = null;
      if (data.session && data.user) {
        const profileResult = await ensureTeacherProfile(data.user);
        if (!profileResult.ok) return profileResult;
        profile = profileResult.data;
      }

      return {
        ok: true,
        user: data.user,
        session: data.session,
        profile,
        requiresEmailConfirmation: !data.session,
      };
    } catch (error) {
      return failed('Teacher registration', error);
    }
  }

  async function loginTeacher(email, password) {
    try {
      const client = getClient();
      if (!client) return { ok: false, reason: 'not_configured' };

      const { data, error } = await client.auth.signInWithPassword({
        email: normalizedText(email).toLowerCase(),
        password,
      });

      if (error) return failed('Teacher login', error);

      const profileResult = await ensureTeacherProfile(data.user);
      if (!profileResult.ok) return profileResult;

      return {
        ok: true,
        user: data.user,
        session: data.session,
        profile: profileResult.data,
      };
    } catch (error) {
      return failed('Teacher login', error);
    }
  }

  async function logoutTeacher() {
    try {
      const client = getClient();
      if (!client) return { ok: false, reason: 'not_configured' };

      const { error } = await client.auth.signOut();
      if (error) return failed('Teacher logout', error);
      return { ok: true };
    } catch (error) {
      return failed('Teacher logout', error);
    }
  }

  async function getCurrentProfile() {
    try {
      const client = getClient();
      if (!client) return { ok: false, reason: 'not_configured', session: null };

      const { data, error } = await client.auth.getSession();
      if (error) return failed('Session lookup', error);
      if (!data.session || !data.session.user) {
        return { ok: false, reason: 'no_session', session: null, profile: null };
      }

      const profileResult = await ensureTeacherProfile(data.session.user);
      if (!profileResult.ok) return { ...profileResult, session: data.session };

      return {
        ok: true,
        session: data.session,
        user: data.session.user,
        profile: profileResult.data,
      };
    } catch (error) {
      return failed('Session lookup', error);
    }
  }

  function onAuthStateChange(callback) {
    const client = getClient();
    if (!client || typeof callback !== 'function') return null;
    return client.auth.onAuthStateChange(callback);
  }

  window.authService = Object.freeze({
    registerTeacher,
    loginTeacher,
    logoutTeacher,
    getCurrentProfile,
    onAuthStateChange,
  });
})();
