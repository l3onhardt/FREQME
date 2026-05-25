import fs from 'node:fs';
import path from 'node:path';

export function loadCookie(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.cookie === 'string' ? parsed.cookie : '';
  } catch {
    return '';
  }
}

export function saveCookie(filePath, cookie) {
  if (!cookie) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({ cookie, updatedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.renameSync(tmpPath, filePath);
}

export function clearCookie(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort local logout cleanup.
  }
}

export function sanitizeLoginBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clean = { ...body };
  delete clean.cookie;
  if (clean.data && typeof clean.data === 'object') {
    clean.data = { ...clean.data };
    delete clean.data.cookie;
  }
  return clean;
}

export function responseBodyFromError(error) {
  if (error?.body && typeof error.body === 'object') {
    return sanitizeLoginBody(error.body);
  }
  if (typeof error === 'object' && error && 'code' in error) {
    return sanitizeLoginBody(error);
  }
  return {
    code: -1,
    message: error?.message || 'NetEase bridge request failed',
  };
}
