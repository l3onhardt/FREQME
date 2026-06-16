import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';

const BASE_URL = process.env.FREQME_SMOKE_BASE_URL || 'http://127.0.0.1:8000';
const WS_URL = BASE_URL.replace(/^http/u, 'ws') + '/ws';
const MESSAGE_TIMEOUT_MS = Number(process.env.FREQME_SMOKE_MESSAGE_TIMEOUT_MS || 30000);
const AUDIO_TIMEOUT_MS = Number(process.env.FREQME_SMOKE_AUDIO_TIMEOUT_MS || 12000);

const DIRECTIONS = {
  rnb: 'play rnb',
  quietJazz: 'play quiet jazz for reading',
  quietFocus: 'play quiet focus music',
  chineseQuietMood: '\u653e\u70b9\u665a\u4e0a\u5b89\u9759\u4e00\u70b9\u7684\u6b4c',
  correction: 'do not play jazz, switch to late-night R&B',
};

const UNSAFE_HOST_TEXT =
  /\b(model|prompt|json|tool call|shadow decision|decision trace|trace basis|verification|candidate|program contract|contract|pipeline|main line|current station direction)\b|旁边|质感|继续保持这个感觉|鎴|銆|鐨|涓|杩|俙|閹|娑|鐢|鍙|姘|绋|濂|鏀|浣/u;

const smokeAvailable = await serverAvailable();

test('live radio agent websocket request and continuation smoke', { skip: !smokeAvailable }, async (t) => {
  await runDirectionScenario(t, DIRECTIONS.rnb, { label: 'rnb' });
  await runDirectionScenario(t, DIRECTIONS.quietJazz, { label: 'quiet-jazz' });
  await runDirectionScenario(t, DIRECTIONS.quietFocus, { label: 'quiet-focus' });
  await runDirectionScenario(t, DIRECTIONS.chineseQuietMood, { label: 'chinese-quiet-mood' });
  await runCorrectionScenario(t, DIRECTIONS.quietJazz, DIRECTIONS.correction);
});

async function serverAvailable() {
  try {
    const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const health = await response.json().catch(() => ({}));
    return health.status === 'ok' || health.backend === 'typescript';
  } catch {
    return false;
  }
}

async function runDirectionScenario(t, requestText, options = {}) {
  const client = await connectRadioClient();
  const seen = [];
  const hostLines = [];
  const label = options.label || requestText;
  try {
    client.send({
      type: 'handshake',
      uid: null,
      settings: {},
      locale: 'zh-CN',
      timezone_name: 'Asia/Hong_Kong',
      utc_offset: 480,
    });

    const opening = await waitForPlayable(client, { seen, hostLines });
    assertPlayableMessage(opening, `${options.label || requestText}: opening`);
    await probeAudio(opening.url);

    client.send({ type: 'song_request', text: requestText });
    const requestPlayable = await waitForPlayable(client, {
      seen,
      hostLines,
      after: Date.now(),
      rejectNotFound: true,
    });
    assertPlayableMessage(requestPlayable, `${options.label || requestText}: request`);
    await probeAudio(requestPlayable.url);

    for (let i = 0; i < 3; i += 1) {
      client.send({ type: 'track_ended' });
      const next = await waitForPlayable(client, { seen, hostLines, rejectNotFound: true });
      assertPlayableMessage(next, `${options.label || requestText}: continuation ${i + 1}`);
      await probeAudio(next.url);
    }

    assertNoDuplicateTracks(seen, label);
    assertSafeHostLines(hostLines);
    await assertAgentStatusHasGovernance();
    t.diagnostic(`${label}: ${seen.map(trackKeyFromMessage).join(' -> ')}`);
  } catch (error) {
    const suffix = seen.length ? `; seen ${seen.map(trackKeyFromMessage).join(' -> ')}` : '';
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}${suffix}; recent ${formatRecentMessages(client.recentMessages())}`);
  } finally {
    client.close();
  }
}

async function runCorrectionScenario(t, initialRequest, correctionText) {
  const client = await connectRadioClient();
  const seen = [];
  const hostLines = [];
  try {
    client.send({
      type: 'handshake',
      uid: null,
      settings: {},
      locale: 'zh-CN',
      timezone_name: 'Asia/Hong_Kong',
      utc_offset: 480,
    });

    await waitForPlayable(client, { seen, hostLines });
    client.send({ type: 'song_request', text: initialRequest });
    await waitForPlayable(client, { seen, hostLines, rejectNotFound: true });

    const correctionStartedAt = Date.now();
    client.send({ type: 'song_request', text: correctionText });
    const corrected = await waitForPlayable(client, {
      seen,
      hostLines,
      after: correctionStartedAt,
      rejectNotFound: true,
    });
    assertPlayableMessage(corrected, 'correction request');
    assertSafeHostLines(hostLines);
    await probeAudio(corrected.url);
    await assertAgentStatusHasGovernance();
    t.diagnostic(`correction: ${seen.map(trackKeyFromMessage).join(' -> ')}`);
  } catch (error) {
    const suffix = seen.length ? `; seen ${seen.map(trackKeyFromMessage).join(' -> ')}` : '';
    throw new Error(`correction: ${error instanceof Error ? error.message : String(error)}${suffix}; recent ${formatRecentMessages(client.recentMessages())}`);
  } finally {
    client.close();
  }
}

async function connectRadioClient() {
  const ws = new WebSocket(WS_URL);
  const messages = [];
  const waiters = [];
  const playedSegueIds = new Set();
  let nextMessageIndex = 0;
  let closed = false;
  let closeError = null;

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    messages.push({ message, receivedAt: Date.now() });
    for (const waiter of [...waiters]) {
      waiter.check();
    }
  });
  ws.on('close', () => {
    closed = true;
    for (const waiter of [...waiters]) waiter.check();
  });
  ws.on('error', (error) => {
    closeError = error;
    for (const waiter of [...waiters]) waiter.check();
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket open timed out: ${WS_URL}`)), MESSAGE_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return {
    send(payload) {
      ws.send(JSON.stringify(payload));
    },
    waitFor(predicate, label) {
      return waitForMessage({
        messages,
        waiters,
        predicate,
        label,
        isClosed: () => closed,
        error: () => closeError,
        getNextIndex: () => nextMessageIndex,
        setNextIndex: (index) => {
          nextMessageIndex = index;
        },
      });
    },
    recentMessages() {
      return messages.slice(-12).map((entry) => entry.message);
    },
    hasPlayedSegue(message) {
      const id = typeof message?.segue_id === 'string' ? message.segue_id : '';
      return Boolean(id && playedSegueIds.has(id));
    },
    markPlayed(message) {
      const id = typeof message?.segue_id === 'string' ? message.segue_id : '';
      if (message?.type === 'segue' && id) playedSegueIds.add(id);
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

function waitForMessage({ messages, waiters, predicate, label, isClosed, error, getNextIndex, setNextIndex }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const waiter = {
      check() {
        if (error()) {
          cleanup();
          reject(error());
          return;
        }
        for (let index = getNextIndex(); index < messages.length; index += 1) {
          const entry = messages[index];
          let found = false;
          try {
            found = Boolean(predicate(entry.message, entry.receivedAt));
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }
          if (found) {
            setNextIndex(index + 1);
            cleanup();
            resolve(entry);
            return;
          }
        }
        if (isClosed()) {
          cleanup();
          reject(new Error(`websocket closed before ${label}`));
        }
      },
    };
    const cleanup = () => {
      clearTimeout(timer);
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    };
    const timer = setTimeout(() => {
      cleanup();
      const types = messages.map((entry) => entry.message?.type).join(', ');
      reject(new Error(`timed out waiting for ${label} after ${Date.now() - started}ms; saw [${types}]`));
    }, MESSAGE_TIMEOUT_MS);
    waiters.push(waiter);
    waiter.check();
  });
}

async function waitForPlayable(client, options = {}) {
  const entry = await client.waitFor((message, receivedAt) => {
    collectHostLine(message, options.hostLines);
    if (message.type === 'error') {
      throw new Error(`server websocket error: ${message.message || 'unknown'}`);
    }
    if (options.rejectNotFound && message.type === 'request_status' && message.status === 'not_found') {
      throw new Error(`radio agent returned not_found: ${message.text || ''}`);
    }
    if (options.after && receivedAt < options.after) return false;
    if (message.type === 'play_track') return true;
    if (message.type === 'segue') return !client.hasPlayedSegue(message);
    return false;
  }, 'playable play_track/segue');

  const message = entry.message;
  client.markPlayed(message);
  if (options.seen) options.seen.push(message);
  collectHostLine(message, options.hostLines);
  return message;
}

function collectHostLine(message, hostLines = []) {
  for (const field of ['text', 'intro_text']) {
    if (typeof message[field] === 'string' && message[field].trim()) hostLines.push(message[field].trim());
  }
  if (message.type === 'request_status' && typeof message.text === 'string' && message.text.trim()) {
    hostLines.push(message.text.trim());
  }
}

function assertPlayableMessage(message, label) {
  assert.ok(message, `${label}: expected message`);
  assert.ok(message.type === 'play_track' || message.type === 'segue', `${label}: expected playable message`);
  assert.ok(message.url, `${label}: expected audio url`);
  const track = message.track || message.next_track;
  assert.ok(track, `${label}: expected track`);
  assert.ok(track.name || track.songName, `${label}: expected track name`);
}

async function probeAudio(url) {
  const absolute = new URL(url, BASE_URL).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);
  try {
    const response = await fetch(absolute, {
      headers: { Range: 'bytes=0-8191' },
      signal: controller.signal,
    });
    assert.ok(response.status === 200 || response.status === 206, `audio probe ${absolute} returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0, `audio probe ${absolute} returned no bytes`);
  } finally {
    clearTimeout(timer);
  }
}

function assertNoDuplicateTracks(messages, label) {
  const keys = messages.map(trackKeyFromMessage).filter(Boolean);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], `${label}: duplicate tracks in live smoke`);
}

function assertSafeHostLines(lines) {
  for (const line of lines) {
    assert.doesNotMatch(line, UNSAFE_HOST_TEXT, `unsafe host line: ${line}`);
  }
}

async function assertAgentStatusHasGovernance() {
  const response = await fetch(`${BASE_URL}/api/radio/agent/status`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.ok(status.mode, 'status should expose agent mode');
  assert.ok(status.readiness, 'status should expose readiness');
  if (status.governance) {
    const accepted = status.governance.lastAccepted;
    const rejected = status.governance.lastRejected;
    const trace = accepted || rejected;
    if (trace) {
      assert.ok(trace.candidateKey, 'governance trace should expose candidate key');
      assert.ok(trace.decision, 'governance trace should expose decision');
      assert.ok(Array.isArray(trace.evidence), 'governance trace should expose evidence');
    }
  }
}

function trackKeyFromMessage(message) {
  const track = message.track || message.next_track || {};
  const name = String(track.name || track.songName || '').toLowerCase().replace(/\s+/gu, ' ').trim();
  const artist = String(track.artist || '').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (artist || name) return `${artist}:${name}`;
  return String(track.id || track.songId || '').trim();
}

function formatRecentMessages(messages) {
  return messages
    .map((message) => {
      const type = message?.type || 'unknown';
      if (type === 'request_status') return `${type}:${message.status || ''}:${message.text || ''}`;
      if (type === 'error') return `${type}:${message.message || ''}`;
      if (type === 'play_track' || type === 'segue') return `${type}:${trackKeyFromMessage(message)}`;
      return type;
    })
    .join(' | ');
}
