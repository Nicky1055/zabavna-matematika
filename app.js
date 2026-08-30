window.mathGamesLoaded = true;
const $ = (id) => document.getElementById(id);
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

const storage = (() => {
  const memory = {};
  try {
    const testKey = '__math_games_storage_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return window.localStorage;
  } catch (err) {
    return {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      },
      setItem(key, value) {
        memory[key] = String(value);
      },
      removeItem(key) {
        delete memory[key];
      }
    };
  }
})();

function readSavedList(key) {
  try {
    const value = storage.getItem(key);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    storage.removeItem(key);
    return [];
  }
}

const state = {
  stars: Number(storage.getItem('mathStars') || 0),
  student: storage.getItem('mathStudent') || '',
  timerStartedAt: Number(storage.getItem('mathTimerStartedAt') || 0),
  timerElapsedMs: Number(storage.getItem('mathTimerElapsedMs') || 0),
  timerRunning: storage.getItem('mathTimerRunning') === 'true',
  timerPausedManually: storage.getItem('mathTimerPausedManually') === 'true',
  timerInterval: null,
  training: { tasks: [], index: 0, score: 0, checked: false, completed: false, autoAdvanceId: null },
  bingo: { board: [], marked: new Set(), current: null, moves: 0, wrongs: 0, won: false, lost: false },
  family: null,
  robot: null,
  treasure: { tasks: [], index: 0 },
  code: { tasks: [], index: 0, letters: [] },
  balloons: { task: null, round: 0, score: 0, total: 8, answered: false },
};

let sharedAudio = null;
let applausePlayer = null;
let applauseStopId = null;
let applauseFadeStartId = null;
let applauseFadeId = null;
let lastWrongSoundAt = -Infinity;

function getAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  if (!sharedAudio) sharedAudio = new AudioContext();
  if (sharedAudio.state === 'suspended') sharedAudio.resume().catch(() => {});
  return sharedAudio;
}

function unlockAudio() {
  const audio = getAudio();
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const now = audio.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + 0.01);
}

function connectSoundOutput(audio, level = 4) {
  const now = audio.currentTime;
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-10, now);
  limiter.knee.setValueAtTime(18, now);
  limiter.ratio.setValueAtTime(7, now);
  limiter.attack.setValueAtTime(0.003, now);
  limiter.release.setValueAtTime(0.16, now);
  const output = audio.createGain();
  output.gain.setValueAtTime(level, now);
  limiter.connect(output).connect(audio.destination);
  return limiter;
}

function getApplausePlayer() {
  if (!applausePlayer) {
    applausePlayer = new Audio('assets/sounds/kids-applause-source.mp3');
    applausePlayer.id = 'successApplauseAudio';
    applausePlayer.preload = 'auto';
    applausePlayer.volume = 1;
    applausePlayer.hidden = true;
    applausePlayer.addEventListener('ended', stopApplausePlayback);
    document.body.appendChild(applausePlayer);
  }
  return applausePlayer;
}

function clearApplauseTimers() {
  if (applauseStopId) clearTimeout(applauseStopId);
  if (applauseFadeStartId) clearTimeout(applauseFadeStartId);
  if (applauseFadeId) clearInterval(applauseFadeId);
  applauseStopId = null;
  applauseFadeStartId = null;
  applauseFadeId = null;
}

function stopApplausePlayback() {
  clearApplauseTimers();
  if (applausePlayer) {
    applausePlayer.pause();
    applausePlayer.currentTime = 0;
    applausePlayer.volume = 1;
  }
}

function playCheerfulApplause(duration = 4.8) {
  try {
    const sound = getApplausePlayer();
    clearApplauseTimers();
    sound.pause();
    sound.currentTime = 0;
    sound.volume = 1;

    const totalDuration = Math.max(4.5, duration);
    const fadeDuration = Math.min(1.6, totalDuration / 3);
    const fadeStart = totalDuration - fadeDuration;

    const playPromise = sound.play();
    const stopAfterCelebration = () => {
      applauseFadeStartId = setTimeout(() => {
        const steps = 32;
        let step = 0;
        applauseFadeId = setInterval(() => {
          step++;
          sound.volume = Math.max(0, 1 - step / steps);
          if (step >= steps) {
            clearInterval(applauseFadeId);
            applauseFadeId = null;
          }
        }, fadeDuration * 1000 / steps);
      }, fadeStart * 1000);
      applauseStopId = setTimeout(stopApplausePlayback, totalDuration * 1000 + 80);
    };
    if (playPromise && playPromise.then) {
      playPromise.then(stopAfterCelebration).catch(stopApplausePlayback);
    } else {
      stopAfterCelebration();
    }
  } catch (err) {}
}

function playWrongAnswerSound() {
  const playedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (playedAt - lastWrongSoundAt < 450) return;
  lastWrongSoundAt = playedAt;

  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  const filter = audio.createBiquadFilter();
  master.gain.setValueAtTime(1.05, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1450, now);
  filter.Q.setValueAtTime(0.7, now);
  master.connect(filter).connect(connectSoundOutput(audio, 3.4));

  [392, 329.63, 261.63].forEach((freq, idx) => {
    const start = now + idx * 0.23;
    const end = start + 0.42;
    const voice = audio.createOscillator();
    const warmVoice = audio.createOscillator();
    const gain = audio.createGain();
    voice.type = 'triangle';
    warmVoice.type = 'sine';
    voice.frequency.setValueAtTime(freq, start);
    voice.frequency.exponentialRampToValueAtTime(freq * 0.9, end);
    warmVoice.frequency.setValueAtTime(freq / 2, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.38, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    voice.connect(gain);
    warmVoice.connect(gain);
    gain.connect(master);
    voice.start(start);
    warmVoice.start(start);
    voice.stop(end + 0.03);
    warmVoice.stop(end + 0.03);
  });
}
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours > 0) return `${hours}:${String(restMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(restMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function currentElapsedMs() {
  if (!state.timerRunning || !state.timerStartedAt) return state.timerElapsedMs;
  return state.timerElapsedMs + (Date.now() - state.timerStartedAt);
}

function currentElapsedTime() {
  return formatDuration(currentElapsedMs());
}

function updateTimerButton() {
  const btn = $('timerToggleBtn');
  if (!btn) return;
  btn.textContent = state.timerRunning ? 'Спри таймера' : 'Пусни таймера';
  btn.classList.toggle('is-running', state.timerRunning);
}

function updateTimerDisplay() {
  $('totalTime').textContent = currentElapsedTime();
  updateTimerButton();
}

function persistTimer() {
  storage.setItem('mathTimerElapsedMs', String(state.timerElapsedMs));
  if (state.timerRunning) {
    storage.setItem('mathTimerRunning', 'true');
    storage.setItem('mathTimerStartedAt', String(state.timerStartedAt));
  } else {
    storage.removeItem('mathTimerRunning');
    storage.removeItem('mathTimerStartedAt');
  }
  if (state.timerPausedManually) storage.setItem('mathTimerPausedManually', 'true');
  else storage.removeItem('mathTimerPausedManually');
}

function startTimer(force = false) {
  if (state.timerPausedManually && !force) return;
  if (!state.timerRunning) {
    state.timerRunning = true;
    state.timerPausedManually = false;
    state.timerStartedAt = Date.now();
    persistTimer();
  }
  updateTimerDisplay();
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimerDisplay, 1000);
}

function pauseTimer(manual = true) {
  if (state.timerRunning && state.timerStartedAt) {
    state.timerElapsedMs += Date.now() - state.timerStartedAt;
  }
  state.timerRunning = false;
  state.timerStartedAt = 0;
  state.timerPausedManually = manual;
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
  persistTimer();
  updateTimerDisplay();
}

function toggleTimer() {
  if (state.timerRunning) pauseTimer(true);
  else startTimer(true);
}

function resetTimer() {
  state.timerRunning = false;
  state.timerStartedAt = 0;
  state.timerElapsedMs = 0;
  state.timerPausedManually = false;
  storage.removeItem('mathTimerRunning');
  storage.removeItem('mathTimerStartedAt');
  storage.removeItem('mathTimerElapsedMs');
  storage.removeItem('mathTimerPausedManually');
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
  updateTimerDisplay();
}

function initTimer() {
  if (state.timerRunning && state.timerStartedAt) {
    startTimer(true);
  } else {
    updateTimerDisplay();
  }
}
function setStars(value) {
  state.stars = Math.max(0, value);
  storage.setItem('mathStars', String(state.stars));
  $('totalStars').textContent = state.stars;
}

function addStars(value) {
  setStars(state.stars + value);
}

function setFeedback(el, text, type = '') {
  el.textContent = text;
  el.className = `feedback ${type}`.trim();
}

const praiseMessages = [
  'Супер работа!',
  'Браво, математически шампион!',
  'Точно така! Продължавай смело!',
  'Чудесно смятане!',
  'Страхотен отговор!',
  'Уау, справи се отлично!'
];
const encourageMessages = [
  'Добър опит! Опитай още веднъж.',
  'Почти си там. Помисли спокойно.',
  'Няма страшно, математиката се учи с опити.',
  'Хайде пак, можеш да го откриеш.',
  'Спокойно, провери с обратно действие.'
];
const praise = () => praiseMessages[rand(0, praiseMessages.length - 1)];
const encourage = (extra = '') => `${encourageMessages[rand(0, encourageMessages.length - 1)]}${extra ? ' ' + extra : ''}`;

function selectedMode() {
  const modeSelect = $('gameMode');
  return modeSelect ? modeSelect.value : 'all-tables';
}

function selectedTables() {
  const mode = selectedMode();
  if (mode.startsWith('table-')) return [Number(mode.replace('table-', ''))];
  return [2, 3, 4, 5, 6, 7, 8, 9, 10];
}

function selectedOperation() {
  const selected = document.querySelector('input[name="operation"]:checked');
  return selected ? selected.value : 'mixed';
}

function makeTask(tables = selectedTables(), op = selectedOperation()) {
  const a = tables[rand(0, tables.length - 1)];
  const b = rand(2, 10);
  const product = a * b;
  let useDivision = op === 'div' || (op === 'mixed' && Math.random() > 0.5);
  if (useDivision) {
    const divisor = Math.random() > 0.5 ? a : b;
    return {
      text: `${product} : ${divisor}`,
      answer: product / divisor,
      hint: `Потърси обратно умножение: ${divisor} × ? = ${product}`,
      family: [a, b, product]
    };
  }
  return {
    text: `${a} × ${b}`,
    answer: product,
    hint: `${a} групи по ${b} правят ${product}. Може да размениш местата: ${b} × ${a}.`,
    family: [a, b, product]
  };
}

function uniqueTasks(count, tables = selectedTables(), op = selectedOperation()) {
  const tasks = [];
  const seen = new Set();
  let guard = 0;
  while (tasks.length < count && guard < 500) {
    guard++;
    const task = makeTask(tables, op);
    const key = `${task.text}=${task.answer}`;
    if (!seen.has(key)) {
      seen.add(key);
      tasks.push(task);
    }
  }
  return tasks;
}

function initTables() {
  const box = $('tableChecks');
  box.innerHTML = '';
  for (let n = 2; n <= 10; n++) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${n}" ${n <= 10 ? 'checked' : ''}> × ${n}`;
    box.appendChild(label);
  }
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const GAME_RESULT_KEYS = Object.freeze({
  'Бърза тренировка': 'training',
  'Математическо бинго': 'bingo',
  'Открий семейството': 'families',
  'Грешката на робота': 'robot',
  'Лов на съкровище': 'treasure',
  'Таен код': 'secret_code',
  'Математически балони': 'balloons',
});

function saveResult(game, score, total, starsEarned = 0) {
  const log = readSavedList('mathLog');
  const student = state.student || 'Ученик';
  const date = new Date().toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' });
  const duration = currentElapsedTime();
  log.unshift({ student, game, score, total, date, duration });
  storage.setItem('mathLog', JSON.stringify(log.slice(0, 200)));
  renderLog();

  if (window.dbService && typeof window.dbService.saveGameResult === 'function') {
    void window.dbService.saveGameResult({
      gameKey: GAME_RESULT_KEYS[game] || game,
      score,
      totalQuestions: total,
      stars: starsEarned,
      timeSpentSeconds: Math.floor(currentElapsedMs() / 1000),
    });
  }
}

function renderLog() {
  const log = readSavedList('mathLog');
  const box = $('localLog');
  const summary = $('teacherLogSummary');
  if (summary) {
    summary.textContent = log.length
      ? `Записани резултати: ${log.length}. Те ще останат тук, докато учителят не ги изтрие.`
      : 'Все още няма записани резултати.';
  }
  if (!log.length) {
    box.innerHTML = '<p class="hint">Все още няма записани резултати.</p>';
    return;
  }
  box.innerHTML = log.map(item => `
    <div class="log-item">
      <span><strong>${escapeHtml(item.student)}</strong> • ${escapeHtml(item.game)}</span>
      <span>${escapeHtml(item.score)}/${escapeHtml(item.total)} • ${escapeHtml(item.duration || '00:00')} • ${escapeHtml(item.date)}</span>
    </div>
  `).join('');
}

function clearTeacherResults() {
  if (!window.confirm('Да се изтрият ли всички записани резултати от учителския дневник?')) return;
  storage.removeItem('mathLog');
  renderLog();
  const message = $('teacherLogMessage');
  if (message) setFeedback(message, 'Учителският дневник е изчистен.', 'good');
}

function resetStudentProgress(message = '') {
  setStars(0);
  resetTimer();

  clearTrainingAdvance();
  state.training = { tasks: [], index: 0, score: 0, checked: false, completed: false, autoAdvanceId: null };
  $('trainingProgress').textContent = 'Натисни „Хайде, старт“.';
  $('trainingScore').textContent = '';
  $('trainingTask').textContent = '🌟';
  $('trainingTask').classList.remove('is-hidden');
  $('trainingAnswer').value = '';
  $('trainingAnswer').disabled = false;
  $('checkTrainingBtn').disabled = false;
  $('trainingHint').textContent = '';
  hideTrainingCelebration();
  setFeedback($('trainingFeedback'), message, message ? 'good' : '');

  state.bingo = { board: [], marked: new Set(), current: null, moves: 0, wrongs: 0, won: false, lost: false };
  $('bingoCall').textContent = 'Натисни „Играй бинго“.';
  $('bingoMoves').textContent = '';
  $('bingoBoard').innerHTML = '';
  hideBingoCelebration();
  setFeedback($('bingoFeedback'), '');

  generateTeacherSet();
  newFamily(false);
  newRobot(false);
  newCode(false);
  startTreasure(false);
  startBalloons(false);
  renderLog();
}

function initStudent() {
  $('studentName').value = state.student;
  window.addEventListener('math:student-access', event => {
    const detail = event.detail || {};
    const newStudent = String(detail.name || '').trim();
    const oldStudent = state.student;
    const locked = Boolean(detail.locked);
    state.student = newStudent;
    storage.setItem('mathStudent', state.student);
    $('studentName').value = state.student;
    $('studentName').readOnly = locked;
    $('saveStudentBtn').hidden = locked;

    if (detail.resetProgress && newStudent !== oldStudent) {
      const label = newStudent || 'Гост';
      resetStudentProgress(`${label} започва начисто. Успех! ⭐`);
    }
  });
  $('saveStudentBtn').addEventListener('click', () => {
    const newStudent = $('studentName').value.trim();
    const oldStudent = state.student;
    state.student = newStudent;
    storage.setItem('mathStudent', state.student);
    if (newStudent !== oldStudent) {
      const label = newStudent || 'Нов ученик';
      resetStudentProgress(`${label} започва начисто. Успех! ⭐`);
    } else {
      setFeedback($('trainingFeedback'), 'Името е запазено. Продължаваме смело!', 'good');
    }
  });
}
// Training
function clearTrainingAdvance() {
  if (state.training && state.training.autoAdvanceId) clearTimeout(state.training.autoAdvanceId);
  if (state.training) state.training.autoAdvanceId = null;
}

function playTrainingCelebration() {
  playCheerfulApplause(4.8);
}

function rainbowText(text) {
  return [...text].map(ch => ch === ' '
    ? '<span class="rainbow-space"> </span>'
    : `<span>${ch}</span>`).join('');
}

function showTrainingCelebration(score, total) {
  const box = $('trainingCelebration');
  box.innerHTML = [
    `<div class="rainbow-title">${rainbowText('БРАВО!')}</div>`,
    `<div class="rainbow-subtitle">${praise()}</div>`,
    `<div class="rainbow-score">${score}/${total} верни отговора</div>`
  ].join('');
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
  playTrainingCelebration();
}

function hideTrainingCelebration() {
  const box = $('trainingCelebration');
  box.textContent = '';
  box.classList.remove('show');
}

function startTraining() {
  startTimer();
  clearTrainingAdvance();
  state.training.tasks = uniqueTasks(Number($('questionCount').value));
  state.training.index = 0;
  state.training.score = 0;
  state.training.checked = false;
  state.training.completed = false;
  $('trainingAnswer').value = '';
  $('trainingHint').textContent = '';
  hideTrainingCelebration();
  renderTraining();
}

function renderTraining() {
  const t = state.training;
  const task = t.tasks[t.index];
  if (!task) {
    $('trainingTask').textContent = '';
    $('trainingTask').classList.add('is-hidden');
    $('trainingProgress').textContent = `Край на играта.`;
    $('trainingScore').textContent = `Резултат: ${t.score}/${t.tasks.length}`;
    $('trainingAnswer').disabled = true;
    $('checkTrainingBtn').disabled = true;
    setFeedback($('trainingFeedback'), `${praise()} Събра ${t.score} верни отговора.`, 'good');
    if (!t.completed) {
      t.completed = true;
      showTrainingCelebration(t.score, t.tasks.length);
      saveResult('Бърза тренировка', t.score, t.tasks.length, t.score * 2);
    }
    return;
  }
  $('trainingProgress').textContent = `Задача ${t.index + 1} от ${t.tasks.length}`;
  $('trainingScore').textContent = `Точки: ${t.score}`;
  $('trainingTask').classList.remove('is-hidden');
  $('trainingTask').textContent = `${task.text} = ?`;
  $('trainingAnswer').disabled = false;
  $('checkTrainingBtn').disabled = false;
  $('trainingAnswer').value = '';
  $('trainingAnswer').focus();
  $('trainingHint').textContent = '';
  setFeedback($('trainingFeedback'), '');
  t.checked = false;
}

function advanceTrainingAfterCorrect() {
  const t = state.training;
  clearTrainingAdvance();
  t.autoAdvanceId = setTimeout(() => {
    t.autoAdvanceId = null;
    t.index++;
    renderTraining();
  }, 1100);
}

function checkTraining() {
  startTimer();
  const t = state.training;
  const task = t.tasks[t.index];
  if (!task || t.checked) return;
  const ans = Number($('trainingAnswer').value);
  if ($('trainingAnswer').value === '') {
    setFeedback($('trainingFeedback'), 'Напиши отговор и после натисни бутона. Аз чакам смело!', 'bad');
    return;
  }
  if (ans === task.answer) {
    t.checked = true;
    t.score++;
    addStars(2);
    $('trainingAnswer').disabled = true;
    $('checkTrainingBtn').disabled = true;
    setFeedback($('trainingFeedback'), `${praise()} Следващата задача идва след миг. ⭐`, 'good');
    $('trainingScore').textContent = `Точки: ${t.score}`;
    advanceTrainingAfterCorrect();
  } else {
    playWrongAnswerSound();
    setFeedback($('trainingFeedback'), encourage(`Опитай пак. Подсказка: ${task.hint}`), 'bad');
    $('trainingAnswer').focus();
    $('trainingAnswer').select();
  }
}
// Bingo
function newBingo() {
  startTimer();
  const tables = selectedTables();
  const base = [];
  tables.forEach(a => {
    for (let b = 2; b <= 10; b++) {
      base.push(a*b);
      if (tables.length === 1) base.push(b);
    }
  });
  const unique = [...new Set(base)];
  const possible = [];
  while (possible.length < 16) possible.push(...shuffle(unique));
  state.bingo.board = shuffle(possible).slice(0, 16);
  state.bingo.marked = new Set();
  state.bingo.current = null;
  state.bingo.moves = 0;
  state.bingo.wrongs = 0;
  state.bingo.won = false;
  state.bingo.lost = false;
  hideBingoCelebration();
  renderBingoBoard();
  nextBingoTask();
}

function renderBingoBoard(winLine = []) {
  const board = $('bingoBoard');
  board.innerHTML = '';
  board.classList.toggle('celebrate', winLine.length > 0);
  state.bingo.board.forEach((num, idx) => {
    const cell = document.createElement('button');
    cell.className = 'bingo-cell';
    if (state.bingo.marked.has(idx)) cell.classList.add('marked');
    if (winLine.includes(idx)) cell.classList.add('win');
    cell.textContent = num;
    cell.addEventListener('click', () => clickBingoCell(idx));
    board.appendChild(cell);
  });
}

function playBingoTap(isCorrect) {
  if (!isCorrect) {
    playWrongAnswerSound();
    return;
  }
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.setValueAtTime(isCorrect ? 1.35 : 1.65, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + (isCorrect ? 0.38 : 0.62));
  master.connect(connectSoundOutput(audio, isCorrect ? 3.6 : 4.8));
  const notes = isCorrect ? [660, 880] : [220, 196, 185, 155];
  notes.forEach((freq, idx) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + idx * (isCorrect ? 0.055 : 0.075);
    osc.type = isCorrect ? 'triangle' : (idx % 2 ? 'square' : 'sawtooth');
    osc.frequency.setValueAtTime(freq, start);
    if (!isCorrect) osc.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.72), start + 0.22);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(isCorrect ? 0.5 : 0.64, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (isCorrect ? 0.18 : 0.3));
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + (isCorrect ? 0.2 : 0.34));
  });
}

function playBingoLossSound() {
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.setValueAtTime(1.9, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
  master.connect(connectSoundOutput(audio, 5));
  [196, 174.61, 146.83, 123.47].forEach((freq, idx) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + idx * 0.16;
    osc.type = idx % 2 ? 'square' : 'sawtooth';
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(70, freq * 0.64), start + 0.34);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.62, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + 0.46);
  });
}

function playBingoWinSound() {
  playCheerfulApplause(5);
}

function showBingoCelebration() {
  const box = $('bingoCelebration');
  if (!box) return;
  box.innerHTML = '<div class="rainbow-title bingo-title-pop">' + rainbowText('БИНГО!') + '</div>'
    + '<div class="rainbow-subtitle">' + praise() + ' Завърши като истински шампион!</div>';
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
}

function hideBingoCelebration() {
  const box = $('bingoCelebration');
  const board = $('bingoBoard');
  if (board) board.classList.remove('celebrate');
  if (!box) return;
  box.textContent = '';
  box.classList.remove('show');
}

function nextBingoTask() {
  startTimer();
  if (!state.bingo.board.length) return newBingo();
  if (state.bingo.won || state.bingo.lost) return;
  const openCells = state.bingo.board
    .map((num, idx) => ({ num, idx }))
    .filter(cell => !state.bingo.marked.has(cell.idx));
  if (!openCells.length) {
    state.bingo.won = true;
    playBingoWinSound();
    showBingoCelebration();
    setFeedback($('bingoFeedback'), `${praise()} Попълни цялото бинго поле. ⭐`, 'good');
    saveResult('Математическо бинго', 1, 1, state.bingo.marked.size * 2);
    return;
  }
  const answer = openCells[rand(0, openCells.length - 1)].num;
  const tables = selectedTables();
  if (tables.length === 1) {
    const table = tables[0];
    const tableTasks = [];
    if (answer % table === 0 && answer / table >= 2 && answer / table <= 10) {
      tableTasks.push({ text: `${table} × ${answer / table}`, answer });
    }
    if (answer >= 2 && answer <= 10) {
      tableTasks.push({ text: `${table * answer} : ${table}`, answer });
    }
    state.bingo.current = tableTasks[rand(0, tableTasks.length - 1)];
  } else {
    const pairs = [];
    for (let a = 2; a <= 10; a++) {
      if (answer % a === 0 && answer / a >= 2 && answer / a <= 10) pairs.push([a, answer/a]);
    }
    const [a, b] = pairs.length ? pairs[rand(0, pairs.length - 1)] : [1, answer];
    const divisionTasks = [];
    for (let divisor = 2; divisor <= 10; divisor++) {
      if (answer <= 10 && answer * divisor <= 100) {
        divisionTasks.push({ text: `${answer * divisor} : ${divisor}`, answer });
      }
    }
    const useDivision = divisionTasks.length && Math.random() > 0.5;
    state.bingo.current = useDivision
      ? divisionTasks[rand(0, divisionTasks.length - 1)]
      : { text: `${a} × ${b}`, answer };
  }
  $('bingoCall').textContent = `Задача: ${state.bingo.current.text} = ?`;
  $('bingoMoves').textContent = `Опити: ${state.bingo.moves} • Грешки: ${state.bingo.wrongs || 0}/3`;
  setFeedback($('bingoFeedback'), 'Намери правилния отговор и го докосни като истински бинго майстор.');
}

function clickBingoCell(idx) {
  const b = state.bingo;
  if (!b.current || b.won || b.lost) return;
  const value = b.board[idx];
  b.moves++;
  const isCorrect = value === b.current.answer;
  if (isCorrect) {
    playBingoTap(true);
    b.marked.add(idx);
    addStars(2);
    const win = bingoWinLine();
    if (win) {
      b.won = true;
      renderBingoBoard(win);
      playBingoWinSound();
      showBingoCelebration();
      setFeedback($('bingoFeedback'), `${praise()} БИНГО! Имаш ред, колона или диагонал. ⭐`, 'good');
      saveResult('Математическо бинго', 1, 1, b.marked.size * 2);
    } else {
      renderBingoBoard();
      setFeedback($('bingoFeedback'), `${praise()} Това поле е точното. Продължаваме!`, 'good');
      nextBingoTask();
    }
  } else {
    b.wrongs = (b.wrongs || 0) + 1;
    renderBingoBoard();
    if (b.wrongs >= 3) {
      b.lost = true;
      b.current = null;
      playBingoLossSound();
      setFeedback($('bingoFeedback'), '☹️ Ти загуби! Започни нова игра и внимавай повече!', 'bad');
    } else {
      playBingoTap(false);
      setFeedback($('bingoFeedback'), `Помисли внимателно! Това поле е ${value}. Потърси отговора на задачата още веднъж.`, 'bad');
    }
  }
  $('bingoMoves').textContent = `Опити: ${b.moves} • Грешки: ${b.wrongs || 0}/3`;
}

function bingoWinLine() {
  const lines = [
    [0,1,2,3], [4,5,6,7], [8,9,10,11], [12,13,14,15],
    [0,4,8,12], [1,5,9,13], [2,6,10,14], [3,7,11,15],
    [0,5,10,15], [3,6,9,12]
  ];
  return lines.find(line => line.every(i => state.bingo.marked.has(i)));
}

// Fact families
function newFamily(autoStart = true) {
  if (autoStart) startTimer();
  const a = rand(2, 10), b = rand(2, 10), p = a*b;
  state.family = { a, b, p };
  hideFamilyCelebration();
  const numbers = shuffle([a, b, p]);
  $('familyNumbers').innerHTML = numbers.map((n, idx) => '<span style="--i:' + idx + '">' + n + '</span>').join('');
  $('familyNumbers').classList.remove('family-pop');
  void $('familyNumbers').offsetWidth;
  $('familyNumbers').classList.add('family-pop');
  document.querySelectorAll('.family-input').forEach(i => i.value = '');
  const familyGrid = document.querySelector('.family-grid');
  if (familyGrid) familyGrid.classList.remove('family-success', 'family-shake');
  setFeedback($('familyFeedback'), 'Използвай само тези три числа. Те са едно весело математическо семейство.');
  if (autoStart) playFamilySound('new');
}

function playFamilySound(type) {
  if (type === 'success') {
    playCheerfulApplause(4.8);
    return;
  }
  if (type === 'error') {
    playWrongAnswerSound();
    return;
  }
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  const level = type === 'success' ? 5.2 : type === 'error' ? 3.6 : 4.2;
  master.gain.setValueAtTime(type === 'success' ? 1.9 : 1.25, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + (type === 'success' ? 1.6 : 0.7));
  master.connect(connectSoundOutput(audio, level));
  const notes = type === 'success'
    ? [523.25, 659.25, 783.99, 1046.5, 1318.51]
    : type === 'error'
      ? [392, 330, 294]
      : [659.25, 783.99, 987.77];
  notes.forEach((freq, idx) => {
    const osc = audio.createOscillator();
    const shine = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + idx * (type === 'success' ? 0.11 : 0.08);
    osc.type = type === 'error' ? 'sine' : 'triangle';
    shine.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    shine.frequency.setValueAtTime(freq * 2, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(type === 'success' ? 0.72 : 0.48, start + 0.016);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (type === 'success' ? 0.42 : 0.28));
    osc.connect(gain);
    if (type !== 'error') shine.connect(gain);
    gain.connect(master);
    osc.start(start);
    if (type !== 'error') shine.start(start);
    osc.stop(start + 0.45);
    if (type !== 'error') shine.stop(start + 0.45);
  });
}

function showFamilyCelebration() {
  const box = $('familyCelebration');
  if (!box) return;
  box.innerHTML = '<div class="rainbow-title family-title-pop">' + rainbowText('ЧУДЕСНО!') + '</div>'
    + '<div class="rainbow-subtitle">Семейството е подредено отлично!</div>';
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
}

function hideFamilyCelebration() {
  const box = $('familyCelebration');
  if (box) {
    box.textContent = '';
    box.classList.remove('show');
  }
}

function animateFamilyGrid(className) {
  const grid = document.querySelector('.family-grid');
  if (!grid) return;
  grid.classList.remove('family-success', 'family-shake');
  void grid.offsetWidth;
  grid.classList.add(className);
  if (className === 'family-shake') setTimeout(() => grid.classList.remove('family-shake'), 620);
}

function familyEquations() {
  return [
    [$('f1a').value, '×', $('f1b').value, $('f1c').value],
    [$('f2a').value, '×', $('f2b').value, $('f2c').value],
    [$('f3a').value, ':', $('f3b').value, $('f3c').value],
    [$('f4a').value, ':', $('f4b').value, $('f4c').value],
  ].map(row => row.map((x, i) => i === 1 ? x : Number(x)));
}

function checkFamily() {
  startTimer();
  if (!state.family) newFamily();
  const a = state.family.a;
  const b = state.family.b;
  const p = state.family.p;
  const valid = new Set([
    String(a) + '×' + String(b) + '=' + String(p),
    String(b) + '×' + String(a) + '=' + String(p),
    String(p) + ':' + String(a) + '=' + String(b),
    String(p) + ':' + String(b) + '=' + String(a),
  ]);
  const rows = familyEquations();
  const given = new Set(rows.map(r => String(r[0]) + String(r[1]) + String(r[2]) + '=' + String(r[3])));
  const complete = rows.every(r => r.every(x => x !== '' && !Number.isNaN(x)));
  if (!complete) {
    hideFamilyCelebration();
    playFamilySound('error');
    animateFamilyGrid('family-shake');
    setFeedback($('familyFeedback'), 'Попълни всички празни места. После заедно ще проверим семейството.', 'bad');
    return;
  }
  const ok = given.size === 4 && [...given].every(x => valid.has(x));
  if (ok) {
    playFamilySound('success');
    animateFamilyGrid('family-success');
    showFamilyCelebration();
    addStars(4);
    setFeedback($('familyFeedback'), praise() + ' Откри цялото математическо семейство. ⭐', 'good');
    saveResult('Открий семейството', 4, 4, 4);
  } else {
    hideFamilyCelebration();
    playFamilySound('error');
    animateFamilyGrid('family-shake');
    setFeedback($('familyFeedback'), encourage('Провери пак числата ' + a + ', ' + b + ' и ' + p + '. Те трябва да се подредят в две умножения и две деления.'), 'bad');
  }
}

function fillFamily() {
  if (!state.family) newFamily();
  const a = state.family.a;
  const b = state.family.b;
  const p = state.family.p;
  hideFamilyCelebration();
  playFamilySound('example');
  $('f1a').value = a; $('f1b').value = b; $('f1c').value = p;
  $('f2a').value = b; $('f2b').value = a; $('f2c').value = p;
  $('f3a').value = p; $('f3b').value = a; $('f3c').value = b;
  $('f4a').value = p; $('f4b').value = b; $('f4c').value = a;
  animateFamilyGrid('family-success');
  setFeedback($('familyFeedback'), 'Ето пример за начало. Когато си готов, опитай ново семейство самостоятелно.', 'good');
}

// Robot
function setRobotMood(mood) {
  const card = $('robotCard');
  if (!card) return;
  card.classList.remove('robot-happy', 'robot-thinking', 'robot-error', 'robot-correcting');
  if (mood) card.classList.add('robot-' + mood);
}

function playRobotSound(type) {
  if (type === 'success') {
    playCheerfulApplause(4.8);
    return;
  }
  if (type === 'error') {
    playWrongAnswerSound();
    return;
  }
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  const level = type === 'success' ? 5.5 : type === 'error' ? 4.2 : 4.6;
  master.gain.setValueAtTime(type === 'success' ? 2.05 : 1.35, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + (type === 'success' ? 1.6 : 0.75));
  master.connect(connectSoundOutput(audio, level));
  const notes = type === 'success'
    ? [523.25, 659.25, 783.99, 1046.5, 1318.51]
    : type === 'error'
      ? [220, 196, 164.81]
      : type === 'choice'
        ? [587.33, 783.99, 987.77]
        : [392, 523.25, 659.25];
  notes.forEach((freq, idx) => {
    const osc = audio.createOscillator();
    const shine = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + idx * (type === 'success' ? 0.1 : 0.075);
    osc.type = type === 'error' ? 'sawtooth' : 'triangle';
    shine.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    shine.frequency.setValueAtTime(freq * 2, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(type === 'success' ? 0.82 : 0.5, start + 0.016);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (type === 'success' ? 0.42 : 0.26));
    osc.connect(gain);
    if (type !== 'error') shine.connect(gain);
    gain.connect(master);
    osc.start(start);
    if (type !== 'error') shine.start(start);
    osc.stop(start + 0.45);
    if (type !== 'error') shine.stop(start + 0.45);
  });
}

function showRobotCelebration(title, subtitle) {
  const box = $('robotCelebration');
  if (!box) return;
  box.innerHTML = '<div class="rainbow-title robot-title-pop">' + rainbowText(title) + '</div>'
    + '<div class="rainbow-subtitle">' + subtitle + '</div>';
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
}

function hideRobotCelebration() {
  const box = $('robotCelebration');
  if (!box) return;
  box.textContent = '';
  box.classList.remove('show');
}

function newRobot(autoStart = true) {
  if (autoStart) startTimer();
  const task = makeTask(selectedTables(), 'mixed');
  const truthful = Math.random() > 0.45;
  let said = task.answer;
  while (!truthful && said === task.answer) said = Math.max(1, task.answer + rand(-5, 6));
  state.robot = { task, said, truthful, phase: 'truth' };
  hideRobotCelebration();
  setRobotMood('thinking');
  $('robotSpeech').textContent = task.text + ' = ' + said;
  $('robotChoices').innerHTML = '';
  setFeedback($('robotFeedback'), 'Роботът вярно ли е сметнал? Ти си неговият помощник.');
  if (autoStart) playRobotSound('new');
}

function answerRobot(isTrue) {
  startTimer();
  if (!state.robot) return newRobot();
  const r = state.robot;
  if (isTrue === r.truthful) {
    addStars(2);
    if (r.truthful) {
      setRobotMood('happy');
      playRobotSound('success');
      showRobotCelebration('БРАВО!', 'Роботът сметна вярно, а ти го разпозна отлично!');
      setFeedback($('robotFeedback'), praise() + ' Роботът този път не сгреши. ⭐', 'good');
      saveResult('Грешката на робота', 1, 1, 2);
      setTimeout(newRobot, 4800);
    } else {
      setRobotMood('correcting');
      playRobotSound('choice');
      setFeedback($('robotFeedback'), praise() + ' Да, има грешка. Сега помогни на робота с правилния отговор.', 'good');
      showRobotChoices();
    }
  } else {
    setRobotMood('error');
    playRobotSound('error');
    hideRobotCelebration();
    setFeedback($('robotFeedback'), encourage('Верният отговор на ' + r.task.text + ' е ' + r.task.answer + '. Роботът ще опита пак с теб.'), 'bad');
    setTimeout(newRobot, 1500);
  }
}

function showRobotChoices() {
  const correct = state.robot.task.answer;
  const choices = new Set([correct]);
  while (choices.size < 4) choices.add(Math.max(1, correct + rand(-9, 9)));
  $('robotChoices').innerHTML = shuffle([...choices]).map(n => '<button class="btn btn--ghost" data-value="' + n + '">' + n + '</button>').join('');
  document.querySelectorAll('#robotChoices button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (Number(btn.dataset.value) === correct) {
        addStars(3);
        btn.classList.add('robot-choice-correct');
        setRobotMood('happy');
        playRobotSound('success');
        showRobotCelebration('СУПЕР!', 'Поправи робота като истински учител!');
        setFeedback($('robotFeedback'), praise() + ' Поправи робота като истински учител. ⭐', 'good');
        saveResult('Грешката на робота', 1, 1, 5);
        setTimeout(newRobot, 4800);
      } else {
        btn.classList.add('robot-choice-wrong');
        setRobotMood('error');
        playRobotSound('error');
        hideRobotCelebration();
        setFeedback($('robotFeedback'), encourage('Не е ' + btn.dataset.value + '. Използвай обратно действие и пробвай пак.'), 'bad');
      }
    });
  });
}

// Treasure
function setTreasureMood(mood) {
  const card = $('treasureCard');
  if (!card) return;
  card.classList.remove('treasure-good', 'treasure-error', 'treasure-finished');
  if (mood) card.classList.add('treasure-' + mood);
}

function playTreasureSound(type) {
  if (type === 'finish') {
    playCheerfulApplause(5);
    return;
  }
  if (type === 'error') {
    playWrongAnswerSound();
    return;
  }
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  const level = type === 'finish' ? 5.6 : type === 'error' ? 4.1 : 4.7;
  master.gain.setValueAtTime(type === 'finish' ? 2.05 : 1.45, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + (type === 'finish' ? 1.9 : 0.85));
  master.connect(connectSoundOutput(audio, level));
  const notes = type === 'finish'
    ? [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98]
    : type === 'error'
      ? [294, 247, 220]
      : type === 'start'
        ? [392, 523.25, 659.25]
        : [659.25, 783.99, 1046.5];
  notes.forEach((freq, idx) => {
    const osc = audio.createOscillator();
    const shine = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + idx * (type === 'finish' ? 0.1 : 0.08);
    osc.type = type === 'error' ? 'sine' : 'triangle';
    shine.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    shine.frequency.setValueAtTime(freq * 2, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(type === 'finish' ? 0.78 : 0.52, start + 0.016);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (type === 'finish' ? 0.42 : 0.3));
    osc.connect(gain);
    if (type !== 'error') shine.connect(gain);
    gain.connect(master);
    osc.start(start);
    if (type !== 'error') shine.start(start);
    osc.stop(start + 0.46);
    if (type !== 'error') shine.stop(start + 0.46);
  });
}

function treasureTitleText() {
  return ['ОТКРИ', 'ГО!'].map(word => '<span class="treasure-title-word">' + rainbowText(word) + '</span>').join('');
}

function showTreasureCelebration() {
  const box = $('treasureCelebration');
  if (!box) return;
  box.innerHTML = '<div class="rainbow-title treasure-title-pop">' + treasureTitleText() + '</div>'
    + '<div class="rainbow-subtitle">Съкровището е твое, математически откривателю!</div>';
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
}

function hideTreasureCelebration() {
  const box = $('treasureCelebration');
  if (!box) return;
  box.textContent = '';
  box.classList.remove('show');
}

function startTreasure(autoStart = true) {
  if (autoStart) startTimer();
  state.treasure.tasks = uniqueTasks(6, selectedTables(), 'mixed');
  state.treasure.index = 0;
  hideTreasureCelebration();
  setTreasureMood('');
  $('treasureAnswer').value = '';
  if (autoStart) playTreasureSound('start');
  renderTreasure();
}

function renderTreasure() {
  const i = state.treasure.index;
  $('treasureTrack').innerHTML = Array.from({ length: 6 }, (_, idx) => {
    const cls = idx < i ? 'done' : idx === i ? 'current' : '';
    const mark = idx < i ? '✓' : idx === i ? '🔑' : idx + 1;
    return '<div class="map-step ' + cls + '"><span>' + mark + '</span></div>';
  }).join('');
  const task = state.treasure.tasks[i];
  if (!task) {
    setTreasureMood('finished');
    $('treasureTask').textContent = '🏆';
    playTreasureSound('finish');
    showTreasureCelebration();
    setFeedback($('treasureFeedback'), praise() + ' Откри съкровището, математически откривателю! ⭐', 'good');
    addStars(8);
    saveResult('Лов на съкровище', 6, 6, 20);
    return;
  }
  $('treasureTask').textContent = task.text + ' = ?';
  $('treasureAnswer').value = '';
  $('treasureAnswer').focus();
  setFeedback($('treasureFeedback'), 'Следа ' + (i + 1) + ': реши задачата и картата ще те пусне напред.');
}

function checkTreasure() {
  startTimer();
  if (!state.treasure.tasks.length) return startTreasure();
  const task = state.treasure.tasks[state.treasure.index];
  if (!task) return;
  const ans = Number($('treasureAnswer').value);
  if ($('treasureAnswer').value === '') {
    setTreasureMood('error');
    playTreasureSound('error');
    setFeedback($('treasureFeedback'), 'Напиши отговор, за да отключиш следата.', 'bad');
    return;
  }
  if (ans === task.answer) {
    setTreasureMood('good');
    playTreasureSound('step');
    addStars(2);
    state.treasure.index++;
    setTimeout(renderTreasure, 520);
  } else {
    setTreasureMood('error');
    playTreasureSound('error');
    setFeedback($('treasureFeedback'), encourage('Подсказка: ' + task.hint), 'bad');
  }
}

// Secret code
const messages = [
  'БРАВО',
  'УСПЕХ',
  'ЗНАМ ТАБЛИЦАТА',
  'МАТЕМАТИЦИ',
  'СМЯТАМ БЪРЗО',
  'ТИ СИ ШАМПИОН',
  'ОТЛИЧНА РАБОТА',
  'СУПЕР УМ',
  'БЪРЗ МАТЕМАТИК',
  'ЗВЕЗДЕН ОТГОВОР',
  'МОГА ДА СМЯТАМ',
  'УМНО РЕШЕНИЕ',
  'ХАЙДЕ НАПРЕД',
  'СМЕЛО РЕШАВАМ',
  'ЗАДАЧИТЕ СА ЛЕСНИ',
  'АЗ ОБИЧАМ МАТЕМАТИКА'
];
function newCode(autoStart = true) {
  if (autoStart) startTimer();
  const message = messages[rand(0, messages.length - 1)];
  const letters = [...message];
  state.code.letters = letters;
  state.code.index = 0;
  state.code.tasks = letters.map(ch => ch === ' ' ? null : makeTask(selectedTables(), 'mixed'));
  $('codeAnswer').value = '';
  renderCode();
}

function playLetterSound() {
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.setValueAtTime(1.8, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
  master.connect(connectSoundOutput(audio, 3.8));

  [880, 1174.66, 1567.98].forEach((freq, idx) => {
    const start = now + idx * 0.09;
    const bell = audio.createOscillator();
    const shine = audio.createOscillator();
    const gain = audio.createGain();
    bell.type = 'triangle';
    shine.type = 'sine';
    bell.frequency.setValueAtTime(freq, start);
    shine.frequency.setValueAtTime(freq * 2, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.72, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    bell.connect(gain);
    shine.connect(gain);
    gain.connect(master);
    bell.start(start);
    shine.start(start);
    bell.stop(start + 0.45);
    shine.stop(start + 0.45);
  });
}

function playFanfare() {
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-12, now);
  limiter.knee.setValueAtTime(18, now);
  limiter.ratio.setValueAtTime(6, now);
  limiter.attack.setValueAtTime(0.003, now);
  limiter.release.setValueAtTime(0.18, now);
  const output = audio.createGain();
  output.gain.setValueAtTime(5.2, now);
  limiter.connect(output).connect(audio.destination);

  const master = audio.createGain();
  master.gain.setValueAtTime(2.35, now);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 3.6);
  master.connect(limiter);

  const chords = [
    { time: 0, notes: [392, 523.25, 659.25, 783.99], length: 0.48 },
    { time: 0.36, notes: [523.25, 659.25, 783.99, 1046.5], length: 0.5 },
    { time: 0.76, notes: [659.25, 783.99, 987.77, 1174.66], length: 0.54 },
    { time: 1.2, notes: [783.99, 1046.5, 1318.51, 1567.98], length: 0.95 },
    { time: 1.86, notes: [523.25, 783.99, 1046.5, 1567.98], length: 0.9 }
  ];

  chords.forEach(chord => {
    chord.notes.forEach((freq, noteIndex) => {
      const start = now + chord.time + noteIndex * 0.015;
      const osc = audio.createOscillator();
      const sparkle = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = noteIndex % 2 ? 'square' : 'sawtooth';
      sparkle.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      sparkle.frequency.setValueAtTime(freq * 2, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.82, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + chord.length);
      osc.connect(gain);
      sparkle.connect(gain);
      gain.connect(master);
      osc.start(start);
      sparkle.start(start);
      osc.stop(start + chord.length + 0.04);
      sparkle.stop(start + chord.length + 0.04);
    });
  });
}

function showCodeFireworks() {
  const box = $('secretMessage');
  const oldOverlay = document.querySelector('.code-fireworks-screen');
  if (oldOverlay) oldOverlay.remove();
  const overlay = document.createElement('div');
  overlay.className = 'code-fireworks-screen';
  for (let i = 0; i < 34; i++) {
    const burst = document.createElement('span');
    burst.className = 'firework-burst';
    burst.style.setProperty('--x', rand(8, 92) + 'vw');
    burst.style.setProperty('--y', rand(8, 88) + 'vh');
    burst.style.setProperty('--size', rand(150, 320) + 'px');
    burst.style.setProperty('--delay', (i * 0.16).toFixed(2) + 's');
    burst.style.setProperty('--hue', rand(0, 340) + 'deg');
    overlay.appendChild(burst);
  }
  document.body.appendChild(overlay);
  box.classList.remove('celebrate');
  void box.offsetWidth;
  box.classList.add('celebrate');
  setTimeout(() => {
    box.classList.remove('celebrate');
    overlay.remove();
  }, 8200);
}
function renderSecret() {
  let index = 0;
  const words = [];
  state.code.letters.join('').split(' ').forEach(word => {
    if (!word) {
      index++;
      return;
    }
    const letters = [...word].map(ch => {
      const revealed = index < state.code.index;
      const tile = `<span class="secret-letter ${revealed ? 'revealed' : ''}">${revealed ? ch : '?'}</span>`;
      index++;
      return tile;
    }).join('');
    words.push(`<span class="secret-word">${letters}</span>`);
    index++;
  });
  $('secretMessage').innerHTML = words.join('');
}
function renderCode() {
  while (state.code.tasks[state.code.index] === null) state.code.index++;
  renderSecret();
  const task = state.code.tasks[state.code.index];
  if (!task) {
    $('codeTask').textContent = '🔓';
    setFeedback($('codeFeedback'), `${praise()} Разкри тайното съобщение!`, 'good');
    playCheerfulApplause(5.2);
    setTimeout(playFanfare, 420);
    showCodeFireworks();
    addStars(6);
    const completedTasks = state.code.tasks.filter(Boolean).length;
    saveResult('Таен код', completedTasks, completedTasks, completedTasks * 2 + 6);
    return;
  }
  $('codeTask').textContent = `${task.text} = ?`;
  $('codeAnswer').value = '';
  $('codeAnswer').focus();
  setFeedback($('codeFeedback'), `Буква ${state.code.index + 1} от ${state.code.letters.length}. Още една стъпка към тайното съобщение.`);
}

function checkCode() {
  startTimer();
  if (!state.code.tasks.length) return newCode();
  const task = state.code.tasks[state.code.index];
  if (!task) return;
  const ans = Number($('codeAnswer').value);
  if ($('codeAnswer').value === '') {
    setFeedback($('codeFeedback'), 'Напиши отговор, за да разкрием буквата.', 'bad');
    return;
  }
  if (ans === task.answer) {
    playLetterSound();
    addStars(2);
    state.code.index++;
    renderCode();
  } else {
    playWrongAnswerSound();
    setFeedback($('codeFeedback'), encourage(task.hint), 'bad');
  }
}

// Math balloons
function startBalloons(autoStart = true) {
  if (autoStart) startTimer();
  state.balloons = { task: null, round: 0, score: 0, total: 8, answered: false };
  nextBalloonTask();
}

function balloonChoices(answer) {
  const choices = new Set([answer]);
  const offsets = shuffle([-12, -10, -8, -6, -5, -4, -3, -2, 2, 3, 4, 5, 6, 8, 10, 12]);
  offsets.forEach(offset => {
    if (choices.size < 6 && answer + offset > 0) choices.add(answer + offset);
  });
  while (choices.size < 6) choices.add(rand(2, 100));
  return shuffle([...choices]);
}

function nextBalloonTask() {
  const b = state.balloons;
  if (b.round >= b.total) {
    b.task = null;
    $('balloonTask').textContent = 'Готово!';
    $('balloonProgress').textContent = 'Край на играта.';
    $('balloonScore').textContent = `Резултат: ${b.score}/${b.total}`;
    $('balloonField').innerHTML = '';
    setFeedback($('balloonFeedback'), `${praise()} Пукна ${b.score} верни балона.`, 'good');
    playCheerfulApplause(4.8);
    saveResult('Математически балони', b.score, b.total, b.score * 2);
    return;
  }
  b.task = makeTask(selectedTables(), 'mixed');
  b.answered = false;
  $('balloonProgress').textContent = `Задача ${b.round + 1} от ${b.total}`;
  $('balloonScore').textContent = `Точки: ${b.score}`;
  $('balloonTask').textContent = `${b.task.text} = ?`;
  $('balloonField').innerHTML = balloonChoices(b.task.answer).map(n => `<button class="balloon" data-value="${n}">${n}</button>`).join('');
  setFeedback($('balloonFeedback'), 'Намери правилния отговор и пукни точния балон.');
  document.querySelectorAll('#balloonField .balloon').forEach(btn => {
    btn.addEventListener('click', () => clickBalloon(btn));
  });
}

function playBalloonPop() {
  const audio = getAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.setValueAtTime(1.6, now);
  master.connect(connectSoundOutput(audio, 4.8));
  const noiseBuffer = audio.createBuffer(1, audio.sampleRate * 0.16, audio.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const noise = audio.createBufferSource();
  const noiseGain = audio.createGain();
  const popTone = audio.createOscillator();
  const toneGain = audio.createGain();
  noise.buffer = noiseBuffer;
  noiseGain.gain.setValueAtTime(0.72, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.02, now + 0.16);
  popTone.type = 'triangle';
  popTone.frequency.setValueAtTime(620, now);
  popTone.frequency.exponentialRampToValueAtTime(120, now + 0.12);
  toneGain.gain.setValueAtTime(0.58, now);
  toneGain.gain.exponentialRampToValueAtTime(0.02, now + 0.14);
  noise.connect(noiseGain).connect(master);
  popTone.connect(toneGain).connect(master);
  noise.start(now);
  popTone.start(now);
  noise.stop(now + 0.16);
  popTone.stop(now + 0.14);
}
function clickBalloon(btn) {
  startTimer();
  const b = state.balloons;
  if (!b.task || b.answered) return;
  const value = Number(btn.dataset.value);
  if (value === b.task.answer) {
    b.answered = true;
    b.score++;
    addStars(2);
    playBalloonPop();
    btn.classList.add('pop');
    document.querySelectorAll('#balloonField .balloon').forEach(x => x.disabled = true);
    setFeedback($('balloonFeedback'), `${praise()} Пук! Това беше точният балон. ⭐`, 'good');
    b.round++;
    setTimeout(nextBalloonTask, 1500);
  } else {
    btn.disabled = true;
    playWrongAnswerSound();
    setFeedback($('balloonFeedback'), encourage(`Този балон е ${value}. Огледай останалите и пробвай пак.`), 'bad');
  }
}

// Teacher panel
function generateTeacherSet() {
  const count = Number($('teacherCount').value);
  const op = $('teacherOperation').value;
  const tasks = uniqueTasks(count, selectedTables(), op);
  $('teacherTaskList').innerHTML = tasks.map(t => `<li>${t.text} = ____</li>`).join('');
  $('teacherTaskList').dataset.copy = tasks.map((t, i) => `${i+1}. ${t.text} = ____`).join('\n');
}

async function copyTeacherSet() {
  const text = $('teacherTaskList').dataset.copy || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    alert('Задачите са копирани.');
  } catch (err) {
    alert(text);
  }
}

function bindEnter(inputId, fn) {
  $(inputId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fn();
  });
}

function applyWallpaper(theme) {
  const safeTheme = ['space', 'candy', 'ocean', 'stage', 'classroom', 'blockworld'].includes(theme) ? theme : 'space';
  document.body.classList.remove('wallpaper-space', 'wallpaper-candy', 'wallpaper-ocean', 'wallpaper-stage', 'wallpaper-classroom', 'wallpaper-blockworld');
  document.body.classList.add(`wallpaper-${safeTheme}`);
  storage.setItem('mathWallpaperTheme', safeTheme);
  if ($('wallpaperTheme')) $('wallpaperTheme').value = safeTheme;
}

function initWallpaper() {
  const savedTheme = storage.getItem('mathWallpaperTheme') || 'space';
  applyWallpaper(savedTheme);
  $('wallpaperTheme').addEventListener('change', () => applyWallpaper($('wallpaperTheme').value));
}
function initMode() {
  const modeSelect = $('gameMode');
  const validModes = Array.from(modeSelect.options).map(option => option.value);
  const savedMode = storage.getItem('mathGameMode') || 'all-tables';
  modeSelect.value = validModes.includes(savedMode) ? savedMode : 'all-tables';

  function syncModeButtons() {
    document.querySelectorAll('.mode-button').forEach(btn => {
      const active = btn.dataset.mode === modeSelect.value;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function commitMode() {
    storage.setItem('mathGameMode', selectedMode());
    syncModeButtons();
    generateTeacherSet();
  }

  document.querySelectorAll('.mode-button').forEach(btn => {
    btn.addEventListener('click', () => {
      modeSelect.value = btn.dataset.mode;
      commitMode();
    });
  });

  modeSelect.addEventListener('change', commitMode);
  syncModeButtons();
}
function initEvents() {
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  $('startTrainingBtn').addEventListener('click', startTraining);
  $('checkTrainingBtn').addEventListener('click', checkTraining);
  $('showHintBtn').addEventListener('click', () => {
    const task = state.training.tasks[state.training.index];
    $('trainingHint').textContent = task ? task.hint : 'Започни нова игра.';
  });
  bindEnter('trainingAnswer', checkTraining);

  $('newBingoBtn').addEventListener('click', newBingo);
  $('nextBingoTaskBtn').addEventListener('click', nextBingoTask);

  $('newFamilyBtn').addEventListener('click', newFamily);
  $('checkFamilyBtn').addEventListener('click', checkFamily);
  $('fillFamilyBtn').addEventListener('click', fillFamily);

  $('newRobotBtn').addEventListener('click', newRobot);
  $('robotTrueBtn').addEventListener('click', () => answerRobot(true));
  $('robotFalseBtn').addEventListener('click', () => answerRobot(false));

  $('startTreasureBtn').addEventListener('click', startTreasure);
  $('checkTreasureBtn').addEventListener('click', checkTreasure);
  bindEnter('treasureAnswer', checkTreasure);

  $('newCodeBtn').addEventListener('click', newCode);
  $('checkCodeBtn').addEventListener('click', checkCode);
  bindEnter('codeAnswer', checkCode);

  $('newBalloonsBtn').addEventListener('click', startBalloons);

  $('timerToggleBtn').addEventListener('click', toggleTimer);

  $('generateTeacherSetBtn').addEventListener('click', generateTeacherSet);
  $('copyTeacherSetBtn').addEventListener('click', copyTeacherSet);
  $('clearLogBtn').addEventListener('click', clearTeacherResults);
}

function init() {
  initWallpaper();
  initMode();
  initTabs();
  initStudent();
  initEvents();
  initTimer();
  setStars(state.stars);
  renderLog();
  generateTeacherSet();
  newFamily(false);
  newRobot(false);
  newCode(false);
  startTreasure(false);
  startBalloons(false);
}

init();
