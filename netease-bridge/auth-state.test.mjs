import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCookie,
  saveCookie,
  sanitizeLoginBody,
} from './auth-state.js';

test('saveCookie and loadCookie persist a cookie string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netease-auth-'));
  const file = path.join(dir, 'cookie.json');

  saveCookie(file, 'MUSIC_U=abc; NMTID=xyz;');

  assert.equal(loadCookie(file), 'MUSIC_U=abc; NMTID=xyz;');
});

test('loadCookie returns empty string when file is missing or invalid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netease-auth-'));

  assert.equal(loadCookie(path.join(dir, 'missing.json')), '');

  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{bad json', 'utf8');
  assert.equal(loadCookie(badFile), '');
});

test('sanitizeLoginBody removes cookie before response is sent to browser', () => {
  const body = {
    code: 803,
    cookie: 'SECRET',
    data: { code: 803, cookie: 'ALSO_SECRET', profile: { userId: 1 } },
  };

  const clean = sanitizeLoginBody(body);

  assert.equal(clean.cookie, undefined);
  assert.equal(clean.data.cookie, undefined);
  assert.equal(clean.data.profile.userId, 1);
});
