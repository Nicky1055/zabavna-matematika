const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(project, name), 'utf8');
const html = read('index.html');
const tick = () => new Promise(resolve => setImmediate(resolve));
const storage = data => ({
  getItem: key => data[key] ?? null,
  setItem: (key, value) => { data[key] = String(value); },
  removeItem: key => { delete data[key]; },
});
const profile = { id: 'teacher-test', full_name: 'Test teacher', school_name: 'Test school', role: 'teacher' };

async function environment(initialProfile = null, initialStudent = null, options = {}) {
  const nodes = new Map();
  const windowEvents = new Map();
  const documentEvents = new Map();
  let currentProfile = initialProfile;
  let failLogout = false;
  let logoutCalls = 0;
  let authCallback = null;
  let profileReadDelay = null;
  const timers = options.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const formInputs = {
    teacherLoginForm: ['teacherLoginEmail', 'teacherLoginPassword'],
    teacherRegisterForm: ['teacherRegisterName', 'teacherRegisterSchool', 'teacherRegisterEmail', 'teacherRegisterPassword'],
    studentClassCodeForm: ['studentClassCode'],
    studentPinLoginForm: ['studentLoginPin'],
  };
  class Element {
    constructor(id) {
      this.id = id; this.value = ''; this.defaultValue = ''; this.textContent = ''; this.innerHTML = '';
      this.hidden = false; this.disabled = false; this.open = false;
      this.dataset = {}; this.attrs = new Map(); this.handlers = new Map();
      this.children = []; this.parent = null;
      this.style = { setProperty() {} };
      const classes = new Set();
      Object.defineProperty(this, 'className', {
        get: () => [...classes].join(' '),
        set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
      });
      this.classList = {
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle(value, force = !classes.has(value)) { force ? classes.add(value) : classes.delete(value); },
      };
    }
    addEventListener(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(fn);
    }
    reset() { for (const id of formInputs[this.id] || []) node(id).value = node(id).defaultValue; }
    querySelectorAll(selector) { return selector === 'input' ? (formInputs[this.id] || []).map(node) : []; }
    querySelector() { return node(this.id + '-submit'); }
    setAttribute(key, value) { this.attrs.set(key, value); }
    hasAttribute(key) { return this.attrs.has(key); }
    removeAttribute(key) { this.attrs.delete(key); }
    focus() {}
    select() {}
    appendChild(child) { this.children.push(child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    scrollIntoView() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    async trigger(type, target = this) {
      const event = { currentTarget: this, target, preventDefault() {} };
      const pending = (this.handlers.get(type) || []).map(fn => fn(event));
      // Browsers clear currentTarget once synchronous event dispatch finishes.
      event.currentTarget = null;
      await Promise.all(pending);
      await tick();
    }
    click() { return this.trigger('click'); }
  }
  function node(id) { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) node(match[1]);
  const panels = ['welcome', 'training', 'bingo', 'families', 'robot', 'treasure', 'code', 'balloons', 'teacher'].map(node);
  const tabs = panels.slice(1).map(panel => { const tab = node('tab-' + panel.id); tab.dataset.tab = panel.id; return tab; });
  const roles = ['guest', 'student', 'teacher'].map(role => { const button = node(role + 'AccessBtn'); button.dataset.accessRole = role; return button; });
  const homeButtons = panels.slice(1, 8).map(panel => node('home-' + panel.id));
  const familyInputs = [...nodes.values()].filter(item => /^f[1-4][abc]$/.test(item.id));
  node('gameMode').value = 'all-tables';
  node('questionCount').value = '5';
  node('teacherCount').value = '10';
  node('teacherOperation').value = 'mixed';
  node('input[name="operation"]:checked').value = 'mixed';
  node('welcome').classList.add('active');
  const document = {
    readyState: 'loading', body: node('body'), getElementById: node,
    createElement(tag) { return node(tag + '-' + nodes.size); },
    querySelectorAll(selector) {
      if (selector === '.tab') return tabs;
      if (selector === '.panel') return panels;
      if (selector === '[data-access-role]') return roles;
      if (selector === '[data-game-home]') return homeButtons;
      if (selector === '.family-input') return familyInputs;
      if (selector === '.family-input, #trainingAnswer, #treasureAnswer, #codeAnswer') return [...familyInputs, ...['trainingAnswer', 'treasureAnswer', 'codeAnswer'].map(node)];
      if (selector === '.code-fireworks-screen') return [...nodes.values()].filter(item => item.parent && item.classList.contains('code-fireworks-screen'));
      return [];
    },
    querySelector(selector) {
      if (selector === '.tab[data-tab="teacher"]') return node('tab-teacher');
      return node(selector);
    },
    addEventListener(type, fn) {
      if (!documentEvents.has(type)) documentEvents.set(type, []);
      documentEvents.get(type).push(fn);
    },
  };
  const local = { mathStudent: 'Guest legacy name', mathLog: '[]' };
  if (initialStudent) local.mathStudentSession = JSON.stringify(initialStudent);
  const window = {
    localStorage: storage(local), sessionStorage: storage({}), ...timers,
    addEventListener(type, fn) {
      if (!windowEvents.has(type)) windowEvents.set(type, []);
      windowEvents.get(type).push(fn);
    },
    dispatchEvent(event) { for (const fn of windowEvents.get(event.type) || []) fn(event); },
    authService: {
      async getCurrentProfile() {
        const result = currentProfile ? { ok: true, profile: currentProfile } : { ok: false, reason: 'no_session' };
        const delay = profileReadDelay;
        profileReadDelay = null;
        if (delay) await delay;
        return result;
      },
      async loginTeacher() { await tick(); currentProfile = profile; return { ok: true, profile }; },
      async registerTeacher() { await tick(); return { ok: true, requiresEmailConfirmation: true }; },
      async logoutTeacher() {
        if (!currentProfile) return { ok: true };
        logoutCalls++;
        await tick();
        if (failLogout) return { ok: false, error: { message: 'Test network error' } };
        currentProfile = null;
        authCallback?.('SIGNED_OUT');
        return { ok: true };
      },
      onAuthStateChange(callback) { authCallback = callback; return null; },
    },
    dbService: { async getTeacherClasses() { return { ok: true, data: [] }; } },
  };
  const context = vm.createContext({
    window, document, console, ...timers, Date: options.Date || Date,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  });
  vm.runInContext(read('app.js').replace(/\binit\(\);\s*$/, ''), context);
  if (!options.realProgress) vm.runInContext('resetStudentProgress = () => {};', context);
  vm.runInContext('initTabs(); initStudent();', context);
  vm.runInContext(read('teacher-panel.js'), context);
  vm.runInContext(read('access-control.js'), context);
  for (const fn of documentEvents.get('DOMContentLoaded')) await fn();
  await tick(); await tick();
  return {
    node, window, local, run: code => vm.runInContext(code, context),
    async signedOut() {
      currentProfile = null;
      authCallback?.('SIGNED_OUT');
      await new Promise(resolve => setTimeout(resolve, 10));
    },
    async delayProfileRead() {
      let release;
      profileReadDelay = new Promise(resolve => { release = resolve; });
      authCallback?.('SIGNED_IN');
      await new Promise(resolve => setTimeout(resolve, 10));
      return release;
    },
    active: () => panels.filter(panel => panel.classList.contains('active')).map(panel => panel.id),
    role: () => window.accessControl.getCurrentRole(),
    failLogout: () => { failLogout = true; },
    logoutCalls: () => logoutCalls,
    async headerLogout(role) {
      await node('accessStatusActions').trigger('click', { closest: () => ({ dataset: { accessAction: role + '-logout' } }) });
      await tick(); await tick();
    },
  };
}

function fillAuth(env) {
  for (const id of ['teacherLoginEmail', 'teacherRegisterEmail']) env.node(id).value = 'synthetic@example.invalid';
  for (const id of ['teacherLoginPassword', 'teacherRegisterPassword']) env.node(id).value = 'Synthetic123!';
}
function assertGuest(env) {
  assert.equal(env.role(), 'guest');
  assert.deepEqual(env.active(), ['welcome']);
  assert.equal(env.node('teacherDashboard').hidden, true);
  assert.equal(env.node('teacherLoginForm').hidden, false);
  for (const id of ['teacherLoginEmail', 'teacherLoginPassword', 'teacherRegisterEmail', 'teacherRegisterPassword']) assert.equal(env.node(id).value, '');
  assert.equal(env.node('studentLoginDialog').open, false);
}

if (require.main === module) (async () => {
  const guest = await environment();
  await guest.node('teacherAccessBtn').click();
  assert.deepEqual(guest.active(), ['teacher']);
  fillAuth(guest);
  await guest.node('showTeacherRegisterBtn').click();
  await guest.node('guestAccessBtn').click();
  assertGuest(guest);
  assert.equal(guest.logoutCalls(), 0);
  await guest.node('tab-bingo').click();
  assert.deepEqual(guest.active(), ['bingo']);
  await guest.node('studentAccessBtn').click();
  assert.equal(guest.node('studentLoginDialog').open, true);
  await guest.window.accessControl.switchToGuest();
  assertGuest(guest);
  console.log('PASS: guest click closes teacher/login views, clears both forms, and keeps game selection/student modal working');

  const teacher = await environment();
  await teacher.node('teacherAccessBtn').click();
  fillAuth(teacher);
  await teacher.node('teacherLoginForm').trigger('submit');
  assert.equal(teacher.role(), 'teacher');
  assert.equal(teacher.node('teacherDashboard').hidden, false);
  assert.equal(teacher.node('teacherLoginEmail').value, '');
  fillAuth(teacher);
  await teacher.headerLogout('teacher');
  assertGuest(teacher);
  assert.equal(teacher.logoutCalls(), 1);
  console.log('PASS: async teacher login resets its captured form; header logout signs out once and shows welcome');

  const dashboard = await environment(profile);
  await dashboard.node('teacherAccessBtn').click();
  assert.equal(dashboard.node('teacherAuthPanel').hidden, true);
  fillAuth(dashboard);
  await dashboard.node('teacherLogoutBtn').click();
  assertGuest(dashboard);
  assert.equal(dashboard.logoutCalls(), 1);
  assert.equal(dashboard.node('teacherLogoutBtn').disabled, false);
  console.log('PASS: dashboard logout uses the same transition and restores the button state');

  const student = await environment(null, { studentId: 'student-test', classId: 'class-test', studentName: 'Test pupil', className: 'Test class' });
  await student.node('tab-training').click();
  fillAuth(student);
  await student.headerLogout('student');
  assertGuest(student);
  assert.equal(student.local.mathStudentSession, undefined);
  assert.equal(student.logoutCalls(), 0);
  console.log('PASS: student logout clears identity, credentials, and returns to welcome without teacher auth requests');

  const failed = await environment(profile);
  await failed.node('teacherAccessBtn').click();
  failed.failLogout();
  assert.equal(await failed.window.accessControl.switchToGuest(), false);
  assert.equal(failed.role(), 'teacher');
  assert.deepEqual(failed.active(), ['welcome']);
  console.log('PASS: failed sign-out does not falsely report a cleared session');

  const register = await environment();
  await register.node('teacherAccessBtn').click();
  await register.node('showTeacherRegisterBtn').click();
  fillAuth(register);
  await register.node('teacherRegisterForm').trigger('submit');
  assert.equal(register.node('teacherRegisterEmail').value, '');
  assert.equal(register.node('teacherLoginForm').hidden, false);
  console.log('PASS: async registration resets its captured form without currentTarget errors');
})().catch(error => { console.error(error); process.exitCode = 1; });


module.exports = { environment, fillAuth, assertGuest, tick, profile };
