import NeteaseCloudMusicApi from 'NeteaseCloudMusicApi';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    clearCookie,
    loadCookie,
    saveCookie,
    sanitizeLoginBody,
} from './auth-state.js';

const {
    login_qr_key, login_qr_create, login_qr_check,
    user_playlist, user_record, recommend_songs,
    personal_fm, simi_song, song_url, search,
    login_refresh, login_status, like_list,
} = NeteaseCloudMusicApi;

const app = express();
app.use(express.json());

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cookiePath = process.env.NETEASE_COOKIE_PATH || path.join(projectRoot, 'data', 'netease-cookie.json');
let cookie = loadCookie(cookiePath);

function persistCookieBestEffort(nextCookie) {
    cookie = nextCookie;
    try {
        saveCookie(cookiePath, cookie);
    } catch (error) {
        console.warn(`failed to persist NetEase cookie: ${error?.message || error}`);
    }
}

// QR login endpoints
app.get('/login/qr/key', async (req, res) => {
    const r = await login_qr_key({});
    res.json(r.body);
});

app.get('/login/qr/create', async (req, res) => {
    const r = await login_qr_create({ key: req.query.key, qrimg: true });
    res.json(r.body);
});

app.get('/login/qr/check', async (req, res) => {
    const r = await login_qr_check({ key: req.query.key });
    if (r.body.code === 803 && r.body.cookie) {
        persistCookieBestEffort(r.body.cookie);
    }
    res.json(sanitizeLoginBody(r.body));
});

// Auth-required helper
function withCookie(opts) {
    return cookie ? { ...opts, cookie } : opts;
}

app.get('/user/playlist', async (req, res) => {
    const r = await user_playlist(withCookie({ uid: req.query.uid }));
    res.json(r.body);
});

app.get('/user/record', async (req, res) => {
    const r = await user_record(withCookie({ uid: req.query.uid, type: 1 }));
    res.json(r.body);
});

app.get('/recommend/songs', async (req, res) => {
    const r = await recommend_songs(withCookie({}));
    res.json(r.body);
});

app.get('/personal_fm', async (req, res) => {
    const r = await personal_fm(withCookie({}));
    res.json(r.body);
});

app.get('/simi/song', async (req, res) => {
    const r = await simi_song({ id: req.query.id });
    res.json(r.body);
});

app.get('/song/url', async (req, res) => {
    const r = await song_url({ id: req.query.id, br: 320000 });
    res.json(r.body);
});

app.get('/search', async (req, res) => {
    const r = await search({ keywords: req.query.keywords, type: 1, limit: 10 });
    res.json(r.body);
});

app.get('/like/list', async (req, res) => {
    const r = await like_list(withCookie({ uid: req.query.uid }));
    res.json(r.body);
});

app.get('/login/status', async (req, res) => {
    const r = await login_status({ cookie });
    res.json(sanitizeLoginBody(r.body));
});

app.get('/login/refresh', async (req, res) => {
    const r = await login_refresh({ cookie });
    if (r.body.cookie) {
        persistCookieBestEffort(r.body.cookie);
    }
    res.json(sanitizeLoginBody(r.body));
});

app.post('/logout', async (_req, res) => {
    cookie = '';
    clearCookie(cookiePath);
    res.json({ code: 200 });
});

app.get('/health', (req, res) => res.send('ok'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`netease-bridge ready on port ${port}`));
