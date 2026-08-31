const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environment, tick, profile } = require('./access-navigation.cjs');

const classA = { id: 'class-a', class_name: 'A', class_code: 'MAT-AAAAAA' };
const classB = { id: 'class-b', class_name: 'B', class_code: 'MAT-BBBBBB' };
const chooseClass = (env, classId) => env.node('teacherClassList').trigger('click', {
  closest: () => ({ dataset: { classId } }),
});
const refresh = env => env.node('loadOnlineJournalBtn').click();
const message = env => env.node('onlineJournalMessage').textContent;
const timestamp = env => env.node('onlineJournalUpdatedAt').textContent;
const row = id => ({ id, student_name: 'Test pupil', game_key: 'training', score: 3, total_questions: 5, stars: 1 });
const initialTime = Date.parse('2026-08-31T10:00:00Z');
const formatTime = time => new Date(time).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'medium' });

async function journalEnvironment() {
  let response = { ok: true, data: [row('result-1')] };
  let time = initialTime;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const env = await environment(profile, null, { Date: Clock, dbService: {
    async getTeacherClasses() { return { ok: true, data: [classA, classB] }; },
    async getStudentsByClass() { return { ok: true, data: [] }; },
    async getClassResults() { return response; },
  } });
  await chooseClass(env, classA.id);
  return Object.assign(env, {
    respond(value) { response = value; },
    advance() { time += 60000; return time; },
  });
}

test('journal feedback is an accessible status immediately above the table', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="onlineJournalMessage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="loadOnlineJournalBtn"') < html.indexOf('id="onlineJournalMessage"'));
  assert.ok(html.indexOf('id="onlineJournalUpdatedAt"') < html.indexOf('id="onlineJournal"'));
  assert.equal((html.match(/id="onlineJournalMessage"/g) || []).length, 1);
});

test('first load confirms success without labelling existing results as new', async () => {
  const env = await journalEnvironment();
  assert.equal(env.node('onlineJournalUpdatedAt').hidden, true);
  await refresh(env);
  assert.equal(message(env), 'Дневникът е зареден.');
  assert.equal(timestamp(env), `Последно успешно обновяване: ${formatTime(initialTime)}`);
  assert.equal(env.node('onlineJournalUpdatedAt').hidden, false);
  assert.equal(env.node('onlineJournalMessage').className, 'feedback good');
});

test('unchanged results confirm no new results and update the time', async () => {
  const env = await journalEnvironment();
  await refresh(env);
  const rows = env.node('onlineJournalRows').innerHTML;
  const nextTime = env.advance();
  await refresh(env);
  assert.equal(message(env), 'Дневникът е обновен. Няма нови резултати.');
  assert.equal(env.node('onlineJournalRows').innerHTML, rows);
  assert.equal(timestamp(env), `Последно успешно обновяване: ${formatTime(nextTime)}`);
});

test('new results use singular and plural counts based on IDs, not row count', async () => {
  const env = await journalEnvironment();
  await refresh(env);
  env.respond({ ok: true, data: [row('result-2')] });
  await refresh(env);
  assert.equal(message(env), 'Дневникът е обновен. Добавен е 1 нов резултат.');
  env.respond({ ok: true, data: [row('result-4'), row('result-3'), row('result-2')] });
  await refresh(env);
  assert.equal(message(env), 'Дневникът е обновен. Добавени са 2 нови резултата.');
});

test('empty journals and removed rows do not produce negative or new-result counts', async () => {
  const env = await journalEnvironment();
  await refresh(env);
  env.respond({ ok: true, data: [] });
  await refresh(env);
  assert.equal(message(env), 'Дневникът е обновен. Няма нови резултати.');
  assert.equal(env.node('onlineJournalEmpty').hidden, false);
  await chooseClass(env, classB.id);
  await refresh(env);
  assert.equal(message(env), 'Дневникът е зареден.');
});

test('failed refresh keeps previous rows, timestamp and comparison baseline', async () => {
  const env = await journalEnvironment();
  await refresh(env);
  const rows = env.node('onlineJournalRows').innerHTML;
  const previousTime = timestamp(env);
  env.advance();
  env.respond({ ok: false, error: { message: 'Test network failure' } });
  await refresh(env);
  assert.equal(env.node('onlineJournalMessage').className, 'feedback bad');
  assert.equal(timestamp(env), previousTime);
  assert.equal(env.node('onlineJournalRows').innerHTML, rows);
  assert.equal(env.node('loadOnlineJournalBtn').disabled, false);
  env.respond({ ok: true, data: [row('result-2'), row('result-1')] });
  await refresh(env);
  assert.equal(message(env), 'Дневникът е обновен. Добавен е 1 нов резултат.');
});

test('a failed initial load does not claim a successful update time', async () => {
  const env = await journalEnvironment();
  env.respond({ ok: false, reason: 'not_configured' });
  await refresh(env);
  assert.equal(env.node('onlineJournalUpdatedAt').hidden, true);
  assert.equal(timestamp(env), '');
  env.respond({ ok: true, data: [row('result-1')] });
  await refresh(env);
  assert.equal(message(env), 'Дневникът е зареден.');
});

test('class switches and logout clear refresh feedback and timestamp', async () => {
  const env = await journalEnvironment();
  await refresh(env);
  await chooseClass(env, classB.id);
  assert.equal(message(env), '');
  assert.equal(timestamp(env), '');
  assert.equal(env.node('onlineJournalUpdatedAt').hidden, true);
  await refresh(env);
  assert.equal(message(env), 'Дневникът е зареден.');
  await env.headerLogout('teacher');
  assert.equal(message(env), '');
  assert.equal(timestamp(env), '');
  assert.equal(env.node('onlineJournalUpdatedAt').hidden, true);
});

test('pending and stale requests cannot overwrite the current class feedback', async () => {
  const env = await journalEnvironment();
  await refresh(env);
  const previousTime = timestamp(env);
  let resolve;
  env.respond(new Promise(done => { resolve = done; }));
  const pending = refresh(env);
  await tick();
  assert.equal(env.node('loadOnlineJournalBtn').disabled, true);
  assert.equal(message(env), '');
  assert.equal(timestamp(env), previousTime);
  await chooseClass(env, classB.id);
  env.respond({ ok: true, data: [] });
  await refresh(env);
  const currentMessage = message(env);
  const currentTime = timestamp(env);
  env.advance();
  resolve({ ok: true, data: [row('old-class-result')] });
  await pending;
  assert.equal(message(env), currentMessage);
  assert.equal(timestamp(env), currentTime);
});
