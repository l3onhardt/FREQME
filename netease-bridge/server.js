import NeteaseCloudMusicApi from 'NeteaseCloudMusicApi';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    clearCookie,
    loadCookie,
    responseBodyFromError,
    saveCookie,
    sanitizeLoginBody,
} from './auth-state.js';

const {
    login_qr_key, login_qr_create, login_qr_check,
    user_playlist, playlist_detail, user_record, recommend_songs,
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

function asyncRoute(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.warn('[bridge request failed]', error?.message || error);
            res.json(responseBodyFromError(error));
        }
    };
}

// QR login endpoints
app.get('/login/qr/key', asyncRoute(async (req, res) => {
    const r = await login_qr_key({});
    res.json(r.body);
}));

app.get('/login/qr/create', asyncRoute(async (req, res) => {
    const r = await login_qr_create({ key: req.query.key, qrimg: true });
    res.json(r.body);
}));

app.get('/login/qr/check', asyncRoute(async (req, res) => {
    const r = await login_qr_check({ key: req.query.key });
    if (r.body.code === 803 && r.body.cookie) {
        persistCookieBestEffort(r.body.cookie);
    }
    res.json(sanitizeLoginBody(r.body));
}));

// Auth-required helper
function withCookie(opts) {
    return cookie ? { ...opts, cookie } : opts;
}

app.get('/user/playlist', asyncRoute(async (req, res) => {
    const r = await user_playlist(withCookie({ uid: req.query.uid }));
    res.json(r.body);
}));

app.get('/playlist/detail', asyncRoute(async (req, res) => {
    const r = await playlist_detail(withCookie({ id: req.query.id }));
    res.json(r.body);
}));

app.get('/user/record', asyncRoute(async (req, res) => {
    const r = await user_record(withCookie({ uid: req.query.uid, type: 1 }));
    res.json(r.body);
}));

app.get('/recommend/songs', asyncRoute(async (req, res) => {
    const r = await recommend_songs(withCookie({}));
    res.json(r.body);
}));

app.get('/personal_fm', asyncRoute(async (req, res) => {
    const r = await personal_fm(withCookie({}));
    res.json(r.body);
}));

app.get('/simi/song', asyncRoute(async (req, res) => {
    const r = await simi_song({ id: req.query.id });
    res.json(r.body);
}));

app.get('/song/url', asyncRoute(async (req, res) => {
    const r = await song_url({ id: req.query.id, br: 320000 });
    res.json(r.body);
}));

app.get('/search', asyncRoute(async (req, res) => {
    const r = await search({ keywords: req.query.keywords, type: 1, limit: 10 });
    res.json(r.body);
}));

app.get('/like/list', asyncRoute(async (req, res) => {
    const r = await like_list(withCookie({ uid: req.query.uid }));
    res.json(r.body);
}));

app.get('/login/status', asyncRoute(async (req, res) => {
    const r = await login_status({ cookie });
    res.json(sanitizeLoginBody(r.body));
}));

app.get('/login/refresh', asyncRoute(async (req, res) => {
    const r = await login_refresh({ cookie });
    if (r.body.cookie) {
        persistCookieBestEffort(r.body.cookie);
    }
    res.json(sanitizeLoginBody(r.body));
}));

app.post('/logout', async (_req, res) => {
    cookie = '';
    clearCookie(cookiePath);
    res.json({ code: 200 });
});

app.get('/health', (req, res) => res.send('ok'));

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`netease-bridge ready on ${host}:${port}`));
