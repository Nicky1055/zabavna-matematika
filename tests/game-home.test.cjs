const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { environment, tick, profile } = require('./access-navigation.cjs');

function clock() {
  let now = 1000;
  let nextId = 1;
  const jobs = new Map();
  const schedule = (fn, delay, interval = 0) => {
    const id = nextId++;
    jobs.set(id, { fn, at: now + delay, interval });
    return id;
  };
  return {
    Date: class extends Date { static now() { return now; } },
    timers: {
      setTimeout: (fn, delay) => schedule(fn, delay),
      clearTimeout: id => jobs.delete(id),
      setInterval: (fn, delay) => schedule(fn, delay, delay),
      clearInterval: id => jobs.delete(id),
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, job] = next;
        now = job.at;
        if (job.interval) job.at += job.interval;
        else jobs.delete(id);
        job.fn();
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}

async function setup(student = null, teacher = null) {
  const time = clock();
  const env = await environment(teacher, student, { timers: time.timers, Date: time.Date, realProgress: true });
  env.run('getAudio = () => null; playCheerfulApplause = () => {};');
  return { ...env, time };
}

const games = {
  training: 'startTraining()',
  bingo: 'newBingo()',
  families: 'newFamily(); fillFamily()',
  robot: 'newRobot()',
  treasure: 'startTreasure()',
  code: 'newCode()',
  balloons: 'startBalloons()',
};

function assertCleared(env) {
  assert.deepEqual(env.active(), ['welcome']);
  assert.equal(env.run('state.timerRunning'), false);
  assert.equal(env.run('pendingGameTimeouts.size'), 0);
  assert.equal(env.run('state.training.tasks.length + state.bingo.board.length + state.treasure.tasks.length + state.code.tasks.length'), 0);
  assert.equal(env.run('state.family === null && state.robot === null && state.balloons.task === null'), true);
  for (const id of ['bingoBoard', 'robotChoices', 'treasureTrack', 'secretMessage', 'balloonField']) assert.equal(env.node(id).innerHTML, '', id);
  for (const id of ['trainingAnswer', 'treasureAnswer', 'codeAnswer', 'f1a', 'f4c']) assert.equal(env.node(id).value, '', id);
}

for (const [game, start] of Object.entries(games)) {
  test(`${game}: Home stops and clears the game, preserving identity, points and elapsed time`, async () => {
    const student = { studentId: 'pupil', classId: 'class', studentName: 'Test pupil', className: 'Test class' };
    const env = await setup(student);
    await env.node('tab-' + game).click();
    env.run('setStars(12)');
    env.run(start);
    env.time.advance(2500);
    const elapsed = env.run('currentElapsedMs()');
    const identity = env.local.mathStudentSession;
    const log = env.local.mathLog;
    await env.node('home-' + game).click();
    assertCleared(env);
    assert.equal(env.role(), 'student');
    assert.equal(env.local.mathStudentSession, identity);
    assert.equal(env.local.mathStars, '12');
    assert.equal(env.local.mathLog, log);
    assert.equal(env.run('currentElapsedMs()'), elapsed);
    env.time.advance(12000);
    assertCleared(env);
    assert.equal(env.run('currentElapsedMs()'), elapsed);
    await env.node('tab-' + game).click();
    env.run(start);
    assert.equal(env.run('state.timerRunning'), true);
    env.time.advance(1000);
    assert.equal(env.run('currentElapsedMs()'), elapsed + 1000);
    await env.node('home-' + game).click();
  });
}

const pendingRounds = {
  training: 'startTraining(); $("trainingAnswer").value = state.training.tasks[0].answer; checkTraining()',
  robot: 'newRobot(); answerRobot(!state.robot.truthful)',
  treasure: 'startTreasure(); state.treasure.index = 5; $("treasureAnswer").value = state.treasure.tasks[5].answer; checkTreasure()',
  balloons: 'startBalloons(); state.balloons.round = 7; clickBalloon({ dataset: { value: state.balloons.task.answer }, classList: { add() {} } })',
};
for (const [game, prepare] of Object.entries(pendingRounds)) {
  test(`${game}: no delayed task, timer restart or final result after Home`, async () => {
    const env = await setup();
    await env.node('tab-' + game).click();
    env.run(prepare);
    const stars = env.local.mathStars;
    const log = env.local.mathLog;
    await env.node('home-' + game).click();
    env.time.advance(20000);
    assertCleared(env);
    assert.equal(env.local.mathStars, stars);
    assert.equal(env.local.mathLog, log);
    assert.equal(env.time.pending(), 0);
  });
}

test('Home removes full-screen fireworks and cancels the delayed fanfare', async () => {
  const env = await setup();
  env.run('newCode(); state.code.index = state.code.tasks.length; playFanfare = () => { throw new Error("late fanfare"); }; renderCode();');
  assert.equal(env.run('document.querySelectorAll(".code-fireworks-screen").length'), 1);
  const log = env.local.mathLog;
  await env.node('home-code').click();
  env.time.advance(20000);
  assert.equal(env.run('document.querySelectorAll(".code-fireworks-screen").length'), 0);
  assert.equal(env.local.mathLog, log);
});

test('Home stops applause and closes the active audio context', async () => {
  const env = await setup();
  env.run(`
    window.testAudioClosed = false;
    sharedAudio = { state: 'running', close() { window.testAudioClosed = true; return Promise.resolve(); } };
    applausePlayer = { currentTime: 2, volume: 1, pause() { this.paused = true; } };
  `);
  await env.node('home-training').click();
  assert.equal(env.window.testAudioClosed, true);
  assert.equal(env.run('sharedAudio === null && applausePlayer.paused && applausePlayer.currentTime === 0'), true);
});

test('a late audio play promise cannot schedule applause after Home', async () => {
  const time = clock();
  const env = await environment(null, null, { timers: time.timers, Date: time.Date });
  env.run(`
    applausePlayer = { currentTime: 0, volume: 1, pause() {}, play() {
      return new Promise(resolve => { window.finishTestPlayback = resolve; });
    } };
    playCheerfulApplause();
  `);
  await env.node('home-training').click();
  env.window.finishTestPlayback();
  await tick();
  assert.equal(time.pending(), 0);
  assert.equal(env.run('applauseStopId === null && applauseFadeStartId === null && applauseFadeId === null'), true);
});

test('Guest and the title clear student identity while preserving the local journal', async () => {
  for (const id of ['guestAccessBtn', 'siteHomeBtn']) {
    const student = { studentId: 'pupil', classId: 'class', studentName: 'Test pupil', className: 'Test class' };
    const env = await setup(student);
    env.local.mathLog = '[{"student":"previous","score":3}]';
    const log = env.local.mathLog;
    env.run('startTraining(); setStars(4)');
    await env.node(id).click();
    assertCleared(env);
    assert.equal(env.role(), 'guest');
    assert.equal(env.local.mathStudentSession, undefined);
    assert.equal(env.local.mathStudent, 'Гост');
    assert.equal(env.local.mathLog, log);
  }
});

test('Home preserves a teacher session; clicking the title signs out', async () => {
  const env = await setup(null, profile);
  env.run('newRobot()');
  await env.node('home-robot').click();
  assert.equal(env.role(), 'teacher');
  assert.equal(env.logoutCalls(), 0);
  await env.node('siteHomeBtn').click();
  assert.equal(env.role(), 'guest');
  assert.equal(env.logoutCalls(), 1);
  assertCleared(env);
});

test('Guest shows Welcome and cancels gameplay immediately while sign-out is pending', async () => {
  const env = await setup(null, profile);
  env.run('startBalloons()');
  let release;
  const original = env.window.authService.logoutTeacher;
  env.window.authService.logoutTeacher = () => new Promise(resolve => { release = () => original().then(resolve); });
  const transition = env.window.accessControl.switchToGuest();
  assertCleared(env);
  assert.equal(env.role(), 'teacher');
  release();
  await transition;
  assert.equal(env.role(), 'guest');
});

test('a late student PIN response cannot sign the student in after Guest', async () => {
  const env = await setup();
  env.window.dbService.getClassByCode = async () => ({ ok: true, data: { id: 'class', class_name: 'Test class', class_code: 'MAT-123456' } });
  env.window.dbService.getStudentsForLogin = async () => ({ ok: true, data: [{ id: 'pupil', student_number: 1, display_name: 'Test pupil' }] });
  let release;
  env.window.dbService.verifyStudentPin = () => new Promise(resolve => { release = () => resolve({ ok: true, data: { id: 'pupil', student_number: 1, display_name: 'Test pupil' } }); });
  await env.node('studentAccessBtn').click();
  env.node('studentClassCode').value = 'MAT-123456';
  await env.node('studentClassCodeForm').trigger('submit');
  await env.node('studentLoginChoices').trigger('click', { closest: () => ({ dataset: { studentLoginId: 'pupil' } }) });
  env.node('studentLoginPin').value = '1234';
  const login = env.node('studentPinLoginForm').trigger('submit');
  await tick();
  await env.node('guestAccessBtn').click();
  release();
  await login;
  assert.equal(env.role(), 'guest');
  assert.equal(env.local.mathStudentSession, undefined);
  assertCleared(env);
});

test('markup includes seven accessible Home buttons and a clickable site title', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/data-game-home/g) || []).length, 7);
  assert.match(html, /<h1><button id="siteHomeBtn"[^>]+type="button"/);
  assert.equal((html.match(/type="button" data-game-home>🏠 Начало<\/button>/g) || []).length, 7);
});
