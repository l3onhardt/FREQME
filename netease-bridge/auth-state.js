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
    'utf8',
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
  const clean = structuredClone(body);
  delete clean.cookie;
  if (clean.data && typeof clean.data === 'object') {
    delete clean.data.cookie;
  }
  return clean;
}
