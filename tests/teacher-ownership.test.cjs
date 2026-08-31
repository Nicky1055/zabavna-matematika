const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { environment, tick, profile } = require('./access-navigation.cjs');

const teacherA = { id: 'teacher-a', role: 'teacher', school_name: 'Same school' };
const teacherB = { id: 'teacher-b', role: 'teacher', school_name: 'Same school' };
const classA = { id: 'class-a', teacher_id: teacherA.id, school_name: 'Same school', class_name: 'A', class_code: 'MAT-AAAAAA' };
const classB = { id: 'class-b', teacher_id: teacherB.id, school_name: 'Same school', class_name: 'B', class_code: 'MAT-BBBBBB' };
const studentA = { id: 'student-a', class_id: classA.id, student_number: 1, display_name: 'Pupil A' };
const studentB = { id: 'student-b', class_id: classB.id, student_number: 1, display_name: 'Pupil B' };

// This intentionally permissive fake checks client guards, not database RLS.
function serviceEnvironment(teacher = teacherA) {
  const rows = {
    classes: [classA, classB], students: [studentA, studentB],
    profiles: [teacherA, teacherB],
    game_results: [{ id: 'result-a', class_id: classA.id }, { id: 'result-b', class_id: classB.id }],
  };
  const writes = [];
  const reads = [];
  const client = {
    from(table) {
      const filters = [];
      let operation = 'read';
      let payload;
      let single = false;
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        maybeSingle() { single = true; return query; }, single() { single = true; return query; },
        insert(value) { operation = 'insert'; payload = value; return query; },
        delete() { operation = 'delete'; return query; },
        then(resolve, reject) {
          const data = rows[table].filter(row => filters.every(([key, value]) => row[key] === value));
          if (operation !== 'read') writes.push({ table, operation, payload, ids: data.map(row => row.id) });
          else reads.push({ table, filters });
          return Promise.resolve({
            data: operation === 'insert' ? { id: 'new-record', ...payload } : single ? data[0] || null : data,
            error: null, count: data.length,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const window = {
    supabaseClient: client,
    authService: {
      async getCurrentProfile() {
        return teacher ? { ok: true, user: { id: teacher.id }, profile: teacher } : { ok: false, reason: 'no_session' };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'db-service.js'), 'utf8'), {
    window, console: { info() {}, warn() {} }, Uint32Array,
  });
  return { service: window.dbService, writes, reads, window };
}

test('two teachers in the same school each list only their own classes', async () => {
  for (const [teacher, expected] of [[teacherA, classA], [teacherB, classB]]) {
    const { service } = serviceEnvironment(teacher);
    const result = await service.getTeacherClasses();
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.map(row => row.id), [expected.id]);
  }
});

test('a teacher cannot read, add to or delete the other teacher\'s class', async () => {
  for (const [teacher, foreignClass, foreignStudent] of [[teacherA, classB, studentB], [teacherB, classA, studentA]]) {
    const { service, writes, reads } = serviceEnvironment(teacher);
    const results = [
      await service.getStudentsByClass(foreignClass.id),
      await service.getClassResults(foreignClass.id),
      await service.addStudentToClass(foreignClass.id, 2, 'Test child', '1234'),
      await service.deleteStudent(foreignStudent.id),
      await service.deleteClass(foreignClass.id),
    ];
    results.forEach(result => { assert.equal(result.ok, false); assert.equal(result.reason, 'forbidden'); });
    assert.equal(writes.length, 0);
    assert.equal(reads.filter(read => read.table === 'game_results').length, 0);
  }
});

test('a teacher can manage their own class, students and journal', async () => {
  const { service, writes } = serviceEnvironment();
  assert.equal((await service.getStudentsByClass(classA.id)).data[0].id, studentA.id);
  assert.equal((await service.getClassResults(classA.id)).data[0].id, 'result-a');
  assert.equal((await service.addStudentToClass(classA.id, 2, 'New child', '5678')).ok, true);
  assert.equal((await service.deleteStudent(studentA.id)).ok, true);
  assert.equal((await service.deleteClass(classA.id)).ok, true);
  assert.equal(writes.length, 3);
    assert.ok(writes.filter(write => write.operation === 'delete')
      .every(write => !write.ids.includes(classB.id) && !write.ids.includes(studentB.id)));
});

test('new teacher classes use their profile school and authenticated owner', async () => {
  const { service, writes } = serviceEnvironment();
  assert.equal((await service.createClass('New class', 'Another school')).ok, true);
  assert.equal(writes[0].payload.school_name, teacherA.school_name);
  assert.equal(writes[0].payload.teacher_id, teacherA.id);
});

test('signed-out and invalid-role callers cannot use teacher operations', async () => {
  for (const teacher of [null, { ...teacherA, role: 'student' }]) {
    const { service, writes } = serviceEnvironment(teacher);
    for (const result of [
      await service.getTeacherClasses(), await service.createClass('New', 'School'),
      await service.getStudentsByClass(classA.id), await service.getClassResults(classA.id),
      await service.addStudentToClass(classA.id, 2, 'Test', '1234'),
      await service.deleteStudent(studentA.id), await service.deleteClass(classA.id),
      await service.getAdminOverview(),
    ]) assert.equal(result.ok, false);
    assert.equal(writes.length, 0);
  }
});

test('a profile with a different user ID is rejected', async () => {
  const env = serviceEnvironment();
  env.window.authService.getCurrentProfile = async () => ({ ok: true, user: { id: teacherB.id }, profile: teacherA });
  assert.equal((await env.service.getTeacherClasses()).reason, 'forbidden');
});

test('admin retains cross-class access, while teachers cannot load admin totals', async () => {
  const admin = serviceEnvironment({ ...teacherA, role: 'admin' });
  assert.equal((await admin.service.getTeacherClasses()).data.length, 2);
  assert.equal((await admin.service.getStudentsByClass(classB.id)).data[0].id, studentB.id);
  assert.equal((await admin.service.getClassResults(classB.id)).ok, true);
  assert.equal((await admin.service.getAdminOverview()).ok, true);
  assert.equal((await serviceEnvironment().service.getAdminOverview()).reason, 'forbidden');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const chooseClass = (env, classId) => env.node('teacherClassList').trigger('click', {
  closest: () => ({ dataset: { classId } }),
});

test('old students and journal rows disappear immediately when changing classes', async () => {
  const slow = deferred();
  const env = await environment(profile, null, { dbService: {
    async getTeacherClasses() { return { ok: true, data: [classA, classB] }; },
    async getStudentsByClass(id) { return id === classB.id ? slow.promise : { ok: true, data: [studentA] }; },
    async getClassResults() { return { ok: true, data: [{ student_name: 'Old result', game_key: 'training' }] }; },
  } });
  await chooseClass(env, classA.id);
  await env.node('loadOnlineJournalBtn').click();
  assert.match(env.node('classStudentRows').innerHTML, /Pupil A/);
  assert.match(env.node('onlineJournalRows').innerHTML, /Old result/);
  await chooseClass(env, classB.id);
  assert.equal(env.node('classStudentRows').innerHTML, '');
  assert.equal(env.node('onlineJournalRows').innerHTML, '');
  slow.resolve({ ok: true, data: [studentB] });
  await tick();
  assert.match(env.node('classStudentRows').innerHTML, /Pupil B/);
});

test('late class, student and journal responses cannot reveal data after logout', async () => {
  for (const operation of ['classes', 'students', 'journal']) {
    const slow = deferred();
    const env = await environment(profile, null, { dbService: {
      async getTeacherClasses() { return operation === 'classes' ? slow.promise : { ok: true, data: [classA] }; },
      async getStudentsByClass() { return operation === 'students' ? slow.promise : { ok: true, data: [studentA] }; },
      async getClassResults() { return slow.promise; },
    } });
    if (operation !== 'classes') await chooseClass(env, classA.id);
    const journalRequest = operation === 'journal' ? env.node('loadOnlineJournalBtn').click() : null;
    await env.headerLogout('teacher');
    slow.resolve({ ok: true, data: operation === 'classes' ? [classA] : operation === 'students' ? [studentA] : [{ student_name: 'Private result' }] });
    if (journalRequest) await journalRequest;
    await tick();
    for (const id of ['teacherClassList', 'classStudentRows', 'onlineJournalRows']) assert.equal(env.node(id).innerHTML, '');
    assert.equal(env.node('classDetail').hidden, true);
    assert.equal(env.role(), 'guest');
  }
});

test('late journal response from another class cannot replace the current class journal', async () => {
  const slow = deferred();
  const env = await environment(profile, null, { dbService: {
    async getTeacherClasses() { return { ok: true, data: [classA, classB] }; },
    async getStudentsByClass() { return { ok: true, data: [] }; },
    async getClassResults(id) { return id === classA.id ? slow.promise : { ok: true, data: [{ student_name: 'Current class result' }] }; },
  } });
  await chooseClass(env, classA.id);
  const oldRequest = env.node('loadOnlineJournalBtn').click();
  await tick();
  await chooseClass(env, classB.id);
  await env.node('loadOnlineJournalBtn').click();
  slow.resolve({ ok: true, data: [{ student_name: 'Old class result' }] });
  await oldRequest;
  assert.match(env.node('onlineJournalRows').innerHTML, /Current class result/);
  assert.doesNotMatch(env.node('onlineJournalRows').innerHTML, /Old class result/);
});

test('school is read-only for teachers, not administrators', async () => {
  assert.equal((await environment(profile)).node('newClassSchool').readOnly, true);
  assert.equal((await environment({ ...profile, role: 'admin' }, null, { dbService: {
    async getAdminOverview() { return { ok: true, data: { teachers: 1, classes: 0, students: 0, games: 0 } }; },
  } })).node('newClassSchool').readOnly, false);
});

test('reopening the teacher panel restores its data after a failed sign-out', async () => {
  const env = await environment(profile, null, { dbService: {
    async getTeacherClasses() { return { ok: true, data: [classA] }; },
  } });
  env.failLogout();
  await env.window.accessControl.switchToGuest();
  assert.equal(env.node('teacherClassList').innerHTML, '');
  await env.node('teacherAccessBtn').click();
  await tick();
  assert.equal(env.node('teacherProfileName').textContent, profile.full_name);
  assert.match(env.node('teacherClassList').innerHTML, /MAT-AAAAAA/);
});
