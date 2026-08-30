(() => {
  const STUDENT_SESSION_KEY = 'mathStudentSession';
  const accessState = {
    teacherProfile: null,
    studentSession: readStudentSession(),
    loginClass: null,
    loginStudents: [],
    selectedStudent: null,
  };

  function element(id) {
    return document.getElementById(id);
  }

  function escapeText(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function readStudentSession() {
    try {
      const rawSession = window.localStorage.getItem(STUDENT_SESSION_KEY);
      const session = rawSession ? JSON.parse(rawSession) : null;
      if (!session || !session.studentId || !session.classId || !session.studentName || !session.className) {
        window.localStorage.removeItem(STUDENT_SESSION_KEY);
        window.sessionStorage.removeItem(STUDENT_SESSION_KEY);
        return null;
      }
      return session;
    } catch (error) {
      window.localStorage.removeItem(STUDENT_SESSION_KEY);
      window.sessionStorage.removeItem(STUDENT_SESSION_KEY);
      return null;
    }
  }

  function saveStudentSession(session) {
    accessState.studentSession = session;
    window.localStorage.setItem(STUDENT_SESSION_KEY, JSON.stringify(session));
    window.localStorage.setItem('mathStudent', session.studentName);
  }

  function clearStudentSession(clearName = true) {
    const hadSession = Boolean(
      accessState.studentSession
      || window.localStorage.getItem(STUDENT_SESSION_KEY)
      || window.sessionStorage.getItem(STUDENT_SESSION_KEY)
    );
    accessState.studentSession = null;
    accessState.loginClass = null;
    accessState.loginStudents = [];
    accessState.selectedStudent = null;
    window.localStorage.removeItem(STUDENT_SESSION_KEY);
    window.sessionStorage.removeItem(STUDENT_SESSION_KEY);
    if (clearName) window.localStorage.setItem('mathStudent', '');
    return hadSession;
  }

  function announceStudentIdentity(name, locked, resetProgress) {
    window.dispatchEvent(new CustomEvent('math:student-access', {
      detail: { name: name || '', locked: Boolean(locked), resetProgress: Boolean(resetProgress) },
    }));
  }

  function currentRole() {
    if (accessState.teacherProfile) return 'teacher';
    if (accessState.studentSession) return 'student';
    return 'guest';
  }

  function updateRoleButtons(role) {
    document.querySelectorAll('[data-access-role]').forEach(button => {
      const active = button.dataset.accessRole === role;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderAccessStatus() {
    const role = currentRole();
    const status = element('accessStatusText');
    const actions = element('accessStatusActions');
    document.body.classList.remove('access-mode-guest', 'access-mode-student', 'access-mode-teacher');
    document.body.classList.add(`access-mode-${role}`);
    updateRoleButtons(role);

    if (role === 'student') {
      const session = accessState.studentSession;
      status.textContent = `🎒 Здравей, ${session.studentName}! (${session.className})`;
      actions.innerHTML = '<button class="access-status-action" type="button" data-access-action="student-logout">Изход</button>';
      return;
    }

    if (role === 'teacher') {
      status.textContent = `👨‍🏫 ${accessState.teacherProfile.full_name || 'Учител'}`;
      actions.innerHTML = [
        '<button class="access-status-action" type="button" data-access-action="teacher-dashboard">Табло</button>',
        '<button class="access-status-action" type="button" data-access-action="teacher-logout">Изход</button>',
      ].join('');
      return;
    }

    status.textContent = 'Режим: Гост';
    actions.innerHTML = [
      '<button class="access-status-action" type="button" data-access-action="student-login">Вход за ученик</button>',
      '<button class="access-status-action" type="button" data-access-action="teacher-login">Вход за учител</button>',
    ].join('');
  }

  function setStudentLoginMessage(message, type = '') {
    const node = element('studentLoginMessage');
    node.textContent = message || '';
    node.className = `feedback student-login-message ${type}`.trim();
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
      delete button.dataset.originalText;
    }
  }

  function setStudentLoginStep(step) {
    [1, 2, 3].forEach(number => {
      element(`studentLoginStep${number}`).hidden = number !== step;
      const indicator = document.querySelector(`[data-student-step-indicator="${number}"]`);
      indicator.classList.toggle('active', number === step);
    });
    setStudentLoginMessage('');
  }

  function resetStudentLogin() {
    accessState.loginClass = null;
    accessState.loginStudents = [];
    accessState.selectedStudent = null;
    element('studentClassCodeForm').reset();
    element('studentPinLoginForm').reset();
    element('studentLoginPin').type = 'password';
    element('showStudentLoginPinBtn').setAttribute('aria-pressed', 'false');
    element('studentLoginChoices').innerHTML = '';
    setStudentLoginStep(1);
  }

  function openStudentLogin() {
    resetStudentLogin();
    const dialog = element('studentLoginDialog');
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
      dialog.classList.add('fallback-open');
    }
    window.setTimeout(() => element('studentClassCode').focus(), 0);
  }

  function closeStudentLogin() {
    const dialog = element('studentLoginDialog');
    element('studentPinLoginForm').reset();
    element('studentLoginPin').type = 'password';
    element('showStudentLoginPinBtn').setAttribute('aria-pressed', 'false');
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    dialog.classList.remove('fallback-open');
    if (dialog.hasAttribute('open') && typeof dialog.showModal !== 'function') dialog.removeAttribute('open');
  }

  function openTeacherPanel() {
    const tab = document.querySelector('.tab[data-tab="teacher"]');
    if (tab) tab.click();
    const panel = element('teacher');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function logoutTeacher() {
    if (!accessState.teacherProfile || !window.authService) return true;
    const result = await window.authService.logoutTeacher();
    if (!result.ok) {
      element('accessStatusText').textContent = 'Изходът не беше успешен. Опитайте отново.';
      return false;
    }
    accessState.teacherProfile = null;
    return true;
  }

  async function switchToGuest() {
    if (!await logoutTeacher()) return;
    const hadStudentName = Boolean(window.localStorage.getItem('mathStudent'));
    const hadStudent = clearStudentSession(true);
    closeStudentLogin();
    announceStudentIdentity('', false, hadStudent || hadStudentName);
    renderAccessStatus();
  }

  async function switchToStudentLogin() {
    if (!await logoutTeacher()) return;
    renderAccessStatus();
    openStudentLogin();
  }

  function switchToTeacherPanel() {
    const hadStudentName = Boolean(window.localStorage.getItem('mathStudent'));
    const hadStudent = clearStudentSession(true);
    if (hadStudent || hadStudentName) announceStudentIdentity('', false, true);
    renderAccessStatus();
    openTeacherPanel();
  }

  function renderStudentChoices() {
    element('studentLoginChoices').innerHTML = accessState.loginStudents.map(student => [
      `<button class="student-choice-button" type="button" data-student-login-id="${escapeText(student.id)}">`,
      `№ ${escapeText(student.student_number)} · ${escapeText(student.display_name)}`,
      '</button>',
    ].join('')).join('');
  }

  function studentLoginError(result, fallback) {
    if (!result) return fallback;
    if (result.reason === 'not_configured') return 'Онлайн връзката още не е настроена.';
    if (result.reason === 'missing_class_code') return 'Въведи кода на класа.';
    if (result.reason === 'class_not_found') return 'Не открихме клас с този код. Провери го внимателно.';
    if (result.reason === 'invalid_pin') return 'ПИН кодът не е правилен. Опитай отново.';
    return fallback;
  }

  async function findStudentClass(event) {
    event.preventDefault();
    const codeInput = element('studentClassCode');
    const classCode = codeInput.value.trim().toUpperCase().replace(/\s+/g, '');
    codeInput.value = classCode;
    if (!/^[A-Z0-9-]{4,24}$/.test(classCode)) {
      setStudentLoginMessage('Въведи валиден код на класа.', 'bad');
      codeInput.focus();
      return;
    }

    const button = event.currentTarget.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Търсене...');
    setStudentLoginMessage('');
    const classResult = await window.dbService.getClassByCode(classCode);
    if (!classResult.ok) {
      setButtonBusy(button, false);
      setStudentLoginMessage(studentLoginError(classResult, 'Класът не можа да се зареди.'), 'bad');
      return;
    }

    const studentsResult = await window.dbService.getStudentsForLogin(classResult.data.id);
    setButtonBusy(button, false);
    if (!studentsResult.ok) {
      setStudentLoginMessage(studentLoginError(studentsResult, 'Списъкът с ученици не можа да се зареди.'), 'bad');
      return;
    }
    if (!studentsResult.data.length) {
      setStudentLoginMessage('В този клас все още няма добавени ученици.', 'bad');
      return;
    }

    accessState.loginClass = classResult.data;
    accessState.loginStudents = studentsResult.data;
    element('studentLoginClassName').textContent = classResult.data.class_name;
    element('studentLoginSchoolName').textContent = classResult.data.school_name || '';
    renderStudentChoices();
    setStudentLoginStep(2);
  }

  function selectStudentForLogin(studentId) {
    const student = accessState.loginStudents.find(item => item.id === studentId);
    if (!student) return;
    accessState.selectedStudent = student;
    element('selectedStudentLoginName').textContent = `№ ${student.student_number} · ${student.display_name}`;
    element('studentPinLoginForm').reset();
    setStudentLoginStep(3);
    element('studentLoginPin').focus();
  }

  async function completeStudentLogin(event) {
    event.preventDefault();
    if (!accessState.loginClass || !accessState.selectedStudent) return setStudentLoginStep(1);
    const pinInput = element('studentLoginPin');
    const pinCode = pinInput.value.trim();
    if (!/^\d{4}$/.test(pinCode)) {
      setStudentLoginMessage('Въведи ПИН код от 4 цифри.', 'bad');
      pinInput.focus();
      return;
    }

    const button = event.currentTarget.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Проверка...');
    setStudentLoginMessage('');
    const result = await window.dbService.verifyStudentPin(
      accessState.selectedStudent.id,
      accessState.loginClass.id,
      pinCode,
    );
    if (!result.ok) {
      setButtonBusy(button, false);
      setStudentLoginMessage(studentLoginError(result, 'Входът не беше успешен.'), 'bad');
      pinInput.value = '';
      pinInput.focus();
      return;
    }

    if (!await logoutTeacher()) {
      setButtonBusy(button, false);
      setStudentLoginMessage('Първо излезте от учителския профил.', 'bad');
      return;
    }

    const session = {
      studentId: result.data.id,
      classId: accessState.loginClass.id,
      studentNumber: result.data.student_number,
      studentName: result.data.display_name,
      className: accessState.loginClass.class_name,
      classCode: accessState.loginClass.class_code,
    };
    saveStudentSession(session);
    setButtonBusy(button, false);
    announceStudentIdentity(session.studentName, true, true);
    renderAccessStatus();
    closeStudentLogin();
  }

  function bindPinReveal() {
    const input = element('studentLoginPin');
    const button = element('showStudentLoginPinBtn');
    const show = () => {
      input.type = 'text';
      button.setAttribute('aria-pressed', 'true');
    };
    const hide = () => {
      input.type = 'password';
      button.setAttribute('aria-pressed', 'false');
    };

    input.addEventListener('input', event => {
      event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 4);
    });
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      show();
    });
    button.addEventListener('pointerup', hide);
    button.addEventListener('pointercancel', hide);
    button.addEventListener('lostpointercapture', hide);
    button.addEventListener('blur', hide);
    button.addEventListener('keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      show();
    });
    button.addEventListener('keyup', event => {
      if (event.key === ' ' || event.key === 'Enter') hide();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hide();
    });
    window.addEventListener('blur', hide);
  }

  function bindAccessEvents() {
    element('guestAccessBtn').addEventListener('click', () => void switchToGuest());
    element('studentAccessBtn').addEventListener('click', () => void switchToStudentLogin());
    element('teacherAccessBtn').addEventListener('click', switchToTeacherPanel);
    element('closeStudentLoginBtn').addEventListener('click', closeStudentLogin);
    element('studentClassCodeForm').addEventListener('submit', findStudentClass);
    element('studentPinLoginForm').addEventListener('submit', completeStudentLogin);
    element('backToClassCodeBtn').addEventListener('click', () => setStudentLoginStep(1));
    element('backToStudentListBtn').addEventListener('click', () => setStudentLoginStep(2));
    element('studentLoginChoices').addEventListener('click', event => {
      const button = event.target.closest('[data-student-login-id]');
      if (button) selectStudentForLogin(button.dataset.studentLoginId);
    });
    element('studentClassCode').addEventListener('input', event => {
      event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/\s+/g, '');
    });
    element('studentLoginDialog').addEventListener('click', event => {
      if (event.target === event.currentTarget) closeStudentLogin();
    });
    element('accessStatusActions').addEventListener('click', event => {
      const button = event.target.closest('[data-access-action]');
      if (!button) return;
      if (button.dataset.accessAction === 'student-login') void switchToStudentLogin();
      if (button.dataset.accessAction === 'teacher-login' || button.dataset.accessAction === 'teacher-dashboard') switchToTeacherPanel();
      if (button.dataset.accessAction === 'student-logout') void switchToGuest();
      if (button.dataset.accessAction === 'teacher-logout') void switchToGuest();
    });
    window.addEventListener('math:teacher-access', event => {
      const profile = event.detail && event.detail.profile ? event.detail.profile : null;
      accessState.teacherProfile = profile;
      if (profile) {
        const hadStudentName = Boolean(window.localStorage.getItem('mathStudent'));
        const hadStudent = clearStudentSession(true);
        if (hadStudent || hadStudentName) announceStudentIdentity('', false, true);
      }
      renderAccessStatus();
    });
    bindPinReveal();
  }

  async function initAccessControl() {
    if (!element('guestAccessBtn') || !window.dbService) return;
    bindAccessEvents();
    renderAccessStatus();
    if (accessState.studentSession) {
      announceStudentIdentity(accessState.studentSession.studentName, true, false);
    } else {
      announceStudentIdentity(window.localStorage.getItem('mathStudent') || '', false, false);
    }

    if (window.authService) {
      const teacher = await window.authService.getCurrentProfile();
      if (teacher.ok) {
        accessState.teacherProfile = teacher.profile;
        const hadStudent = clearStudentSession(true);
        if (hadStudent) announceStudentIdentity('', false, true);
        renderAccessStatus();
      }
    }
  }

  window.accessControl = Object.freeze({
    getCurrentRole: currentRole,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAccessControl, { once: true });
  } else {
    void initAccessControl();
  }
})();
