import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const radioPath = resolve('frontend/js/radio.js');

function createElement(id = '') {
  const listeners = new Map();
  const styleValues = new Map();
  const style = {
    setProperty(name, value) {
      const stringValue = String(value);
      styleValues.set(name, stringValue);
      this[name] = stringValue;
    },
    getPropertyValue(name) {
      return styleValues.get(name) || this[name] || '';
    },
  };
  const element = {
    id,
    className: '',
    dataset: {},
    disabled: false,
    ended: true,
    paused: true,
    playCount: 0,
    src: '',
    style,
    textContent: '',
    value: '',
    volume: 1,
    appendChild() {},
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type) {
      const handler = listeners.get(type);
      if (handler) {
        return handler({
          target: this,
          preventDefault() {},
        });
      }
      return undefined;
    },
    click() {
      const handler = listeners.get('click');
      if (handler) return handler({ target: this });
      return undefined;
    },
    closest() {
      return null;
    },
    classList: {
      add(className) {
        element.activeClasses.add(className);
      },
      remove(className) {
        element.activeClasses.delete(className);
      },
      toggle(className, force) {
        if (force === true || (force === undefined && !element.activeClasses.has(className))) {
          element.activeClasses.add(className);
          return true;
        }
        element.activeClasses.delete(className);
        return false;
      },
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.playCount += 1;
      this.paused = false;
      this.ended = false;
      return Promise.resolve();
    },
    removeAttribute(attr) {
      if (attr === 'src') {
        this.src = '';
        this.ended = true;
        return;
      }
      delete this[attr];
    },
    activeClasses: new Set(),
  };
  return element;
}

function loadRadio({ fetchImpl, spectrumBarCount = 0 } = {}) {
  const ids = [
    'audio-main',
    'audio-tts',
    'account-list',
    'add-account-btn',
    'btn-play',
    'btn-skip',
    'display-name-input',
    'dj-text',
    'login-screen',
    'mode-options',
    'music-notes-input',
    'onboarding-next-btn',
    'onboarding-screen',
    'onboarding-status',
    'player-bg',
    'player-screen',
    'qr-status',
    'request-form',
    'request-input',
    'scene-label',
    'start-radio-btn',
    'track-artist',
    'track-name',
    'lyrics-panel',
    'lyrics-current',
    'lyrics-next',
    'voice-options',
    'volume-slider',
  ];
  const elements = new Map(ids.map((id) => [id, createElement(id)]));
  const spectrumBars = Array.from({ length: spectrumBarCount }, (_, index) => createElement(`spectrum-${index}`));
  const sockets = [];
  const timers = [];
  let now = 0;
  let nextTimerId = 1;
  const scheduledTimers = new Map();

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(data) {
      this.sent.push(data);
    }
  }

  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  const context = {
    WebSocket: MockWebSocket,
    URL: { createObjectURL: () => 'blob:tts' },
    clearTimeout(id) {
      const timer = scheduledTimers.get(id);
      if (timer) {
        timer.cleared = true;
        scheduledTimers.delete(id);
      }
    },
    console,
    document: {
      createElement,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement(id));
        return elements.get(id);
      },
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '#spectrum-bars span') return spectrumBars;
        return [];
      },
    },
    fetch: fetchImpl || (async () => ({
      ok: true,
      json: async () => ({}),
    })),
    location: {
      host: 'example.test',
      protocol: 'http:',
    },
    navigator: {
      language: 'zh-CN',
    },
    window: {
      localStorage,
    },
    setInterval() {
      return 1;
    },
    setTimeout(callback, delay = 0) {
      const id = nextTimerId;
      nextTimerId += 1;
      const timer = {
        id,
        callback,
        cleared: false,
        dueAt: now + Number(delay || 0),
      };
      scheduledTimers.set(id, timer);
      timers.push(() => {
        if (timer.cleared) return undefined;
        timer.cleared = true;
        scheduledTimers.delete(id);
        return callback();
      });
      return id;
    },
  };

  vm.createContext(context);
  vm.runInContext(readFileSync(radioPath, 'utf8'), context, { filename: radioPath });

  function advanceTimersBy(ms) {
    const target = now + ms;
    for (let guard = 0; guard < 1000; guard++) {
      const nextTimer = [...scheduledTimers.values()]
        .filter((timer) => !timer.cleared && timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!nextTimer) break;
      now = nextTimer.dueAt;
      nextTimer.cleared = true;
      scheduledTimers.delete(nextTimer.id);
      nextTimer.callback();
    }
    now = target;
  }

  return { context, elements, sockets, timers, spectrumBars, advanceTimersBy };
}

async function flushAsyncWork(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function assertAlmostEqual(actual, expected, epsilon = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

async function waitFor(predicate, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

test('repeated start clicks reuse the live radio websocket', async () => {
  const { elements, sockets } = loadRadio();
  const startButton = elements.get('start-radio-btn');

  await startButton.click();
  await startButton.click();

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].readyState, sockets[0].constructor.CONNECTING);
});

test('closed radio websocket can reconnect after onclose', async () => {
  const { elements, sockets, timers } = loadRadio();
  const startButton = elements.get('start-radio-btn');

  await startButton.click();
  sockets[0].readyState = sockets[0].constructor.CLOSED;
  sockets[0].onclose();
  timers.at(-1)();

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].readyState, sockets[1].constructor.CONNECTING);
});

test('bootAuth refreshes persisted login before falling back to QR', async () => {
  const requests = [];
  const { elements } = loadRadio({
    fetchImpl: async (url) => {
      requests.push(url);
      if (url === '/api/auth/status' && requests.filter((x) => x === url).length === 1) {
        return { ok: true, json: async () => ({ data: { profile: null } }) };
      }
      if (url === '/api/auth/refresh') {
        return { ok: true, json: async () => ({ code: 200 }) };
      }
      if (url === '/api/auth/status') {
        return {
          ok: true,
          json: async () => ({ data: { profile: { userId: 42, nickname: 'Saved' } } }),
        };
      }
      if (url === '/api/radio/onboarding/42') {
        return {
          ok: true,
          json: async () => ({ onboarded: true, settings: { voice_preset: 'warm_male' } }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await waitFor(() => requests.includes('/api/radio/onboarding/42'), 80);
  await waitFor(() => elements.get('start-radio-btn').style.display === 'block', 80);

  assert.equal(JSON.stringify(requests.slice(0, 4)), JSON.stringify([
    '/api/auth/status',
    '/api/auth/refresh',
    '/api/auth/status',
    '/api/auth/accounts',
  ]));
  assert.ok(requests.includes('/api/radio/onboarding/42'));
  assert.equal(elements.get('start-radio-btn').style.display, 'block');
});

test('onboarding fetch failure shows default onboarding instead of QR fallback', async () => {
  const requests = [];
  const { elements } = loadRadio({
    fetchImpl: async (url) => {
      requests.push(url);
      if (url === '/api/auth/status') {
        return {
          ok: true,
          json: async () => ({ data: { profile: { userId: 42, nickname: 'Saved' } } }),
        };
      }
      if (url === '/api/auth/accounts') {
        return { ok: true, json: async () => ({ accounts: [], active_uid: '42' }) };
      }
      if (url === '/api/radio/onboarding/42') {
        return { ok: false, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await waitFor(() => elements.get('onboarding-screen').activeClasses.has('active'));

  assert.equal(
    JSON.stringify(requests),
    JSON.stringify(['/api/auth/status', '/api/auth/accounts', '/api/radio/onboarding/42']),
  );
  assert.ok(elements.get('onboarding-screen').activeClasses.has('active'));
  assert.ok(!elements.get('login-screen').activeClasses.has('active'));
  assert.ok(elements.get('onboarding-status').textContent.length > 0);
});

test('bootAuth resumes the radio after refresh for the same saved user', async () => {
  const { elements, sockets, context } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/auth/status') {
        return {
          ok: true,
          json: async () => ({ data: { profile: { userId: 42, nickname: 'Saved' } } }),
        };
      }
      if (url === '/api/auth/accounts') {
        return { ok: true, json: async () => ({ accounts: [], active_uid: '42' }) };
      }
      if (url === '/api/radio/onboarding/42') {
        return {
          ok: true,
          json: async () => ({ onboarded: true, settings: { voice_preset: 'warm_male' } }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  context.window.localStorage.setItem('freqme.radioState.v1', JSON.stringify({
    uid: '42',
    active: true,
    savedAt: Date.now(),
  }));

  await waitFor(() => elements.get('player-screen').activeClasses.has('active'));

  assert.equal(sockets.length, 1);
  assert.ok(elements.get('player-screen').activeClasses.has('active'));
  assert.equal(elements.get('start-radio-btn').style.display, 'none');
});

test('text-only segue stays visible briefly before starting next track', async () => {
  const { context, elements, timers } = loadRadio();
  const audioMain = elements.get('audio-main');

  await context.handleMessage({
    type: 'segue',
    text: '这两首歌的光线刚好接上。',
    tts_ready: false,
    tts_hash: '',
    next_track: { name: 'Next', artist: 'Artist' },
    url: '/api/radio/audio/2',
  });

  assert.equal(elements.get('dj-text').textContent, '这两首歌的光线刚好接上。');
  assert.equal(audioMain.src, '');
  assert.equal(timers.length, 1);

  timers[0]();

  assert.equal(audioMain.src, '/api/radio/audio/2');
  assert.equal(elements.get('track-name').textContent, 'Next');
});

test('late segue TTS starts pending track under DJ speech', async () => {
  const { context, elements, timers } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/tts/bridgehash') {
        return { ok: true, blob: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  const audioTTS = elements.get('audio-tts');

  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-1',
    text: 'Bridge narration.',
    tts_ready: false,
    tts_hash: '',
    next_track: { name: 'Next', artist: 'Artist' },
    url: '/api/radio/audio/2',
  });

  assert.equal(elements.get('dj-text').textContent, 'Bridge narration.');
  assert.equal(audioMain.src, '');
  assert.equal(timers.length, 1);

  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-1',
    text: 'Bridge narration.',
    tts_ready: true,
    tts_hash: 'bridgehash',
    next_track: { name: 'Next', artist: 'Artist' },
    url: '/api/radio/audio/2',
  });
  await flushAsyncWork();

  assert.equal(audioMain.src, '/api/radio/audio/2');
  assert.equal(elements.get('track-name').textContent, 'Next');
  assert.equal(audioTTS.src, 'blob:tts');
});

test('late segue TTS does not restart a track already started by text fallback', async () => {
  const { context, elements, timers } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/tts/bridgehash') {
        return { ok: true, blob: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  const audioTTS = elements.get('audio-tts');

  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-1',
    text: 'Bridge narration.',
    tts_ready: false,
    tts_hash: '',
    next_track: { name: 'Next', artist: 'Artist' },
    url: '/api/radio/audio/2',
  });
  timers[0]();
  await flushAsyncWork();

  assert.equal(audioMain.src, '/api/radio/audio/2');
  assert.equal(audioMain.playCount, 1);

  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-1',
    text: 'Bridge narration.',
    tts_ready: true,
    tts_hash: 'bridgehash',
    next_track: { name: 'Next', artist: 'Artist' },
    url: '/api/radio/audio/2',
  });
  await flushAsyncWork();

  assert.equal(audioMain.src, '/api/radio/audio/2');
  assert.equal(audioMain.playCount, 1);
  assert.equal(audioTTS.src, 'blob:tts');
});

test('stale late segue TTS is ignored after a newer segue starts', async () => {
  const { context, elements } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/tts/stalehash') {
        return { ok: true, blob: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  const audioTTS = elements.get('audio-tts');

  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-old',
    text: 'Old narration.',
    tts_ready: false,
    tts_hash: '',
    next_track: { name: 'Old', artist: 'Artist' },
    url: '/api/radio/audio/old',
  });
  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-new',
    text: 'New narration.',
    tts_ready: false,
    tts_hash: '',
    next_track: { name: 'New', artist: 'Artist' },
    url: '/api/radio/audio/new',
  });
  await context.handleMessage({
    type: 'segue',
    segue_id: 'segue-old',
    text: 'Old narration.',
    tts_ready: true,
    tts_hash: 'stalehash',
    next_track: { name: 'Old', artist: 'Artist' },
    url: '/api/radio/audio/old',
  });
  await flushAsyncWork();

  assert.equal(audioMain.src, '');
  assert.equal(audioTTS.src, '');
  assert.equal(elements.get('dj-text').textContent, 'New narration.');
});

test('session start shows an immediate local DJ greeting while preparing audio', async () => {
  const { context, elements } = loadRadio();

  await context.handleMessage({
    type: 'session_start',
    scene: 'night',
    intro_text: '',
    tts_ready: false,
    tts_hash: '',
  });

  assert.match(elements.get('dj-text').textContent, /今晚|夜|这里|你/);
  assert.doesNotMatch(elements.get('dj-text').textContent, /AI|正在|接入/);
});

test('first track starts under late intro TTS and ducks smoothly while DJ speaks', async () => {
  const { context, elements, advanceTimersBy } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/tts/introhash') {
        return { ok: true, blob: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  const audioTTS = elements.get('audio-tts');

  await context.handleMessage({
    type: 'session_start',
    scene: 'night',
    intro_text: '',
    tts_ready: false,
    tts_hash: '',
  });

  await context.handleMessage({
    type: 'play_track',
    track: { name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });

  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(audioMain.paused, false);
  assert.equal(audioMain.volume, 0.8);

  await context.handleMessage({
    type: 'intro',
    text: 'Welcome to tonight.',
    tts_ready: true,
    tts_hash: 'introhash',
  });
  await flushAsyncWork();

  assert.equal(audioTTS.src, 'blob:tts');
  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(audioMain.paused, false);
  assert.equal(audioMain.volume, 0.8);
  advanceTimersBy(350);
  assertAlmostEqual(audioMain.volume, 0.5);
  advanceTimersBy(350);
  assertAlmostEqual(audioMain.volume, 0.2);

  audioTTS.onended();

  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(elements.get('track-name').textContent, 'First');
  assertAlmostEqual(audioMain.volume, 0.2);
  advanceTimersBy(500);
  assertAlmostEqual(audioMain.volume, 0.5);
  advanceTimersBy(500);
  assertAlmostEqual(audioMain.volume, 0.8);
});

test('skip stops the current first track while intro is pending', async () => {
  const { context, elements, timers } = loadRadio();
  const audioMain = elements.get('audio-main');

  await context.handleMessage({
    type: 'session_start',
    scene: 'night',
    intro_text: '',
    tts_ready: false,
    tts_hash: '',
  });
  await context.handleMessage({
    type: 'play_track',
    track: { name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });

  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(audioMain.paused, false);

  elements.get('btn-skip').click();
  timers.forEach((timer) => timer());

  assert.equal(audioMain.paused, true);
});

test('first track starts immediately even if intro never arrives', async () => {
  const { context, elements, timers } = loadRadio();
  const audioMain = elements.get('audio-main');

  await context.handleMessage({
    type: 'session_start',
    scene: 'night',
    intro_text: '',
    tts_ready: false,
    tts_hash: '',
  });
  await context.handleMessage({
    type: 'play_track',
    track: { name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });

  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(audioMain.paused, false);
  timers[0]();

  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(elements.get('track-name').textContent, 'First');
});

test('play track fetches lyrics and syncs the visible lyric with audio time', async () => {
  const requests = [];
  const { context, elements } = loadRadio({
    fetchImpl: async (url) => {
      requests.push(url);
      if (url === '/api/radio/lyrics/1?name=First&artist=Artist') {
        return {
          ok: true,
          json: async () => ({
            songId: '1',
            source: 'netease',
            lines: [
              { timeMs: 1000, text: 'First lyric' },
              { timeMs: 3500, text: 'Second lyric' },
            ],
            translatedLines: [
              { timeMs: 1000, text: '第一句' },
              { timeMs: 3500, text: '第二句' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');

  await context.handleMessage({
    type: 'play_track',
    track: { id: '1', name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });
  await waitFor(() => elements.get('lyrics-current').textContent.includes('First lyric'), 80);

  assert.ok(requests.includes('/api/radio/lyrics/1?name=First&artist=Artist'));
  assert.ok(!elements.get('lyrics-panel').activeClasses.has('empty'));
  assert.equal(elements.get('lyrics-current').textContent, 'First lyric / 第一句');
  assert.equal(elements.get('lyrics-next').textContent, 'Second lyric');

  audioMain.currentTime = 3.6;
  context.updateProgressUI();

  assert.equal(elements.get('lyrics-current').textContent, 'Second lyric / 第二句');
  assert.equal(elements.get('lyrics-next').textContent, '');
});

test('play track shows a lyric loading state before empty lyrics resolve', async () => {
  let resolveLyrics;
  const lyricPromise = new Promise((resolve) => {
    resolveLyrics = resolve;
  });
  const { context, elements } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/lyrics/1?name=First&artist=Artist') {
        await lyricPromise;
        return {
          ok: true,
          json: async () => ({
            songId: '1',
            source: 'none',
            lines: [],
            translatedLines: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await context.handleMessage({
    type: 'play_track',
    track: { id: '1', name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });

  assert.equal(elements.get('lyrics-current').textContent, '歌词加载中...');
  assert.ok(elements.get('lyrics-panel').activeClasses.has('loading'));
  assert.ok(!elements.get('lyrics-panel').activeClasses.has('empty'));

  resolveLyrics();
  await waitFor(() => elements.get('lyrics-current').textContent === '暂无同步歌词', 80);

  assert.equal(elements.get('lyrics-current').textContent, '暂无同步歌词');
  assert.ok(elements.get('lyrics-panel').activeClasses.has('unavailable'));
  assert.ok(!elements.get('lyrics-panel').activeClasses.has('empty'));
});

test('progress update backfills lyrics for an already playing audio source', async () => {
  const requests = [];
  const { context, elements } = loadRadio({
    fetchImpl: async (url) => {
      requests.push(url);
      if (url === '/api/radio/lyrics/1?name=First&artist=Artist') {
        return {
          ok: true,
          json: async () => ({
            songId: '1',
            source: 'netease',
            lines: [{ timeMs: 1000, text: 'Recovered lyric' }],
            translatedLines: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  audioMain.src = '/api/radio/audio/1';
  audioMain.currentTime = 1.2;
  elements.get('track-name').textContent = 'First';
  elements.get('track-artist').textContent = 'Artist';

  context.updateProgressUI();
  await waitFor(() => elements.get('lyrics-current').textContent === 'Recovered lyric', 80);

  assert.ok(requests.includes('/api/radio/lyrics/1?name=First&artist=Artist'));
  assert.equal(elements.get('lyrics-current').textContent, 'Recovered lyric');
});

test('volume changes during DJ speech retarget the duck and restore smoothly', async () => {
  const { context, elements, advanceTimersBy } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/tts/latehash') {
        return { ok: true, blob: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  const audioTTS = elements.get('audio-tts');
  const volumeSlider = elements.get('volume-slider');

  await context.handleMessage({
    type: 'session_start',
    scene: 'night',
    intro_text: '',
    tts_ready: false,
    tts_hash: '',
  });
  await context.handleMessage({
    type: 'play_track',
    track: { name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });

  await context.handleMessage({
    type: 'intro',
    text: 'Late welcome.',
    tts_ready: true,
    tts_hash: 'latehash',
  });
  await flushAsyncWork();

  assert.equal(audioMain.src, '/api/radio/audio/1');
  assert.equal(audioTTS.src, 'blob:tts');
  advanceTimersBy(700);
  assertAlmostEqual(audioMain.volume, 0.2);

  volumeSlider.value = '50';
  volumeSlider.dispatch('input');

  assertAlmostEqual(audioMain.volume, 0.2);
  advanceTimersBy(150);
  assertAlmostEqual(audioMain.volume, 0.1625);
  advanceTimersBy(150);
  assertAlmostEqual(audioMain.volume, 0.125);

  audioTTS.onended();

  assertAlmostEqual(audioMain.volume, 0.125);
  advanceTimersBy(500);
  assertAlmostEqual(audioMain.volume, 0.3125);
  advanceTimersBy(500);
  assertAlmostEqual(audioMain.volume, 0.5);
});

test('play button resumes both DJ speech and ducked music after pausing during TTS', async () => {
  const { context, elements, advanceTimersBy } = loadRadio({
    fetchImpl: async (url) => {
      if (url === '/api/radio/tts/speechhash') {
        return { ok: true, blob: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const audioMain = elements.get('audio-main');
  const audioTTS = elements.get('audio-tts');
  const playButton = elements.get('btn-play');

  await context.handleMessage({
    type: 'play_track',
    track: { name: 'First', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });
  await context.handleMessage({
    type: 'dj_message',
    text: '这一段我轻声说完，歌会在下面垫着。',
    tts_ready: true,
    tts_hash: 'speechhash',
  });
  await flushAsyncWork();
  advanceTimersBy(700);

  assert.equal(audioMain.paused, false);
  assert.equal(audioTTS.paused, false);
  assertAlmostEqual(audioMain.volume, 0.2);

  playButton.click();
  assert.equal(audioMain.paused, true);
  assert.equal(audioTTS.paused, true);

  playButton.click();
  assert.equal(audioMain.paused, false);
  assert.equal(audioTTS.paused, false);
  assert.equal(elements.get('btn-play').textContent, '⏸');
});

test('intro message updates DJ text after playback has started', async () => {
  const { context, elements } = loadRadio();

  await context.handleMessage({
    type: 'intro',
    text: '今晚先把声音放低一点。',
    tts_ready: false,
    tts_hash: '',
  });

  assert.equal(elements.get('dj-text').textContent, '今晚先把声音放低一点。');
});

test('handshake includes local time context for time-aware radio', async () => {
  const { elements, sockets } = loadRadio();
  const startButton = elements.get('start-radio-btn');

  await startButton.click();
  sockets[0].readyState = sockets[0].constructor.OPEN;
  sockets[0].onopen();

  const sent = JSON.parse(sockets[0].sent[0]);
  assert.equal(sent.type, 'handshake');
  assert.equal(typeof sent.utc_offset, 'number');
  assert.equal(sent.locale, 'zh-CN');
  assert.equal(typeof sent.timezone_name, 'string');
  assert.equal(typeof sent.region_hint, 'string');
});

test('request form sends song request text without changing playback locally', async () => {
  const { elements, sockets } = loadRadio();
  const startButton = elements.get('start-radio-btn');
  const requestInput = elements.get('request-input');
  const requestForm = elements.get('request-form');

  await startButton.click();
  sockets[0].readyState = sockets[0].constructor.OPEN;
  requestInput.value = '想听夜路上放空的歌';

  requestForm.dispatch('submit');

  const sent = JSON.parse(sockets[0].sent[0]);
  assert.equal(sent.type, 'song_request');
  assert.equal(sent.text, '想听夜路上放空的歌');
  assert.equal(requestInput.value, '');
});

test('spectrum renderer preserves frequency variation and avoids uniform clipping', () => {
  const { context, spectrumBars } = loadRadio({ spectrumBarCount: 32 });
  const levels = Array.from({ length: 32 }, (_, index) => {
    const bass = index < 7 ? 0.86 - index * 0.055 : 0;
    const mids = index >= 10 && index < 20 ? 0.38 + Math.sin(index * 0.9) * 0.16 : 0;
    const highs = index >= 24 ? 0.16 + ((index % 4) * 0.055) : 0;
    return Math.max(0.02, bass, mids, highs);
  });

  context.updateSpectrum(levels, false);
  context.updateSpectrum(levels, false);

  const scales = spectrumBars.map((bar) => Number(bar.style.getPropertyValue('--bar-scale')));
  const uniqueScales = new Set(scales.map((scale) => scale.toFixed(2)));
  const topCount = scales.filter((scale) => scale > 1.02).length;
  const spread = Math.max(...scales) - Math.min(...scales);

  assert.equal(scales.length, 32);
  assert.ok(uniqueScales.size >= 10, `expected varied bars, got ${JSON.stringify(scales)}`);
  assert.ok(spread > 0.25, `expected visible height spread, got ${spread}`);
  assert.ok(topCount <= 3, `too many bars are clipping near the top: ${topCount}`);
});

test('request status tells listener whether the requested direction is queued', async () => {
  const { context, elements } = loadRadio();

  await context.handleMessage({
    type: 'request_status',
    status: 'ready',
    text: '找到了，下一首先给你接这首。',
    next_track: { name: 'Emo Song', artist: 'Singer' },
  });

  assert.equal(elements.get('dj-text').textContent, '找到了，下一首先给你接这首。');

  await context.handleMessage({
    type: 'request_status',
    status: 'fallback',
    text: '没找到特别准的，我先往这个情绪靠。',
  });

  assert.equal(elements.get('dj-text').textContent, '没找到特别准的，我先往这个情绪靠。');
});

test('planning request status speaks visually without changing current playback', async () => {
  const { context, elements, spectrumBars } = loadRadio({ spectrumBarCount: 8 });
  const audioMain = elements.get('audio-main');
  audioMain.src = '/api/radio/audio/1';
  audioMain.paused = false;
  const beforeSrc = audioMain.src;
  const beforePaused = audioMain.paused;

  await context.handleMessage({
    type: 'request_status',
    status: 'planning',
    text: '我听到了，正在把这个方向接进来。',
  });

  assert.equal(elements.get('dj-text').textContent, '我听到了，正在把这个方向接进来。');
  assert.equal(audioMain.src, beforeSrc);
  assert.equal(audioMain.paused, beforePaused);
  assert.ok(spectrumBars.some((bar) => Number(bar.style.getPropertyValue('--bar-scale')) > 0));
});

test('explained request status updates DJ text without changing current playback', async () => {
  const { context, elements, spectrumBars } = loadRadio({ spectrumBarCount: 8 });
  const audioMain = elements.get('audio-main');
  audioMain.src = '/api/radio/audio/1';
  audioMain.paused = false;
  const beforeSrc = audioMain.src;
  const beforePaused = audioMain.paused;

  await context.handleMessage({
    type: 'request_status',
    status: 'explained',
    text: '因为它和上一首的低频与留白接得很顺。',
  });

  assert.equal(elements.get('dj-text').textContent, '因为它和上一首的低频与留白接得很顺。');
  assert.equal(audioMain.src, beforeSrc);
  assert.equal(audioMain.paused, beforePaused);
  assert.ok(spectrumBars.some((bar) => Number(bar.style.getPropertyValue('--bar-scale')) > 0));
});
