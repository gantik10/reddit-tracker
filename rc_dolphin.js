// ============================================================
//  Reddit Checker — Dolphin Anty mode. Each account is opened in
//  its own throwaway Dolphin profile (fresh fingerprint, the
//  account's own SOCKS5 proxy, its cookies) and checked from
//  inside that real browser. Afterwards the profile and the proxy
//  entry Dolphin saved for it are deleted, so the Dolphin account
//  never fills up (profile limit) and its Proxies list stays clean.
//
//  Needs the Dolphin Anty app running on THIS server (local API
//  on 127.0.0.1:3001 — keep that port firewalled) and the Dolphin
//  token from Settings (synced into data.json keys).
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer-core');

const CLOUD = 'https://dolphin-anty-api.com';
const LOCAL = process.env.DOLPHIN_LOCAL_API || 'http://127.0.0.1:3001/v1.0';
const DOLPHIN_DIR = path.join(os.homedir(), '.config', 'dolphin_anty');
const DATA_FILE = path.join(__dirname, 'data.json');
// Everything this module creates in Dolphin carries this prefix, so leftovers can be swept safely.
const PREFIX = 'rc-check ';
const CONCURRENCY = Number(process.env.RC_DOLPHIN_CONCURRENCY) || 4; // ~250 MB RAM per running browser

// Skip images/video/fonts — the check only reads the page markup and a few JSON calls,
// and residential proxy traffic is billed per GB.
const BLOCKED_URLS = ['*.jpg*', '*.jpeg*', '*.png*', '*.gif*', '*.webp*', '*.avif*', '*.svg*', '*.mp4*', '*.webm*', '*.woff*', '*.ttf*',
    '*i.redd.it*', '*v.redd.it*', '*preview.redd.it*', '*external-preview.redd.it*', '*styles.redditmedia.com*', '*emoji.redditmedia.com*',
    '*thumbs.redditmedia.com*', '*doubleclick.net*', '*googlesyndication.com*', '*google-analytics.com*'];

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Thrown for problems on our side (Dolphin down, API refused) — these must not change an account's status.
class InfraError extends Error {}

// ---- Token (from Settings → data.json keys; cached briefly — data.json is ~10 MB) ----
let tokenCache = { value: '', at: 0 };
function getToken() {
    if (process.env.DOLPHIN_TOKEN) return process.env.DOLPHIN_TOKEN;
    if (Date.now() - tokenCache.at < 60000) return tokenCache.value;
    let value = '';
    try { value = (JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).keys?.lk_dolphin_token || '').trim(); } catch {}
    tokenCache = { value, at: Date.now() };
    return value;
}

async function request(method, url, { body, auth, timeout = 60000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + getToken();
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { code: r.status, json, text };
}
// Cloud API, retried on rate limits / 5xx.
async function cloud(method, p, body) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            last = await request(method, CLOUD + p, { body, auth: true });
            if (last.code !== 429 && last.code < 500) return last;
        } catch (e) { last = { code: 0, json: null, text: e.message }; }
        await sleep(1500 * (attempt + 1));
    }
    return last;
}
const local = (method, p, opts = {}) => request(method, LOCAL + p, opts);

// ---- Readiness ----
let loggedInAt = 0;
let browserMajor = null;

// Fingerprints should match the Anty browser core Dolphin actually runs (browser/<build>/chrome).
function detectBrowserMajor() {
    return new Promise((resolve) => {
        let dirs = [];
        try { dirs = fs.readdirSync(path.join(DOLPHIN_DIR, 'browser')).filter(d => /^\d+$/.test(d)).sort((a, b) => b - a); } catch {}
        if (!dirs.length) return resolve(null);
        execFile(path.join(DOLPHIN_DIR, 'browser', dirs[0], 'chrome'), ['--version'], { timeout: 15000 }, (err, out) => {
            resolve((String(out || '').match(/(\d+)\.\d+\.\d+/) || [])[1] || null);
        });
    });
}

async function ensureReady({ relogin = false } = {}) {
    const token = getToken();
    if (!token) return { ok: false, error: 'No Dolphin Anty token — add it in Settings.' };
    try {
        if (relogin || !loggedInAt) {
            const r = await local('POST', '/auth/login-with-token', { body: { token }, timeout: 30000 });
            if (!r.json || !r.json.success) return { ok: false, error: 'Dolphin Anty rejected the token: ' + r.text.slice(0, 120) };
            loggedInAt = Date.now();
        }
    } catch {
        loggedInAt = 0;
        return { ok: false, error: 'Dolphin Anty is not running on the server (local API unreachable).' };
    }
    if (!browserMajor) browserMajor = await detectBrowserMajor();
    return { ok: true, browserMajor, concurrency: CONCURRENCY };
}

// For the UI badge: is the Dolphin app up and logged in right now?
async function status() {
    try { await local('GET', '/browser_profiles/running', { timeout: 5000 }); }
    catch { loggedInAt = 0; return { ok: false, error: 'Dolphin Anty is not running on the server (local API unreachable).' }; }
    return ensureReady();
}

// ---- Profile lifecycle ----
// Dolphin occasionally rejects a fingerprint it generated itself (422 E_HARDWARE_INCOMPATIBLE,
// e.g. "Device memory value '4' is not supported") — then just draw a new one.
async function createProfile(acc, proxy) {
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
        r = await createProfileOnce(acc, proxy);
        const id = r.json && (r.json.browserProfileId || r.json.data?.id);
        if (id) return id;
        if (!/E_HARDWARE/.test(r.text)) break;
    }
    throw new InfraError(`could not create profile (HTTP ${r.code}): ${r.text.slice(0, 120)}`);
}

async function createProfileOnce(acc, proxy) {
    const fpRes = await cloud('GET', `/fingerprints/fingerprint?platform=windows&browser_type=anty&browser_version=${browserMajor || 149}&type=fingerprint&screen=1920x1080`);
    const fp = fpRes.json;
    if (!fp || !fp.userAgent) throw new InfraError(`fingerprint request failed (HTTP ${fpRes.code})`);
    const body = {
        name: PREFIX + (acc.username || acc.filename || acc.id),
        tags: ['rc-checker'],
        platform: 'windows',
        browserType: 'anty',
        mainWebsite: '',
        useragent: { mode: 'manual', value: fp.userAgent },
        webrtc: { mode: 'altered', ipAddress: null },
        canvas: { mode: 'real' },
        webgl: { mode: 'real' },
        webglInfo: { mode: 'manual', vendor: fp.webgl?.unmaskedVendor, renderer: fp.webgl?.unmaskedRenderer, webgl2Maximum: fp.webgl2Maximum },
        clientRect: { mode: 'real' },
        timezone: { mode: 'auto', value: null },
        locale: { mode: 'auto', value: null },
        geolocation: { mode: 'auto', latitude: null, longitude: null, accuracy: null },
        cpu: { mode: 'manual', value: fp.hardwareConcurrency },
        memory: { mode: 'manual', value: fp.deviceMemory },
        screen: { mode: 'real', resolution: null },
        audio: { mode: 'real' },
        mediaDevices: { mode: 'real', audioInputs: null, videoInputs: null, audioOutputs: null },
        ports: { mode: 'protect', blacklist: '3389,5900,5800,7070,6568,5938' },
        doNotTrack: false,
        // Chrome refuses to start as root without it (Dolphin runs as root on the VPS).
        args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [],
        platformVersion: fp.platformVersion,
        uaFullVersion: fp.uaFullVersion,
        appCodeName: fp.appCodeName,
        platformName: fp.platform,
        connectionDownlink: fp.connection?.downlink,
        connectionEffectiveType: fp.connection?.effectiveType,
        connectionRtt: fp.connection?.rtt,
        connectionSaveData: 0,
        cpuArchitecture: fp.cpu?.architecture,
        osVersion: fp.os?.version,
        vendorSub: fp.vendorSub,
        productSub: fp.productSub,
        vendor: fp.vendor,
        product: fp.product,
        // Throwaway profile — nothing worth uploading to Dolphin's cloud on stop.
        cloudSyncDisabled: true,
        proxy: { type: 'socks5', host: proxy.host, port: String(proxy.port), login: proxy.user, password: proxy.pass, name: proxyName(proxy) },
    };
    return cloud('POST', '/browser_profiles', body);
}

async function startProfile(id) {
    let r;
    try { r = await local('GET', `/browser_profiles/${id}/start?automation=1&headless=1`, { timeout: 120000 }); }
    catch (e) { throw new InfraError('Dolphin did not answer the start request: ' + e.message); }
    if (r.json && /session token/i.test(r.json.error || '')) {
        await ensureReady({ relogin: true });
        r = await local('GET', `/browser_profiles/${id}/start?automation=1&headless=1`, { timeout: 120000 });
    }
    const a = r.json && r.json.automation;
    if (!r.json || !r.json.success || !a) throw new InfraError('profile did not start: ' + (r.json?.error || r.text).slice(0, 140));
    return `ws://127.0.0.1:${a.port}${a.wsEndpoint}`;
}

const proxyName = (proxy) => `${PREFIX}${proxy.host}:${proxy.port}`;

// Stop → wait for Dolphin to let go → delete the profile, the proxy entry it saved, and the local data dir.
async function destroyProfile(id, proxy) {
    let proxyId = null;
    try {
        const g = await cloud('GET', `/browser_profiles/${id}`);
        const d = g.json && (g.json.data || g.json);
        proxyId = d && (d.proxyId || d.proxy?.id) || null;
    } catch {}
    try { await local('GET', `/browser_profiles/${id}/stop`, { timeout: 30000 }); } catch {}
    for (let i = 0; i < 10; i++) {
        try {
            const r = await local('GET', '/browser_profiles/running', { timeout: 10000 });
            if (!r.json || !r.json[id]) break;
        } catch { break; }
        await sleep(1000);
    }
    await cloud('DELETE', `/browser_profiles/${id}?forceDelete=1`);
    // The profile GET does not always report the proxy yet, so also look the entry up by its
    // name (proxies are single-use, so the host:port name is unique to this account).
    const ids = new Set(proxyId ? [proxyId] : []);
    if (proxy) {
        const r = await cloud('GET', `/proxy?limit=50&query=${encodeURIComponent(proxyName(proxy))}`);
        for (const p of (r.json?.data || [])) if (p.name === proxyName(proxy)) ids.add(p.id);
    }
    for (const pid of ids) await cloud('DELETE', `/proxy/${pid}`);
    try { fs.rmSync(path.join(DOLPHIN_DIR, 'browser_profiles', String(Number(id))), { recursive: true, force: true }); } catch {}
}

// Delete rc-check profiles/proxies left behind by a crash or restart. Only call when no check is running.
async function sweepLeftovers() {
    let removed = 0;
    const prof = await cloud('GET', `/browser_profiles?limit=100&query=${encodeURIComponent(PREFIX.trim())}`);
    for (const p of (prof.json?.data || [])) {
        if (!String(p.name || '').startsWith(PREFIX)) continue;
        try { await destroyProfile(p.id); removed++; } catch {}
    }
    const prx = await cloud('GET', `/proxy?limit=100&query=${encodeURIComponent(PREFIX.trim())}`);
    for (const p of (prx.json?.data || [])) {
        if (!String(p.name || '').startsWith(PREFIX)) continue;
        await cloud('DELETE', `/proxy/${p.id}`);
        removed++;
    }
    return removed;
}

// Dolphin's own debug log grows by hundreds of MB a day while checks run.
function trimDolphinLogs() {
    const dir = path.join(DOLPHIN_DIR, 'logs');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
        const full = path.join(dir, f);
        try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            if (Date.now() - st.mtimeMs > 3 * 86400000) fs.rmSync(full);
            else if (st.size > 1024 ** 3) fs.truncateSync(full, 0);
        } catch {}
    }
}

// ---- The check itself (runs inside the started profile) ----
function toCookies(acc) {
    const expires = acc.cookieExpiry || Math.floor(Date.now() / 1000) + 30 * 86400;
    return (acc.cookieHeader || '').split(/;\s*/).filter(p => p.includes('=')).map(pair => {
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        return { name, value: pair.slice(i + 1).trim(), domain: '.reddit.com', path: '/', secure: true, httpOnly: name === 'reddit_session', expires };
    });
}

// fetch() from inside the page, so the request carries the browser's own cookies, TLS and fingerprint.
function pageFetch(page, url, accept) {
    return page.evaluate(async (u, a) => {
        try {
            const r = await fetch(u, { credentials: 'include', headers: { accept: a } });
            return { code: r.status, body: await r.text() };
        } catch (e) { return { code: 0, body: '', error: String(e) }; }
    }, url, accept);
}

const SUSPENDED_RE = /(this account has been (permanently banned|suspended)[^.\n]*\.?|your account has been (permanently banned|suspended)[^.\n]*\.?|account is (temporarily )?suspended[^.\n]*\.?)/i;

async function inspect(browser, acc) {
    const page = (await browser.pages())[0] || await browser.newPage();
    page.setDefaultTimeout(45000);
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
    await page.setCookie(...toCookies(acc));

    let resp;
    try {
        resp = await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        // net::ERR_PROXY_CONNECTION_FAILED / ERR_SOCKS_CONNECTION_FAILED / timeouts — the page never arrived.
        return { status: 'proxy_error', lastChecked: nowISO(), error: 'Reddit did not load through the proxy: ' + e.message.slice(0, 110) };
    }
    const code = resp ? resp.status() : 0;
    const html = await page.content();
    const view = await page.evaluate(() => {
        const app = document.querySelector('shreddit-app');
        return {
            hasApp: !!app,
            loggedIn: !!app && app.getAttribute('user-logged-in') === 'true',
            title: document.title,
            text: ((document.body && document.body.innerText) || '').slice(0, 4000),
        };
    });

    // No Reddit app at all = an interstitial / block page, not an answer about the account.
    if (code === 403 || code === 429 || !view.hasApp) {
        return { status: 'blocked', lastChecked: nowISO(), error: `Reddit showed a block page in the browser (HTTP ${code || '?'}, "${(view.title || '').slice(0, 60)}")` };
    }
    // Page rendered for a guest (Log In button) = Reddit no longer accepts this cookie.
    if (!view.loggedIn) {
        return { status: 'login_failed', lastChecked: nowISO(), error: 'logged out in Dolphin — cookie no longer signs in' };
    }

    const out = { lastChecked: nowISO(), error: null };
    const banner = (view.text.match(SUSPENDED_RE) || [])[0] || null;

    const me = await pageFetch(page, '/api/me.json?raw_json=1', 'application/json');
    let d = null;
    try { const j = JSON.parse(me.body); d = j && j.data ? j.data : j; } catch {}
    if (d && d.name) {
        out.username = d.name;
        out.karmaLink = d.link_karma || 0;
        out.karmaComment = d.comment_karma || 0;
        out.karmaTotal = d.total_karma != null ? d.total_karma : out.karmaLink + out.karmaComment;
        if (d.created_utc) out.accountCreated = new Date(d.created_utc * 1000).toISOString();
    }

    // force_password_reset = locked for "unusual activity" (recoverable), checked before suspension.
    if (d && d.force_password_reset) out.status = 'reset_password';
    else if ((d && d.is_suspended) || banner) {
        out.status = 'suspended';
        // me.json carries the end date of a temporary suspension; none = permanent ban.
        if (d && d.is_suspended) out.error = d.suspension_expiration_utc
            ? `temporarily suspended until ${new Date(d.suspension_expiration_utc * 1000).toISOString().slice(0, 10)}`
            : 'permanently banned';
        else out.error = banner;
    }
    else out.status = 'active';
    if (!d || !d.name) out.error = [out.error, `me.json unreadable in browser (HTTP ${me.code})`].filter(Boolean).join(' · ');

    // Hidden suspension: the account menu (avatar) answers with "We had a server error" — the menu
    // partial comes back with cause="query-bad-response". Its URL id is on the page we just loaded.
    if (out.status === 'active') {
        const m = html.match(/\/svc\/shreddit\/partial\/([\w-]+)\/user-drawer-menu/);
        if (m) {
            const dr = await pageFetch(page, `/svc/shreddit/partial/${m[1]}/user-drawer-menu`, 'text/vnd.reddit.partial+html, text/html;q=0.9');
            out.drawerCheck = !/noun="logout"/.test(dr.body) ? 'unknown' : /cause="query-bad-response"/.test(dr.body) ? 'error' : 'ok';
        } else out.drawerCheck = 'unknown';
        if (out.drawerCheck === 'error') { out.status = 'hidden_suspended'; out.error = 'account menu shows "We had a server error" (me.json says active)'; }
    } else out.drawerCheck = null;

    const name = out.username || acc.username;
    if (name && ['active', 'reset_password', 'hidden_suspended'].includes(out.status)) {
        const ov = await pageFetch(page, `/user/${encodeURIComponent(name)}/overview.json?limit=1&sort=new&raw_json=1`, 'application/json');
        try {
            const c = JSON.parse(ov.body)?.data?.children?.[0]?.data;
            if (c && c.created_utc) out.lastActivity = new Date(c.created_utc * 1000).toISOString();
        } catch {}
    }
    return out;
}

// Returns the same result shape as the curl checker, or { infra: true, error } when the
// problem is on our side (Dolphin) — the caller must then leave the account's status alone.
async function checkAccount(acc, proxy) {
    if (!proxy) return { status: 'no_proxy', lastChecked: nowISO(), error: 'No proxy assigned' };
    if (acc.cookieExpiry && acc.cookieExpiry * 1000 < Date.now()) {
        return { status: 'cookie_expired', lastChecked: nowISO(), error: 'reddit_session expired' };
    }
    let id = null, browser = null;
    try {
        id = await createProfile(acc, proxy);
        const ws = await startProfile(id);
        browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 60000 });
        const res = await Promise.race([
            inspect(browser, acc),
            sleep(150000).then(() => { throw new Error('check took longer than 150 s'); }),
        ]);
        return { ...res, checkedVia: 'dolphin' };
    } catch (e) {
        return { infra: true, error: 'Dolphin: ' + (e.message || 'error').slice(0, 160) };
    } finally {
        if (browser) { try { await browser.disconnect(); } catch {} }
        if (id) { try { await destroyProfile(id, proxy); } catch {} }
    }
}

// ============================================================
//  Reddit reader — one reused Dolphin profile for public reads
//  (Add Subreddit, post/comment/about lookups). Reddit bot-walls
//  the VPS and every rotating proxy IP for plain curl, but a real
//  logged-in browser gets through. The profile is kept warm and
//  reused, then torn down after a few minutes idle.
// ============================================================
let reader = null;            // { id, browser, page, proxy }
let readerTimer = null;
let readerChain = Promise.resolve(); // serialize reads through the single page
const READER_IDLE_MS = 3 * 60 * 1000;

// Proxy spec: a fixed { host, port, user, pass }, or a pool { host, user, pass, portMin, portMax }
// from which a random exit port is drawn each time a reader is opened.
function resolveProxy(p) {
    if (!p) throw new InfraError('no proxy for the Reddit reader');
    if (p.port) return { host: p.host, port: p.port, user: p.user, pass: p.pass };
    const port = p.portMin + Math.floor(Math.random() * (p.portMax - p.portMin + 1));
    return { host: p.host, port, user: p.user, pass: p.pass };
}

function armReaderIdle() {
    if (readerTimer) clearTimeout(readerTimer);
    readerTimer = setTimeout(() => { closeReader().catch(() => {}); }, READER_IDLE_MS);
    if (readerTimer.unref) readerTimer.unref();
}

async function closeReader() {
    if (readerTimer) { clearTimeout(readerTimer); readerTimer = null; }
    const r = reader; reader = null;
    if (!r) return;
    if (r.browser) { try { await r.browser.disconnect(); } catch {} }
    if (r.id) { try { await destroyProfile(r.id, r.proxy); } catch {} }
}

async function openReader(cookieHeader, proxySpec) {
    const rdy = await ensureReady();
    if (!rdy.ok) throw new InfraError(rdy.error);
    const proxy = resolveProxy(proxySpec);
    const acc = { username: 'reader', cookieHeader };
    const id = await createProfile(acc, proxy);
    let browser;
    try {
        const ws = await startProfile(id);
        browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 60000 });
        const page = (await browser.pages())[0] || await browser.newPage();
        page.setDefaultTimeout(45000);
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
        if (cookieHeader) await page.setCookie(...toCookies(acc));
        await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        reader = { id, browser, page, proxy };
    } catch (e) {
        if (browser) { try { await browser.disconnect(); } catch {} }
        try { await destroyProfile(id, proxy); } catch {}
        throw e instanceof InfraError ? e : new InfraError(e.message);
    }
}

// Fetch a Reddit URL from inside the warm browser. Returns { code, body } like pageFetch.
// opts: { cookieHeader, proxy } — the Settings cookie and a proxy (fixed or pool spec).
function fetchReddit(url, opts = {}) {
    const run = readerChain.then(() => fetchRedditOnce(url, opts), () => fetchRedditOnce(url, opts));
    readerChain = run.catch(() => {});
    return run;
}

async function fetchRedditOnce(url, { cookieHeader, proxy } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (!reader) await openReader(cookieHeader, proxy);
            const r = await pageFetch(reader.page, url, 'application/json');
            if (r.code === 0) throw new InfraError('reader fetch failed: ' + (r.error || 'no response'));
            armReaderIdle();
            return r;
        } catch (e) {
            lastErr = e instanceof InfraError ? e : new InfraError(e.message);
            await closeReader(); // a dead page/proxy — drop it and rebuild on the next attempt
        }
    }
    throw lastErr;
}

module.exports = { checkAccount, ensureReady, status, sweepLeftovers, trimDolphinLogs, fetchReddit, closeReader, CONCURRENCY };
