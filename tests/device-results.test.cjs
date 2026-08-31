const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { environment, profile, tick } = require('./access-navigation.cjs');

const guestResult = { student: '\u0413\u043e\u0441\u0442', game: 'Guest training', score: 3, total: 5, duration: '00:12', date: '31.08.26' };
const pupilResult = { student: 'Private pupil', game: 'Pupil training', score: 4, total: 5, duration: '00:15', date: '31.08.26' };
const student = { studentId: 'pupil', classId: 'class', studentName: 'Private pupil', className: 'Private class' };

function seedLog(env, entries = [guestResult, pupilResult]) {
  env.local.mathLog = JSON.stringify(entries);
  env.run('renderLog()');
}

test('the device-results panel is outside the teacher panel and hidden by default', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<button id="deviceResultsTab"[^>]*hidden>/);
  assert.match(html, /<section id="deviceResults"[^>]*hidden>/);
  const teacherMarkup = html.slice(html.indexOf('<section id="teacher"'), html.indexOf('<section id="deviceResults"'));
  assert.match(teacherMarkup, /id="onlineJournal"/);
  assert.doesNotMatch(teacherMarkup, /id="localLog"|id="clearLogBtn"/);
  assert.equal((html.match(/id="localLog"/g) || []).length, 1);
});

test('guests open a separate panel containing only guest results', async () => {
  const env = await environment();
  seedLog(env);
  assert.equal(env.node('deviceResultsTab').hidden, false);
  await env.node('deviceResultsTab').click();
  assert.deepEqual(env.active(), ['deviceResults']);
  assert.match(env.node('localLog').innerHTML, /Guest training/);
  assert.doesNotMatch(env.node('localLog').innerHTML, /Private pupil|Pupil training/);
  assert.match(env.node('teacherLogSummary').textContent, /1/);
  assert.equal(env.node('clearLogBtn').hidden, false);
  await env.node('tab-training').click();
  assert.deepEqual(env.active(), ['training']);
});

for (const role of ['teacher', 'admin']) {
  test(`${role}: local results and their navigation are hidden, online journal remains available`, async () => {
    const env = await environment({ ...profile, role }, null, { dbService: {
      async getAdminOverview() { return { ok: true, data: { teachers: 1, classes: 0, students: 0, games: 0 } }; },
    } });
    seedLog(env);
    env.node('onlineJournalRows').innerHTML = 'Online class result';
    assert.equal(env.node('deviceResultsTab').hidden, true);
    assert.equal(env.node('deviceResults').hidden, true);
    assert.equal(env.node('localLog').innerHTML, '');
    await env.node('deviceResultsTab').click();
    assert.notDeepEqual(env.active(), ['deviceResults']);
    assert.equal(env.node('onlineJournalRows').innerHTML, 'Online class result');
    const saved = env.local.mathLog;
    env.window.confirm = () => { throw Error('Teachers must not get a local deletion prompt'); };
    env.run('clearTeacherResults()');
    assert.equal(env.local.mathLog, saved);
  });
}

test('student profiles do not expose the shared guest history', async () => {
  const env = await environment(null, student);
  seedLog(env);
  assert.equal(env.node('deviceResultsTab').hidden, true);
  assert.equal(env.node('deviceResults').hidden, true);
  assert.equal(env.node('localLog').innerHTML, '');
});

test('local history stays hidden during initial teacher session lookup', async () => {
  let checks = 0;
  const env = await environment(profile, null, { inspectAuthPending(node) {
    assert.equal(node('deviceResultsTab').hidden, true);
    assert.equal(node('deviceResults').hidden, true);
    checks++;
  } });
  assert.ok(checks > 0);
  assert.equal(env.node('deviceResultsTab').hidden, true);
});

test('signing in while viewing local results immediately hides and empties them', async () => {
  const env = await environment();
  seedLog(env);
  await env.node('deviceResultsTab').click();
  env.window.dispatchEvent({ type: 'math:teacher-access', detail: { profile } });
  assert.equal(env.role(), 'teacher');
  assert.equal(env.node('deviceResults').hidden, true);
  assert.equal(env.node('deviceResultsTab').hidden, true);
  assert.equal(env.node('localLog').innerHTML, '');
  assert.deepEqual(env.active(), ['welcome']);
  assert.equal(JSON.parse(env.local.mathLog).length, 2);
});

test('successful teacher logout restores guest navigation, failed logout does not', async () => {
  const env = await environment(profile);
  seedLog(env);
  await env.headerLogout('teacher');
  assert.equal(env.node('deviceResultsTab').hidden, false);
  assert.match(env.node('localLog').innerHTML, /Guest training/);
  const failed = await environment(profile);
  failed.failLogout();
  await failed.headerLogout('teacher');
  assert.equal(failed.node('deviceResultsTab').hidden, true);
});

test('clearing guest results preserves student copies and makes no database calls', async () => {
  const env = await environment();
  seedLog(env);
  env.node('onlineJournalRows').innerHTML = 'Online class result';
  env.window.confirm = () => true;
  env.window.dbService = new Proxy({}, { get() { throw Error('Local clear must not access Supabase'); } });
  env.run('clearTeacherResults()');
  assert.deepEqual(JSON.parse(env.local.mathLog), [pupilResult]);
  assert.equal(env.node('onlineJournalRows').innerHTML, 'Online class result');
  assert.equal(env.node('localLog').innerHTML, '');
  assert.equal(env.node('clearLogBtn').hidden, true);
  seedLog(env, [guestResult]);
  env.run('clearTeacherResults()');
  assert.equal(env.local.mathLog, undefined);
});

test('cancelling local deletion preserves every result', async () => {
  const env = await environment();
  seedLog(env);
  const saved = env.local.mathLog;
  env.window.confirm = () => false;
  env.run('clearTeacherResults()');
  assert.equal(env.local.mathLog, saved);
});

test('new guest game results appear without changing the existing storage format', async () => {
  const env = await environment();
  env.run('saveResult("training", 2, 5, 2)');
  await tick();
  const entry = JSON.parse(env.local.mathLog)[0];
  assert.deepEqual(Object.keys(entry).sort(), ['date', 'duration', 'game', 'score', 'student', 'total']);
  assert.match(env.node('localLog').innerHTML, /training/);
});

test('an empty guest journal has one empty message and no deletion button', async () => {
  const env = await environment();
  seedLog(env, [pupilResult]);
  assert.ok(env.node('teacherLogSummary').textContent.length > 0);
  assert.equal(env.node('localLog').innerHTML, '');
  assert.equal(env.node('clearLogBtn').hidden, true);
});
