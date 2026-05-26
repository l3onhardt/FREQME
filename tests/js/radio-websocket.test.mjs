import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const radioPath = resolve('frontend/js/radio.js');

function createElement(id = '') {
  const listeners = new Map();
  const element = {
    id,
    className: '',
    dataset: {},
    disabled: false,
    ended: true,
    paused: true,
    src: '',
    style: {},
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
      this.paused = false;
      return Promise.resolve();
    },
    removeAttribute(attr) {
      delete this[attr];
    },
    activeClasses: new Set(),
  };
  return element;
}

function loadRadio({ fetchImpl } = {}) {
  const ids = [
    'audio-main',
    'audio-tts',
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
    'voice-options',
    'volume-slider',
  ];
  const elements = new Map(ids.map((id) => [id, createElement(id)]));
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
      querySelectorAll() {
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

  return { context, elements, sockets, timers, advanceTimersBy };
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

  await waitFor(() => elements.get('start-radio-btn').style.display === 'block');

  assert.equal(JSON.stringify(requests.slice(0, 4)), JSON.stringify([
    '/api/auth/status',
    '/api/auth/refresh',
    '/api/auth/status',
    '/api/radio/onboarding/42',
  ]));
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
      if (url === '/api/radio/onboarding/42') {
        return { ok: false, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await waitFor(() => elements.get('onboarding-screen').activeClasses.has('active'));

  assert.equal(
    JSON.stringify(requests),
    JSON.stringify(['/api/auth/status', '/api/radio/onboarding/42']),
  );
  assert.ok(elements.get('onboarding-screen').activeClasses.has('active'));
  assert.ok(!elements.get('login-screen').activeClasses.has('active'));
  assert.ok(elements.get('onboarding-status').textContent.length > 0);
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
