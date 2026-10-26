const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { environment, profile, tick } = require('./access-navigation.cjs');

function serviceEnvironment({ error = null, found = true, signedIn = true } = {}) {
  const writes = [];
  const logs = [];
  const client = { from(table) {
    const filters = [];
    let payload;
    const query = {
      select(fields) { if (payload && Object.keys(payload).length === 1) assert.equal(fields, 'id'); return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      update(value) { payload = value; return query; },
      insert(value) { payload = value; return query; },
      single() { return query; }, maybeSingle() { return query; },
      then(resolve, reject) {
        if (payload) writes.push({ table, filters, payload });
        const ownClass = filters.some(([key, value]) => key === 'id' && value === 'class-a');
        return Promise.resolve(table === 'classes'
          ? { data: ownClass ? { id: 'class-a', teacher_id: profile.id } : null, error: null }
          : { data: found ? { id: 'student-a' } : null, error }).then(resolve, reject);
      },
    };
    return query;
  } };
  const window = { supabaseClient: client, authService: {
    async getCurrentProfile() { return signedIn ? { ok: true, user: { id: profile.id }, profile } : { ok: false, reason: 'no_session' }; },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'db-service.js'), 'utf8'), {
    window, console: { warn: message => logs.push(message) },
  });
  return { service: window.dbService, writes, logs };
}

test('PIN changes update only the selected student in the owned class and preserve leading zeroes', async () => {
  const env = serviceEnvironment();
  assert.equal((await env.service.changeStudentPin('class-a', 'student-a', '0123')).ok, true);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].payload.pin_code, '0123');
  assert.equal(Object.keys(env.writes[0].payload).join(), 'pin_code');
  assert.equal(JSON.stringify(env.writes[0].filters), JSON.stringify([['id', 'student-a'], ['class_id', 'class-a']]));
});

test('invalid PINs, signed-out callers and foreign classes never perform a write', async () => {
  for (const pin of ['', '123', '12345', '12a4']) {
    const env = serviceEnvironment();
    assert.equal((await env.service.changeStudentPin('class-a', 'student-a', pin)).reason, 'invalid_pin');
    assert.equal(env.writes.length, 0);
  }
  const foreign = serviceEnvironment();
  assert.equal((await foreign.service.changeStudentPin('class-b', 'student-b', '1234')).reason, 'forbidden');
  assert.equal(foreign.writes.length, 0);
  const signedOut = serviceEnvironment({ signedIn: false });
  assert.equal((await signedOut.service.changeStudentPin('class-a', 'student-a', '1234')).reason, 'no_session');
  assert.equal(signedOut.writes.length, 0);
});

test('database duplicate PIN errors are clear on both creation and reset', async () => {
  const env = serviceEnvironment({ error: { code: '23505', message: 'student_pin_in_use' } });
  assert.equal((await env.service.changeStudentPin('class-a', 'student-a', '1234')).reason, 'pin_in_use');
  assert.equal((await env.service.addStudentToClass('class-a', 2, 'Test', '1234')).reason, 'pin_in_use');
});

test('missing records are not reported as success and diagnostics never log PINs', async () => {
  const missing = serviceEnvironment({ found: false });
  assert.equal((await missing.service.changeStudentPin('class-a', 'deleted', '0123')).reason, 'not_found');
  const failure = serviceEnvironment({ error: { message: 'Synthetic error containing 0123' } });
  assert.equal((await failure.service.changeStudentPin('class-a', 'student-a', '0123')).ok, false);
  assert.doesNotMatch(failure.logs.join(), /0123/);
});

const classA = { id: 'class-a', class_name: 'A', class_code: 'MAT-AAAAAA' };
const classB = { id: 'class-b', class_name: 'B', class_code: 'MAT-BBBBBB' };
const students = [
  { id: 'student-a', class_id: classA.id, student_number: 1, display_name: 'Test pupil A' },
  { id: 'student-b', class_id: classA.id, student_number: 2, display_name: 'Test pupil B' },
];
const chooseClass = (env, classId) => env.node('teacherClassList').trigger('click', {
  closest: () => ({ dataset: { classId } }),
});
const openPin = (env, id = 'student-a') => env.node('classStudentRows').trigger('click', {
  closest: selector => selector === '[data-change-student-pin-id]' ? { dataset: { changeStudentPinId: id } } : null,
});
async function panelEnvironment(changeStudentPin) {
  const env = await environment(profile, null, { dbService: {
    async getTeacherClasses() { return { ok: true, data: [classA, classB] }; },
    async getStudentsByClass() { return { ok: true, data: students }; },
    changeStudentPin,
  } });
  await chooseClass(env, classA.id);
  return env;
}

test('the PIN form saves the selected student without replacing the student or results', async () => {
  let args;
  const env = await panelEnvironment(async (...values) => { args = values; return { ok: true }; });
  await openPin(env);
  assert.equal(env.node('changeStudentPinForm').hidden, false);
  assert.equal(env.node('changeStudentPinName').textContent, students[0].display_name);
  env.node('changedStudentPin').value = '0123';
  await env.node('changeStudentPinForm').trigger('submit');
  assert.deepEqual(args, ['class-a', 'student-a', '0123']);
  assert.equal(env.node('changedStudentPin').value, '');
  assert.equal(env.node('changeStudentPinForm').hidden, true);
  assert.match(env.node('studentFormMessage').textContent, /Test pupil A/);
});

test('a reused PIN shows an actionable error, clears the secret and permits retry', async () => {
  const env = await panelEnvironment(async () => ({ ok: false, reason: 'pin_in_use' }));
  await openPin(env);
  env.node('changedStudentPin').value = '1234';
  await env.node('changeStudentPinForm').trigger('submit');
  assert.match(env.node('changeStudentPinMessage').textContent, /друг ученик в класа/);
  assert.equal(env.node('changedStudentPin').value, '');
  assert.equal(env.node('changeStudentPinForm').hidden, false);
  assert.equal(env.node('changeStudentPinForm-submit').disabled, false);
});

test('invalid PINs are rejected before calling the service', async () => {
  let calls = 0;
  const env = await panelEnvironment(async () => { calls++; return { ok: true }; });
  await openPin(env);
  env.node('changedStudentPin').value = '123';
  await env.node('changeStudentPinForm').trigger('submit');
  assert.equal(calls, 0);
  assert.match(env.node('changeStudentPinMessage').textContent, /4 цифри/);
});

test('cancel, switching classes and signing out clear the selected student and PIN', async () => {
  const env = await panelEnvironment(async () => ({ ok: true }));
  for (const action of [() => env.node('cancelChangeStudentPinBtn').click(), () => chooseClass(env, classB.id), () => env.headerLogout('teacher')]) {
    await openPin(env);
    env.node('changedStudentPin').value = '0123';
    await action();
    assert.equal(env.node('changedStudentPin').value, '');
    assert.equal(env.node('changeStudentPinName').textContent, '');
    assert.equal(env.node('changeStudentPinForm').hidden, true);
  }
});

test('a late PIN change cannot overwrite another student form or a signed-out screen', async () => {
  let resolve;
  const env = await panelEnvironment(() => new Promise(done => { resolve = done; }));
  await openPin(env);
  env.node('changedStudentPin').value = '0123';
  const pending = env.node('changeStudentPinForm').trigger('submit');
  await tick();
  await openPin(env, 'student-b');
  env.node('changedStudentPin').value = '9876';
  resolve({ ok: true });
  await pending;
  assert.equal(env.node('changeStudentPinName').textContent, students[1].display_name);
  assert.equal(env.node('changedStudentPin').value, '9876');
  assert.equal(env.node('studentFormMessage').textContent, '');
  const second = env.node('changeStudentPinForm').trigger('submit');
  await tick();
  await env.headerLogout('teacher');
  resolve({ ok: true });
  await second;
  assert.equal(env.node('studentFormMessage').textContent, '');
  assert.equal(env.node('changeStudentPinForm').hidden, true);
});

test('leaving the page clears any unsubmitted PIN', async () => {
  const env = await panelEnvironment(async () => ({ ok: true }));
  await openPin(env);
  env.node('changedStudentPin').value = '1234';
  env.window.dispatchEvent({ type: 'pagehide' });
  assert.equal(env.node('changedStudentPin').value, '');
  assert.equal(env.node('changeStudentPinForm').hidden, true);
});

test('submitting again while saving neither duplicates the write nor loses the first response', async () => {
  let resolve;
  let calls = 0;
  const env = await panelEnvironment(() => { calls++; return new Promise(done => { resolve = done; }); });
  await openPin(env);
  env.node('changedStudentPin').value = '0123';
  const pending = env.node('changeStudentPinForm').trigger('submit');
  await tick();
  await env.node('changeStudentPinForm').trigger('submit');
  assert.equal(calls, 1);
  resolve({ ok: true });
  await pending;
  assert.equal(env.node('changeStudentPinForm').hidden, true);
  assert.match(env.node('studentFormMessage').textContent, /е сменен/);
});
