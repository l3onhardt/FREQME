import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const radioPath = resolve('frontend/js/radio.js');

function createElement(id = '') {
  const listeners = new Map();
  return {
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
      add() {},
      remove() {},
      toggle() {},
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
  };
}

function loadRadio() {
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
    fetch: async () => ({
      ok: true,
      json: async () => ({}),
    }),
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
