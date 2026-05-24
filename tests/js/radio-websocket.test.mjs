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
    clearTimeout() {},
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
    setInterval() {
      return 1;
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
  };

  vm.createContext(context);
  vm.runInContext(readFileSync(radioPath, 'utf8'), context, { filename: radioPath });

  return { elements, sockets, timers };
}

async function flushAsyncWork(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
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
