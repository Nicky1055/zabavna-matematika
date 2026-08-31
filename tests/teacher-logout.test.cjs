const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { environment, fillAuth, assertGuest, tick, profile } = require('./access-navigation.cjs');
const credentials = ['teacherLoginEmail', 'teacherLoginPassword', 'teacherRegisterEmail', 'teacherRegisterPassword'];

function assertBlank(env) {
  for (const id of credentials) assert.equal(env.node(id).value, '', id);
}

test('Supabase SIGNED_OUT clears both forms, without a guest-button click', async () => {
  const env = await environment(profile);
  await env.node('teacherAccessBtn').click();
  fillAuth(env);
  await env.signedOut();
  assertBlank(env);
  assertGuest(env);
});

test('entering the login panel from either navigation starts with blank fields', async () => {
  const env = await environment();
  for (const id of ['teacherAccessBtn', 'tab-teacher']) {
    fillAuth(env);
    await env.node(id).click();
    assertBlank(env);
  }
});

test('clearing also removes input defaults so form.reset cannot restore credentials', async () => {
  const env = await environment(profile);
  fillAuth(env);
  for (const id of credentials) env.node(id).defaultValue = env.node(id).value;
  await env.window.accessControl.switchToGuest();
  env.node('teacherLoginForm').reset();
  env.node('teacherRegisterForm').reset();
  assertBlank(env);
});

test('credentials are cleared immediately even when sign-out fails', async () => {
  const env = await environment(profile);
  await env.node('teacherAccessBtn').click();
  fillAuth(env);
  env.failLogout();
  const logout = env.window.accessControl.switchToGuest();
  assertBlank(env);
  assert.equal(await logout, false);
  assert.equal(env.role(), 'teacher');
  assert.match(env.node('accessStatusText').textContent, /Изходът не беше успешен/);
});

test('a delayed profile response cannot restore the teacher after logout', async () => {
  const env = await environment(profile);
  const release = await env.delayProfileRead();
  await env.window.accessControl.switchToGuest();
  release();
  await tick();
  await tick();
  assertGuest(env);
});

test('switching from teacher to student login also clears teacher credentials', async () => {
  const env = await environment(profile);
  fillAuth(env);
  await env.node('studentAccessBtn').click();
  await tick();
  assertBlank(env);
  assert.equal(env.node('studentLoginDialog').open, true);
});

test('logout checks the auth service even when the visible teacher profile is missing', async () => {
  const env = await environment();
  let calls = 0;
  env.window.authService.logoutTeacher = async () => { calls++; return { ok: true }; };
  assert.equal(await env.window.accessControl.switchToGuest(), true);
  assert.equal(calls, 1);
  assertGuest(env);
});

test('offline guest mode still works without a configured Supabase client', async () => {
  const env = await environment();
  fillAuth(env);
  env.window.authService.logoutTeacher = async () => ({ ok: false, reason: 'not_configured' });
  assert.equal(await env.window.accessControl.switchToGuest(), true);
  assertGuest(env);
});

test('browser history restoration clears old form values', async () => {
  const env = await environment();
  fillAuth(env);
  env.window.dispatchEvent({ type: 'pagehide' });
  assertBlank(env);
  fillAuth(env);
  env.window.dispatchEvent({ type: 'pageshow', persisted: true });
  assertBlank(env);
  await tick();
});

function authEnvironment({ session = { user: { id: 'test' } }, signOutError = null, keepSession = false } = {}) {
  let sessionReads = 0;
  let signOutCalls = 0;
  const window = { supabaseClient: { auth: {
    async getSession() { sessionReads++; return { data: { session }, error: null }; },
    async signOut() {
      signOutCalls++;
      if (!signOutError && !keepSession) session = null;
      return { error: signOutError };
    },
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'auth-service.js'), 'utf8'), {
    window, console: { warn() {} },
  });
  return { service: window.authService, reads: () => sessionReads, calls: () => signOutCalls };
}

test('auth service verifies that signOut removed the session', async () => {
  const auth = authEnvironment();
  assert.equal((await auth.service.logoutTeacher()).ok, true);
  assert.equal(auth.calls(), 1);
  assert.equal(auth.reads(), 2);
});

test('auth service reports failure if the SDK leaves an active session', async () => {
  const auth = authEnvironment({ keepSession: true });
  const result = await auth.service.logoutTeacher();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_not_cleared');
});

test('auth service reports network failure without claiming the session is closed', async () => {
  const auth = authEnvironment({ signOutError: new Error('Synthetic network failure') });
  assert.equal((await auth.service.logoutTeacher()).ok, false);
});

test('auth service avoids unnecessary signOut requests when no session exists', async () => {
  const auth = authEnvironment({ session: null });
  assert.equal((await auth.service.logoutTeacher()).ok, true);
  assert.equal(auth.calls(), 0);
});
