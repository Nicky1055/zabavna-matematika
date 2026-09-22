const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { environment } = require('./access-navigation.cjs');

const authSource = fs.readFileSync(path.join(__dirname, '..', 'auth-service.js'), 'utf8');

function serviceEnvironment(overrides = {}) {
  const calls = { reset: [], resend: [], update: [] };
  const auth = {
    async resetPasswordForEmail(email, options) {
      calls.reset.push({ email, options });
      return { error: null };
    },
    async resend(payload) {
      calls.resend.push(payload);
      return { error: null };
    },
    async updateUser(payload) {
      calls.update.push(payload);
      return { data: { user: { id: 'teacher-test' } }, error: null };
    },
    ...overrides,
  };
  const window = {
    location: {
      protocol: 'https:',
      origin: 'https://example.test',
      pathname: '/zabavna-matematika/',
    },
    supabaseClient: { auth },
  };
  vm.runInNewContext(authSource, { window, console: { warn() {} } });
  return { service: window.authService, calls };
}

test('auth recovery requests use a normalized email and return to the current site', async () => {
  const auth = serviceEnvironment();
  assert.equal((await auth.service.requestPasswordReset('  Teacher@Example.COM ')).ok, true);
  assert.equal(auth.calls.reset.length, 1);
  assert.equal(auth.calls.reset[0].email, 'teacher@example.com');
  assert.equal(auth.calls.reset[0].options.redirectTo, 'https://example.test/zabavna-matematika/');

  assert.equal((await auth.service.resendTeacherConfirmation(' Teacher@Example.COM ')).ok, true);
  assert.equal(auth.calls.resend.length, 1);
  assert.equal(auth.calls.resend[0].type, 'signup');
  assert.equal(auth.calls.resend[0].email, 'teacher@example.com');
  assert.equal(auth.calls.resend[0].options.emailRedirectTo, 'https://example.test/zabavna-matematika/');
});

test('auth recovery validates email and password before contacting Supabase', async () => {
  const auth = serviceEnvironment();
  assert.equal((await auth.service.requestPasswordReset('')).reason, 'missing_email');
  assert.equal((await auth.service.resendTeacherConfirmation('not-an-email')).reason, 'invalid_email');
  assert.equal((await auth.service.updateTeacherPassword('short')).reason, 'weak_password');
  assert.equal(auth.calls.reset.length, 0);
  assert.equal(auth.calls.resend.length, 0);
  assert.equal(auth.calls.update.length, 0);
});

test('auth recovery reports Supabase failures without throwing', async () => {
  const expected = new Error('Synthetic network failure');
  const auth = serviceEnvironment({
    async resetPasswordForEmail() { return { error: expected }; },
    async resend() { throw expected; },
  });
  assert.equal((await auth.service.requestPasswordReset('teacher@example.com')).ok, false);
  assert.equal((await auth.service.resendTeacherConfirmation('teacher@example.com')).ok, false);
});

test('teacher login offers reset and confirmation actions with clear feedback', async () => {
  const env = await environment();
  await env.node('teacherAccessBtn').click();

  await env.node('forgotTeacherPasswordBtn').click();
  assert.match(env.node('teacherAuthMessage').textContent, /Въведете имейла/);

  env.node('teacherLoginEmail').value = 'teacher@example.com';
  await env.node('forgotTeacherPasswordBtn').click();
  assert.match(env.node('teacherAuthMessage').textContent, /изпратихме връзка/i);

  await env.node('resendTeacherConfirmationBtn').click();
  assert.match(env.node('teacherAuthMessage').textContent, /ново писмо за потвърждение/i);
});

test('PASSWORD_RECOVERY shows the new-password form and rejects mismatched values', async () => {
  const env = await environment();
  await env.authEvent('PASSWORD_RECOVERY');

  assert.equal(env.node('teacherPasswordUpdateForm').hidden, false);
  assert.equal(env.node('teacherLoginForm').hidden, true);
  assert.equal(env.node('teacherAuthSwitch').hidden, true);
  assert.equal(env.node('teacherDashboard').hidden, true);

  env.node('teacherNewPassword').value = 'NewPassword123!';
  env.node('teacherNewPasswordConfirm').value = 'Different123!';
  await env.node('teacherPasswordUpdateForm').trigger('submit');
  assert.match(env.node('teacherAuthMessage').textContent, /не съвпадат/);
});

test('a successful password update clears the recovery form and returns to login', async () => {
  const env = await environment();
  await env.authEvent('PASSWORD_RECOVERY');
  env.node('teacherNewPassword').value = 'NewPassword123!';
  env.node('teacherNewPasswordConfirm').value = 'NewPassword123!';
  await env.node('teacherPasswordUpdateForm').trigger('submit');

  assert.equal(env.node('teacherPasswordUpdateForm').hidden, true);
  assert.equal(env.node('teacherLoginForm').hidden, false);
  assert.equal(env.node('teacherNewPassword').value, '');
  assert.equal(env.node('teacherNewPasswordConfirm').value, '');
  assert.match(env.node('teacherAuthMessage').textContent, /Паролата е сменена/);
});

test('a failed recovery-session logout never pretends the account is signed out', async () => {
  const env = await environment();
  await env.authEvent('PASSWORD_RECOVERY');
  env.failLogout();
  await env.node('cancelTeacherPasswordUpdateBtn').click();

  assert.equal(env.node('teacherPasswordUpdateForm').hidden, false);
  assert.equal(env.node('teacherLoginForm').hidden, true);
  assert.match(env.node('teacherAuthMessage').textContent, /не можа да бъде затворена/);
});
