import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSongUrl } from './song-url.js';

test('resolveSongUrl calls song_url_v1 with cookie and exhigh level first', async () => {
  const calls = [];
  const body = await resolveSongUrl({
    id: '42',
    cookie: 'MUSIC_U=abc;',
    api: {
      async song_url_v1(params) {
        calls.push(['v1', params]);
        return { body: { code: 200, data: [{ id: 42, url: 'https://cdn.test/42.mp3', code: 200 }] } };
      },
      async song_url(params) {
        calls.push(['legacy', params]);
        return { body: { code: 200, data: [] } };
      },
    },
  });

  assert.equal(body.data[0].url, 'https://cdn.test/42.mp3');
  assert.deepEqual(calls, [['v1', { id: '42', level: 'exhigh', cookie: 'MUSIC_U=abc;' }]]);
});

test('resolveSongUrl falls back to standard level before legacy song_url', async () => {
  const calls = [];
  const body = await resolveSongUrl({
    id: '43',
    cookie: 'MUSIC_U=abc;',
    api: {
      async song_url_v1(params) {
        calls.push(['v1', params]);
        return { body: { code: 200, data: [{ id: 43, url: null, code: 404 }] } };
      },
      async song_url(params) {
        calls.push(['legacy', params]);
        return { body: { code: 200, data: [{ id: 43, url: 'https://cdn.test/43.mp3', code: 200 }] } };
      },
    },
  });

  assert.equal(body.data[0].url, 'https://cdn.test/43.mp3');
  assert.deepEqual(calls, [
    ['v1', { id: '43', level: 'exhigh', cookie: 'MUSIC_U=abc;' }],
    ['v1', { id: '43', level: 'standard', cookie: 'MUSIC_U=abc;' }],
    ['legacy', { id: '43', br: 320000, cookie: 'MUSIC_U=abc;' }],
  ]);
});

test('resolveSongUrl returns an explicit unplayable body instead of a fabricated outer url', async () => {
  const body = await resolveSongUrl({
    id: '44',
    api: {
      async song_url_v1() {
        return { body: { code: 200, data: [{ id: 44, url: null, code: 404 }] } };
      },
      async song_url() {
        return { body: { code: 200, data: [{ id: 44, url: null, code: 404 }] } };
      },
    },
  });

  assert.equal(body.code, 200);
  assert.equal(body.data[0].id, '44');
  assert.equal(body.data[0].url, null);
  assert.equal(body.data[0].code, 404);
});
