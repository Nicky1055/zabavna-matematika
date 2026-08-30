(() => {
  const GAME_NAMES = Object.freeze({
    training: 'Тренировка',
    bingo: 'Бинго',
    families: 'Семейства',
    robot: 'Грешката на робота',
    treasure: 'Съкровище',
    secret_code: 'Таен код',
    balloons: 'Балони',
  });

  const panelState = {
    profile: null,
    classes: [],
    selectedClass: null,
    students: [],
    results: [],
    refreshingAuth: false,
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

  function setMessage(target, message, type = '') {
    const node = typeof target === 'string' ? element(target) : target;
    if (!node) return;
    node.textContent = message || '';
    node.className = `feedback ${type}`.trim();
  }

  function friendlyError(result, fallback) {
    if (!result) return fallback;
    if (result.reason === 'not_configured') return 'Онлайн връзката още не е настроена.';
    if (result.reason === 'no_session') return 'Влезте в учителския си профил.';
    if (result.reason === 'missing_fields') return 'Попълнете всички полета.';
    if (result.reason === 'weak_password') return 'Паролата трябва да съдържа поне 8 знака.';
    if (result.reason === 'invalid_student_data') return 'Попълнете номер в класа, име на ученика и ПИН код от 4 цифри.';
    if (result.reason === 'forbidden') return 'Нямате достъп до тази информация.';
    if (result.reason === 'not_found') return 'Записът не беше намерен или нямате право да го изтриете.';

    const message = result.error && result.error.message ? result.error.message.toLowerCase() : '';
    if (message.includes('invalid login credentials')) return 'Имейлът или паролата не са правилни.';
    if (message.includes('email not confirmed')) return 'Потвърдете имейла си и опитайте отново.';
    if (message.includes('already registered')) return 'Вече има регистрация с този имейл.';
    if (message.includes('duplicate') || (result.error && result.error.code === '23505')) {
      return 'Вече има такъв запис. Проверете въведените данни.';
    }
    if (result.error && result.error.code === '23503') {
      return 'Записът има свързани резултати и не може да бъде изтрит безопасно.';
    }
    return fallback;
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

  function showAuthMode(mode) {
    const isLogin = mode === 'login';
    element('teacherLoginForm').hidden = !isLogin;
    element('teacherRegisterForm').hidden = isLogin;
    element('showTeacherLoginBtn').classList.toggle('active', isLogin);
    element('showTeacherRegisterBtn').classList.toggle('active', !isLogin);
    element('showTeacherLoginBtn').setAttribute('aria-selected', String(isLogin));
    element('showTeacherRegisterBtn').setAttribute('aria-selected', String(!isLogin));
    setMessage('teacherAuthMessage', '');
  }

  function announceTeacherAccess(profile) {
    window.dispatchEvent(new CustomEvent('math:teacher-access', { detail: { profile: profile || null } }));
  }

  function showSignedOut() {
    panelState.profile = null;
    panelState.classes = [];
    panelState.selectedClass = null;
    element('teacherAuthPanel').hidden = false;
    element('teacherDashboard').hidden = true;
    element('adminOverview').hidden = true;
    showAuthMode('login');
    announceTeacherAccess(null);
  }

  function showSignedIn(profile) {
    panelState.profile = profile;
    element('teacherAuthPanel').hidden = true;
    element('teacherDashboard').hidden = false;
    element('teacherProfileName').textContent = profile.full_name || 'Учител';
    element('teacherProfileSchool').textContent = profile.school_name || 'Без посочено училище';
    element('teacherRoleBadge').textContent = profile.role === 'admin' ? 'Администратор' : 'Учител';
    element('newClassSchool').value = profile.school_name || '';
    element('adminOverview').hidden = profile.role !== 'admin';
    announceTeacherAccess(profile);
  }

  async function refreshAuthState() {
    if (panelState.refreshingAuth || !window.authService) return;
    panelState.refreshingAuth = true;

    try {
      const result = await window.authService.getCurrentProfile();
      if (!result.ok) {
        showSignedOut();
        return;
      }

      showSignedIn(result.profile);
      await loadClasses();
      if (result.profile.role === 'admin') await loadAdminOverview();
    } finally {
      panelState.refreshingAuth = false;
    }
  }

  function renderClassList() {
    const list = element('teacherClassList');
    if (!panelState.classes.length) {
      list.innerHTML = '<div class="teacher-empty-state teacher-empty-state--small"><strong>Няма създадени класове</strong><span>Добавете първия клас от бутона по-горе.</span></div>';
      return;
    }

    list.innerHTML = panelState.classes.map(classItem => {
      const active = panelState.selectedClass && panelState.selectedClass.id === classItem.id;
      return [
        `<button class="teacher-class-button${active ? ' active' : ''}" type="button" data-class-id="${escapeText(classItem.id)}">`,
        `<span><strong>${escapeText(classItem.class_name)}</strong><small>${escapeText(classItem.school_name)}</small></span>`,
        `<em>${escapeText(classItem.class_code)}</em>`,
        '</button>',
      ].join('');
    }).join('');
  }

  async function loadClasses(preferredClassId = null) {
    const result = await window.dbService.getTeacherClasses();
    if (!result.ok) {
      setMessage('classFormMessage', friendlyError(result, 'Класовете не можаха да се заредят.'), 'bad');
      return;
    }

    panelState.classes = result.data;
    const selectedId = preferredClassId || (panelState.selectedClass && panelState.selectedClass.id);
    panelState.selectedClass = panelState.classes.find(item => item.id === selectedId) || null;
    renderClassList();

    if (panelState.selectedClass) {
      await selectClass(panelState.selectedClass.id);
    } else {
      element('classEmptyState').hidden = false;
      element('classDetail').hidden = true;
    }
  }

  function renderStudents() {
    const rows = element('classStudentRows');
    const empty = element('studentEmptyState');
    empty.hidden = panelState.students.length > 0;
    rows.innerHTML = panelState.students.map(student => [
      '<tr>',
      `<td>${escapeText(student.student_number)}</td>`,
      `<td>${escapeText(student.display_name)}</td>`,
      '<td class="teacher-action-column">',
      `<button class="teacher-delete-button" type="button" data-delete-student-id="${escapeText(student.id)}" aria-label="Изтрий ${escapeText(student.display_name)}">Изтрий</button>`,
      '</td>',
      '</tr>',
    ].join('')).join('');
  }

  async function loadStudents() {
    if (!panelState.selectedClass) return;
    const result = await window.dbService.getStudentsByClass(panelState.selectedClass.id);
    if (!result.ok) {
      setMessage('studentFormMessage', friendlyError(result, 'Учениците не можаха да се заредят.'), 'bad');
      return;
    }
    panelState.students = result.data;
    renderStudents();
  }

  async function selectClass(classId) {
    const selected = panelState.classes.find(item => item.id === classId);
    if (!selected) return;

    panelState.selectedClass = selected;
    renderClassList();
    element('classEmptyState').hidden = true;
    element('classDetail').hidden = false;
    element('selected-class-title').textContent = selected.class_name;
    element('selectedClassSchool').textContent = selected.school_name;
    element('selectedClassCode').textContent = selected.class_code;
    element('onlineJournal').hidden = true;
    element('loadOnlineJournalBtn').textContent = 'Отвори дневника';
    element('addStudentForm').hidden = true;
    setMessage('studentFormMessage', '');
    setMessage('onlineJournalMessage', '');
    await loadStudents();
  }

  function formatPlayedAt(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' });
  }

  function formatSeconds(value) {
    const seconds = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  function renderOnlineJournal() {
    const rows = element('onlineJournalRows');
    const empty = element('onlineJournalEmpty');
    empty.hidden = panelState.results.length > 0;
    rows.innerHTML = panelState.results.map(result => [
      '<tr>',
      `<td>${escapeText(formatPlayedAt(result.played_at))}</td>`,
      `<td>${escapeText(result.student_name || 'Ученик')}</td>`,
      `<td>${escapeText(GAME_NAMES[result.game_key] || result.game_key)}</td>`,
      `<td>${escapeText(result.score)}/${escapeText(result.total_questions)}</td>`,
      `<td>${escapeText(result.stars)}</td>`,
      `<td>${escapeText(formatSeconds(result.time_spent_seconds))}</td>`,
      '</tr>',
    ].join('')).join('');
  }

  async function loadOnlineJournal() {
    if (!panelState.selectedClass) return;
    const button = element('loadOnlineJournalBtn');
    setButtonBusy(button, true, 'Зареждане...');
    setMessage('onlineJournalMessage', '');

    const result = await window.dbService.getClassResults(panelState.selectedClass.id);
    setButtonBusy(button, false);
    if (!result.ok) {
      setMessage('onlineJournalMessage', friendlyError(result, 'Онлайн дневникът не можа да се зареди.'), 'bad');
      return;
    }

    panelState.results = result.data;
    renderOnlineJournal();
    element('onlineJournal').hidden = false;
    button.textContent = 'Обнови дневника';
  }

  async function loadAdminOverview() {
    const result = await window.dbService.getAdminOverview();
    if (!result.ok) return;
    element('adminTeacherCount').textContent = result.data.teachers;
    element('adminClassCount').textContent = result.data.classes;
    element('adminStudentCount').textContent = result.data.students;
    element('adminGameCount').textContent = result.data.games;
  }

  function bindAuthEvents() {
    element('showTeacherLoginBtn').addEventListener('click', () => showAuthMode('login'));
    element('showTeacherRegisterBtn').addEventListener('click', () => showAuthMode('register'));

    element('teacherLoginForm').addEventListener('submit', async event => {
      event.preventDefault();
      const password = element('teacherLoginPassword').value;
      if (password.length < 8) {
        setMessage('teacherAuthMessage', 'Паролата трябва да съдържа поне 8 знака.', 'bad');
        element('teacherLoginPassword').focus();
        return;
      }
      const button = event.currentTarget.querySelector('button[type="submit"]');
      setButtonBusy(button, true, 'Влизане...');
      setMessage('teacherAuthMessage', '');
      const result = await window.authService.loginTeacher(
        element('teacherLoginEmail').value,
        password,
      );
      setButtonBusy(button, false);

      if (!result.ok) {
        setMessage('teacherAuthMessage', friendlyError(result, 'Входът не беше успешен.'), 'bad');
        return;
      }

      event.currentTarget.reset();
      await refreshAuthState();
    });

    element('teacherRegisterForm').addEventListener('submit', async event => {
      event.preventDefault();
      const password = element('teacherRegisterPassword').value;
      if (password.length < 8) {
        setMessage('teacherAuthMessage', 'Паролата трябва да съдържа поне 8 знака.', 'bad');
        element('teacherRegisterPassword').focus();
        return;
      }
      const button = event.currentTarget.querySelector('button[type="submit"]');
      setButtonBusy(button, true, 'Създаване...');
      setMessage('teacherAuthMessage', '');
      const result = await window.authService.registerTeacher(
        element('teacherRegisterEmail').value,
        password,
        element('teacherRegisterName').value,
        element('teacherRegisterSchool').value,
      );
      setButtonBusy(button, false);

      if (!result.ok) {
        setMessage('teacherAuthMessage', friendlyError(result, 'Регистрацията не беше успешна.'), 'bad');
        return;
      }

      event.currentTarget.reset();
      if (result.requiresEmailConfirmation) {
        showAuthMode('login');
        setMessage('teacherAuthMessage', 'Регистрацията е готова. Проверете имейла си и потвърдете профила.', 'good');
      } else {
        await refreshAuthState();
      }
    });

    element('teacherLogoutBtn').addEventListener('click', async () => {
      const button = element('teacherLogoutBtn');
      setButtonBusy(button, true, 'Излизане...');
      const result = await window.authService.logoutTeacher();
      setButtonBusy(button, false);
      if (!result.ok) {
        setMessage('teacherAuthMessage', friendlyError(result, 'Изходът не беше успешен.'), 'bad');
        return;
      }
      showSignedOut();
    });
  }

  function bindClassEvents() {
    element('showCreateClassBtn').addEventListener('click', () => {
      element('createClassForm').hidden = false;
      element('newClassName').focus();
    });
    element('cancelCreateClassBtn').addEventListener('click', () => {
      element('createClassForm').hidden = true;
      setMessage('classFormMessage', '');
    });

    element('createClassForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      setButtonBusy(button, true, 'Създаване...');
      setMessage('classFormMessage', '');
      const result = await window.dbService.createClass(
        element('newClassName').value,
        element('newClassSchool').value,
      );
      setButtonBusy(button, false);

      if (!result.ok) {
        setMessage('classFormMessage', friendlyError(result, 'Класът не можа да се създаде.'), 'bad');
        return;
      }

      event.currentTarget.reset();
      element('newClassSchool').value = panelState.profile.school_name || '';
      event.currentTarget.hidden = true;
      setMessage('classFormMessage', `Класът е създаден с код ${result.data.class_code}.`, 'good');
      await loadClasses(result.data.id);
      if (panelState.profile.role === 'admin') await loadAdminOverview();
    });

    element('teacherClassList').addEventListener('click', event => {
      const button = event.target.closest('[data-class-id]');
      if (button) void selectClass(button.dataset.classId);
    });

    element('showAddStudentBtn').addEventListener('click', () => {
      element('addStudentForm').hidden = false;
      element('newStudentNumber').focus();
    });
    element('cancelAddStudentBtn').addEventListener('click', () => {
      element('addStudentForm').hidden = true;
      setMessage('studentFormMessage', '');
    });

    const studentPinInput = element('newStudentPin');
    const showStudentPinBtn = element('showStudentPinBtn');
    const showStudentPin = () => {
      studentPinInput.type = 'text';
      showStudentPinBtn.setAttribute('aria-pressed', 'true');
    };
    const hideStudentPin = () => {
      studentPinInput.type = 'password';
      showStudentPinBtn.setAttribute('aria-pressed', 'false');
    };

    studentPinInput.addEventListener('input', event => {
      event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 4);
    });
    showStudentPinBtn.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      showStudentPin();
    });
    showStudentPinBtn.addEventListener('pointerup', hideStudentPin);
    showStudentPinBtn.addEventListener('pointercancel', hideStudentPin);
    showStudentPinBtn.addEventListener('lostpointercapture', hideStudentPin);
    showStudentPinBtn.addEventListener('blur', hideStudentPin);
    showStudentPinBtn.addEventListener('keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      showStudentPin();
    });
    showStudentPinBtn.addEventListener('keyup', event => {
      if (event.key === ' ' || event.key === 'Enter') hideStudentPin();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideStudentPin();
    });
    window.addEventListener('blur', hideStudentPin);

    element('addStudentForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (!panelState.selectedClass) return;
      const studentNumber = Number(element('newStudentNumber').value);
      const studentName = element('newStudentName').value.trim();
      const pinCode = element('newStudentPin').value.trim();

      if (!Number.isInteger(studentNumber) || studentNumber < 1 || !studentName || !/^\d{4}$/.test(pinCode)) {
        setMessage('studentFormMessage', 'Попълнете номер в класа, име на ученика и ПИН код от 4 цифри.', 'bad');
        if (!Number.isInteger(studentNumber) || studentNumber < 1) element('newStudentNumber').focus();
        else if (!studentName) element('newStudentName').focus();
        else element('newStudentPin').focus();
        return;
      }

      const button = event.currentTarget.querySelector('button[type="submit"]');
      setButtonBusy(button, true, 'Добавяне...');
      setMessage('studentFormMessage', '');
      const result = await window.dbService.addStudentToClass(
        panelState.selectedClass.id,
        studentNumber,
        studentName,
        pinCode,
      );
      setButtonBusy(button, false);

      if (!result.ok) {
        setMessage('studentFormMessage', friendlyError(result, 'Ученикът не можа да се добави.'), 'bad');
        return;
      }

      event.currentTarget.reset();
      event.currentTarget.hidden = true;
      setMessage('studentFormMessage', 'Ученикът е добавен успешно.', 'good');
      await loadStudents();
      if (panelState.profile.role === 'admin') await loadAdminOverview();
    });

    element('classStudentRows').addEventListener('click', async event => {
      const button = event.target.closest('[data-delete-student-id]');
      if (!button) return;
      const student = panelState.students.find(item => item.id === button.dataset.deleteStudentId);
      if (!student || !window.confirm(`Сигурни ли сте, че искате да изтриете ученика ${student.display_name}?`)) return;

      setButtonBusy(button, true, 'Изтриване...');
      setMessage('studentFormMessage', '');
      const result = await window.dbService.deleteStudent(student.id);
      setButtonBusy(button, false);
      if (!result.ok) {
        setMessage('studentFormMessage', friendlyError(result, 'Ученикът не можа да бъде изтрит.'), 'bad');
        return;
      }

      setMessage('studentFormMessage', 'Ученикът е изтрит.', 'good');
      await loadStudents();
      if (panelState.profile.role === 'admin') await loadAdminOverview();
    });

    element('deleteClassBtn').addEventListener('click', async () => {
      if (!panelState.selectedClass) return;
      if (!window.confirm('Сигурни ли сте, че искате да изтриете класа?')) return;

      const button = element('deleteClassBtn');
      const deletedClassName = panelState.selectedClass.class_name;
      setButtonBusy(button, true, 'Изтриване...');
      setMessage('classFormMessage', '');
      const result = await window.dbService.deleteClass(panelState.selectedClass.id);
      setButtonBusy(button, false);
      if (!result.ok) {
        setMessage('studentFormMessage', friendlyError(result, 'Класът не можа да бъде изтрит.'), 'bad');
        return;
      }

      panelState.selectedClass = null;
      setMessage('classFormMessage', `Класът ${deletedClassName} е изтрит.`, 'good');
      await loadClasses();
      if (panelState.profile.role === 'admin') await loadAdminOverview();
    });

    element('loadOnlineJournalBtn').addEventListener('click', loadOnlineJournal);
  }

  function initTeacherPanel() {
    if (!window.authService || !window.dbService || !element('teacherAuthPanel')) return;
    bindAuthEvents();
    bindClassEvents();
    const authListener = window.authService.onAuthStateChange(() => {
      window.setTimeout(refreshAuthState, 0);
    });
    if (authListener && authListener.data && authListener.data.subscription) {
      window.addEventListener('pagehide', () => authListener.data.subscription.unsubscribe(), { once: true });
    }
    void refreshAuthState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTeacherPanel, { once: true });
  } else {
    initTeacherPanel();
  }
})();
