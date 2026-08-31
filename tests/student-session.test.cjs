const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { environment, tick } = require('./access-navigation.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'db-service.js'), 'utf8');
const session = {
  studentId: 'pupil', classId: 'class', studentName: 'Test pupil', className: 'Test class',
  classCode: 'MAT-123456', sessionToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z',
};
function service(role = 'student', savedSession = session, response = { data: { ok: true } }) {
  const calls = [];
  const warnings = [];
  const local = { mathLog: '[{"score":3}]', mathStudentSession: JSON.stringify(savedSession) };
  const window = {
    localStorage: { getItem: key => local[key] || null },
    accessControl: { getCurrentRole: () => role },
    supabaseClient: {
      from() { throw Error('Student flow must not use direct table access'); },
      async rpc(name, args) {
        calls.push({ name, args });
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
  vm.runInNewContext(source, { window, console: { warn: m => warnings.push(m), info() {} } });
  return { db: window.dbService, calls, warnings, local };
}

test('connection check uses the restricted health RPC, not classes SELECT', async () => {
  const env = service();
  assert.equal((await env.db.checkConnection()).ok, true);
  assert.equal(env.calls[0].name, 'math_check_connection');
});
test('student login sends class code and PIN only to restricted RPCs', async () => {
  const env = service();
  await env.db.getClassByCode(' mat-123456 ');
  await env.db.getStudentsForLogin('class', 'mat-123456');
  await env.db.verifyStudentPin('pupil', 'class', '0123', 'mat-123456');
  assert.deepEqual(env.calls.map(c => c.name), ['math_find_class', 'math_students_for_login', 'math_student_login']);
  assert.equal(env.calls[1].args.p_class_code, 'MAT-123456');
  assert.equal(env.calls[2].args.p_pin, '0123');
  assert.equal(env.calls[2].args.p_class_code, 'MAT-123456');
});
test('invalid PIN never reaches the database', async () => {
  const env = service();
  for (const pin of ['', '123', '12345', '12ab']) assert.equal((await env.db.verifyStudentPin('pupil','class',pin,'MAT-123456')).ok, false);
  assert.equal(env.calls.length, 0);
});
for (const gameKey of ['training', 'bingo', 'families', 'robot', 'treasure', 'secret_code', 'balloons']) {
  test(`${gameKey}: result sync sends token, never caller-supplied identity`, async () => {
    const env = service('student', { ...session, studentId: 'forged', classId: 'forged', studentName: 'forged' });
    const result = await env.db.saveGameResult({ gameKey, score: 3, totalQuestions: 5, stars: 2, timeSpentSeconds: 12.8 });
    assert.equal(result.ok, true);
    assert.equal(env.calls[0].name, 'math_save_game_result');
    assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].args)), {
      p_session_token: session.sessionToken, p_game_key: gameKey, p_score: 3,
      p_total_questions: 5, p_stars: 2, p_time_spent_seconds: 12,
    });
    assert.equal(env.local.mathLog, '[{"score":3}]');
  });
}
test('guest and teacher modes never upload a cached student result', async () => {
  for (const role of ['guest', 'teacher']) {
    const env = service(role);
    assert.equal((await env.db.saveGameResult({ score: 1 })).skipped, true);
    assert.equal(env.calls.length, 0);
  }
});
test('legacy and expired sessions cannot upload results', async () => {
  for (const stored of [{ studentId: 'pupil', classId: 'class', studentName: 'Legacy' }, { ...session, expiresAt: '2000-01-01' }]) {
    const env = service('student', stored);
    assert.equal((await env.db.saveGameResult({ score: 1 })).reason, 'session_expired');
    assert.equal(env.calls.length, 0);
  }
});
test('network errors preserve mathLog and do not leak tokens into diagnostics', async () => {
  for (const response of [new Error(session.sessionToken), { error: { message: session.sessionToken } }]) {
    const env = service('student', session, response);
    assert.equal((await env.db.saveGameResult({ score: 1 })).ok, false);
    assert.equal(env.local.mathLog, '[{"score":3}]');
    assert.equal(env.warnings.some(m => m.includes(session.sessionToken)), false);
  }
});
test('old identity-only browser sessions are discarded on reload', async () => {
  const env = await environment(null, { studentId: 'old', classId: 'old', studentName: 'Old', className: 'Old' }, { legacyStudent: true });
  assert.equal(env.role(), 'guest');
  assert.equal(env.local.mathStudentSession, undefined);
});
test('Guest clears local identity and revokes the server token', async () => {
  const revoked = [];
  const env = await environment(null, session, { dbService: {
    async revokeStudentSession(token) { revoked.push(token); return { ok: true }; },
  } });
  await env.node('guestAccessBtn').click();
  await tick();
  assert.equal(env.role(), 'guest');
  assert.equal(env.local.mathStudentSession, undefined);
  assert.deepEqual(revoked, [session.sessionToken]);
});
test('reload replaces cached identity with the server-verified pupil', async () => {
  const env = await environment(null, { ...session, studentName: 'Tampered' }, { dbService: {
    async validateStudentSession(token) { assert.equal(token, session.sessionToken); return { ok: true, data: session }; },
  } });
  assert.equal(env.role(), 'student');
  assert.equal(JSON.parse(env.local.mathStudentSession).studentName, session.studentName);
});
test('a server-revoked session returns to guest on reload', async () => {
  const env = await environment(null, session, { dbService: {
    async validateStudentSession() { return { ok: false, reason: 'session_expired' }; },
  } });
  assert.equal(env.role(), 'guest');
  assert.equal(env.local.mathStudentSession, undefined);
});
test('PIN login stores a verified session and clears PIN input', async () => {
  const env = await environment(null, null, { dbService: {
    async getClassByCode() { return { ok: true, data: { id: 'class', class_name: 'Test class', class_code: 'MAT-123456' } }; },
    async getStudentsForLogin(id, code) { assert.equal(code, 'MAT-123456'); return { ok: true, data: [{ id: 'pupil', student_number: 1, display_name: 'Test pupil' }] }; },
    async verifyStudentPin(id, classId, pin, code) {
      assert.equal(pin, '0123'); assert.equal(code, 'MAT-123456');
      return { ok: true, data: { id, class_id: classId, student_number: 1, display_name: 'Test pupil', session_token: session.sessionToken, expires_at: session.expiresAt } };
    },
  } });
  await env.node('studentAccessBtn').click();
  env.node('studentClassCode').value = 'MAT-123456';
  await env.node('studentClassCodeForm').trigger('submit');
  await env.node('studentLoginChoices').trigger('click', { closest: () => ({ dataset: { studentLoginId: 'pupil' } }) });
  env.node('studentLoginPin').value = '0123';
  await env.node('studentPinLoginForm').trigger('submit');
  assert.equal(env.role(), 'student');
  assert.equal(JSON.parse(env.local.mathStudentSession).sessionToken, session.sessionToken);
  assert.equal(env.node('studentLoginPin').value, '');
});
test('local result is still written when cloud sync fails', async () => {
  const env = await environment(null, null, { dbService: {
    async saveGameResult() { return { ok: false, reason: 'network_or_database_error' }; },
  } });
  env.run('saveResult("training", 3, 5, 2)');
  await tick();
  const entry = JSON.parse(env.local.mathLog)[0];
  assert.equal(entry.score, 3);
  assert.equal(entry.total, 5);
});
