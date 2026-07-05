// ============================================================
//  Reddit Checker — checks a pool of cookie-based Reddit
//  accounts (banned? karma? last activity?), each through its
//  own dedicated SOCKS5 proxy (sticky 1:1). All Reddit traffic
//  goes out the account's proxy — never the server's own IP.
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const STORE = path.join(__dirname, 'reddit_checker.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CONCURRENCY = 12;

const nowISO = () => new Date().toISOString();

// ---- Store (server-side only; cookies/proxy creds never sent to the browser) ----
function load() {
    try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
    catch { return { accounts: [], proxies: [], nextId: 1 }; }
}
function save(s) { fs.writeFileSync(STORE, JSON.stringify(s), 'utf8'); }

// ---- Parsers ----
// Netscape/Chrome cookies.txt (tab-separated) + "Simple Checker" header hints.
function parseCookieFile(text) {
    const cookies = {};
    const expiry = {};
    for (const line of text.split(/\r?\n/)) {
        const f = line.split('\t');
        if (f.length >= 7 && /reddit\.com/i.test(f[0])) {
            cookies[f[5]] = f[6];
            expiry[f[5]] = parseInt(f[4], 10) || 0;
        }
    }
    if (!cookies['reddit_session']) return null;
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const grab = (re) => (text.match(re) || [])[1] || null;
    return {
        redditSession: cookies['reddit_session'],
        cookieHeader,
        cookieExpiry: expiry['reddit_session'] || 0,
        claimed: {
            username: grab(/Username:\s*([A-Za-z0-9_\-]+)/i),
            suspended: /Suspended:\s*true/i.test(text),
            year: grab(/Year:\s*(\d{4})/i),
            karma: grab(/Karma:\s*(\d+)/i),
            moderator: /Moderator:\s*true/i.test(text),
        },
    };
}

// Accepts both common SOCKS5 layouts:
//   host:port:user:pass   and   user:pass@host:port   (proxy-seller style),
// with an optional socks5:// scheme. The side whose first token looks like a
// hostname/IP is treated as host:port; the other side is the credentials.
function looksLikeServer(s) {
    const h = (s.split(':')[0] || '');
    return (/[a-zA-Z]/.test(h) && h.includes('.')) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}
function parseProxyLine(raw) {
    let line = (raw || '').trim().replace(/^\w+:\/\//, '');
    if (!line) return null;
    let host, port, user = '', pass = '';
    if (line.includes('@')) {
        const at = line.split('@');
        const left = at[0], right = at.slice(1).join('@');
        let server, cred;
        if (looksLikeServer(right)) { server = right; cred = left; }
        else if (looksLikeServer(left)) { server = left; cred = right; }
        else { server = right; cred = left; } // default: user:pass@host:port
        [host, port] = server.split(':');
        const cp = cred.split(':'); user = cp[0] || ''; pass = cp[1] || '';
    } else {
        const parts = line.split(':');
        host = parts[0]; port = parts[1]; user = parts[2] || ''; pass = parts[3] || '';
    }
    if (!host || !port) return null;
    return { host, port, user, pass };
}
function parseProxies(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        const p = parseProxyLine(raw);
        if (p) out.push(p);
    }
    return out;
}

// ---- Proxy binding (1:1, sticky) ----
function nextFreeProxy(s) { return s.proxies.find(p => !p.boundAccountId); }
function bindFreeProxies(s) {
    let bound = 0;
    for (const a of s.accounts) {
        if (a.proxyId) continue;
        const p = nextFreeProxy(s);
        if (!p) break;
        p.boundAccountId = a.id;
        a.proxyId = p.id;
        bound++;
    }
    return bound;
}
// Swap an account off a dead proxy onto a fresh unused one. The dead proxy is burned
// (single-use — never handed to another account). Returns true if a free proxy was assigned.
function swapToFreeProxy(s, acc) {
    const free = s.proxies.find(p => !p.boundAccountId);
    if (!free) return false;
    const oldId = acc.proxyId;
    if (oldId != null) s.proxies = s.proxies.filter(p => p.id !== oldId); // burn the dead one
    free.boundAccountId = acc.id;
    acc.proxyId = free.id;
    acc.proxyFailCount = 0;
    return true;
}

// ---- HTTP via curl through a specific SOCKS5 proxy + cookie jar ----
function runCurl(proxy, cookieHeader, url) {
    return new Promise((resolve) => {
        const args = ['-sL', '--socks5-hostname', `${proxy.host}:${proxy.port}`];
        if (proxy.user) args.push('-U', `${proxy.user}:${proxy.pass}`);
        args.push('-H', `Cookie: ${cookieHeader}`, '-H', `User-Agent: ${UA}`,
            '-H', 'Accept: application/json', '--max-time', '15', url);
        execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err && !stdout) return resolve({ ok: false, error: (err.message || 'curl error').slice(0, 140) });
            resolve({ ok: true, body: stdout || '' });
        });
    });
}

// ---- Check one account (through its proxy) ----
async function checkAccount(acc, s) {
    const proxy = s.proxies.find(p => p.id === acc.proxyId);
    if (!proxy) return { status: 'no_proxy', lastChecked: nowISO(), error: 'No proxy assigned' };

    // Pre-flag cookies that are already past expiry — no need to burn a request.
    if (acc.cookieExpiry && acc.cookieExpiry * 1000 < Date.now()) {
        return { status: 'cookie_expired', lastChecked: nowISO(), error: 'reddit_session expired' };
    }

    // Retry the (dedicated) proxy a few times — residential IPs blip; one timeout isn't a failure.
    let me = { ok: false, error: 'proxy/network error' };
    for (let attempt = 0; attempt < 4; attempt++) {
        me = await runCurl(proxy, acc.cookieHeader, 'https://www.reddit.com/api/me.json');
        if (me.ok) break;
        await new Promise(r => setTimeout(r, 800)); // let a blipping proxy recover
    }
    if (!me.ok) return { status: 'proxy_error', lastChecked: nowISO(), error: me.error || 'proxy/network error' };
    const body = (me.body || '').trim();
    if (!body || body[0] === '<') return { status: 'proxy_error', lastChecked: nowISO(), error: 'blocked/HTML (proxy IP flagged)' };

    let j;
    try { j = JSON.parse(body); } catch { return { status: 'proxy_error', lastChecked: nowISO(), error: 'non-JSON response' }; }
    const d = (j && j.data) ? j.data : j;
    // Cookie present but Reddit won't authenticate it → can't log in via cookies.
    if (!d || !d.name) return { status: 'login_failed', lastChecked: nowISO(), error: 'cookie rejected — cannot log in' };

    const username = d.name;
    const karmaLink = d.link_karma || 0;
    const karmaComment = d.comment_karma || 0;
    const karmaTotal = (d.total_karma != null) ? d.total_karma : (karmaLink + karmaComment);
    const accountCreated = d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null;

    // force_password_reset = Reddit locked the account for "unusual activity". It is NOT a
    // ban — it's still reachable in a browser and recoverable via a password reset, so it
    // gets its own status (checked before is_suspended, since a lock sets both true).
    let status;
    if (d.force_password_reset) status = 'reset_password';
    else if (d.is_suspended) status = 'suspended';
    else status = 'active';

    let lastActivity = null;
    if (status === 'active' || status === 'reset_password') {
        const ov = await runCurl(proxy, acc.cookieHeader,
            `https://www.reddit.com/user/${encodeURIComponent(username)}/overview.json?limit=1&sort=new&raw_json=1`);
        if (ov.ok) {
            try {
                const c = JSON.parse(ov.body)?.data?.children?.[0]?.data;
                if (c && c.created_utc) lastActivity = new Date(c.created_utc * 1000).toISOString();
            } catch { /* leave null */ }
        }
    }
    return { status, username, karmaTotal, karmaLink, karmaComment, accountCreated, lastActivity, lastChecked: nowISO(), error: null };
}

// ---- Background check job ----
let job = { running: false, total: 0, done: 0 };
function startCheck(ids) {
    if (job.running) return job;
    const s = load();
    const targets = (ids === 'all' || !Array.isArray(ids))
        ? s.accounts
        : s.accounts.filter(a => ids.includes(a.id));
    job = { running: true, total: targets.length, done: 0, startedAt: Date.now() };
    (async () => {
        // Reset-password timeline: was it already locked when we first reached it, or did it
        // lock only after our checks? (firstStatus === 'reset_password' = locked on first contact.)
        const applyResult = (acc, res) => {
            if (!acc.firstCheckedAt) { acc.firstCheckedAt = res.lastChecked; acc.firstStatus = res.status; }
            if (res.status === 'reset_password' && !acc.resetDetectedAt) {
                acc.resetDetectedAt = res.lastChecked;
                acc.resetFirstStatus = acc.firstStatus;
            }
            Object.assign(acc, res);
            acc.proxyFailCount = res.status === 'proxy_error' ? (acc.proxyFailCount || 0) + 1 : 0;
        };
        const runPool = async (list, countsToJob) => {
            let i = 0;
            const worker = async () => {
                while (i < list.length) {
                    const acc = list[i++];
                    let res;
                    try { res = await checkAccount(acc, s); }
                    catch (e) { res = { status: 'proxy_error', lastChecked: nowISO(), error: (e.message || 'error').slice(0, 120) }; }
                    applyResult(acc, res);
                    if (countsToJob) job.done++;
                    if (job.done % 10 === 0) save(s);
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length || 1) }, worker));
            save(s);
        };

        await runPool(targets, true);
        // Proxy errors are transient (residential IP blips) — re-check the stuck ones a few
        // more times. If a proxy is still dead after 2 checks, swap the account onto a fresh
        // free proxy (burning the dead one) and try that instead.
        for (let round = 0; round < 4; round++) {
            const stuck = targets.filter(a => a.status === 'proxy_error');
            if (!stuck.length) break;
            let swapped = 0;
            for (const acc of stuck) {
                if ((acc.proxyFailCount || 0) >= 2 && swapToFreeProxy(s, acc)) swapped++;
            }
            if (swapped) { save(s); job.swappedProxies = (job.swappedProxies || 0) + swapped; }
            await new Promise(r => setTimeout(r, 3000));
            await runPool(stuck, false);
        }
        job.running = false;
    })();
    return job;
}

// ---- Imports ----
function importProxies(text) {
    const s = load();
    const parsed = parseProxies(text);
    const seen = new Set(s.proxies.map(p => `${p.host}:${p.port}:${p.user}`));
    let added = 0;
    for (const p of parsed) {
        const key = `${p.host}:${p.port}:${p.user}`;
        if (seen.has(key)) continue;
        seen.add(key);
        s.proxies.push({ id: s.nextId++, ...p, boundAccountId: null });
        added++;
    }
    const bound = bindFreeProxies(s);
    save(s);
    return { added, boundToWaitingAccounts: bound, totalProxies: s.proxies.length, freeProxies: s.proxies.filter(p => !p.boundAccountId).length };
}

function walkTxt(dir, acc = []) {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walkTxt(full, acc);
        else if (/\.txt$/i.test(name)) acc.push(full);
    }
    return acc;
}

async function importAccountsZip(buf, batch) {
    const s = load();
    batch = (batch || '').trim() || new Date().toISOString().slice(0, 16).replace('T', ' ');
    const tmp = path.join(os.tmpdir(), 'rc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const zip = tmp + '.zip';
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(zip, buf);
    try { execFileSync('unzip', ['-o', '-qq', zip, '-d', tmp], { stdio: 'ignore' }); }
    catch (e) { return { error: 'unzip failed: ' + e.message }; }

    const seen = new Set(s.accounts.map(a => a.redditSession));
    let added = 0, dup = 0, fail = 0;
    for (const file of walkTxt(tmp)) {
        let parsed;
        try { parsed = parseCookieFile(fs.readFileSync(file, 'utf8')); } catch { parsed = null; }
        if (!parsed) { fail++; continue; }
        if (seen.has(parsed.redditSession)) { dup++; continue; }
        seen.add(parsed.redditSession);
        s.accounts.push({
            id: s.nextId++,
            filename: path.basename(file),
            username: parsed.claimed.username || null,
            redditSession: parsed.redditSession,
            cookieHeader: parsed.cookieHeader,
            cookieExpiry: parsed.cookieExpiry,
            claimed: parsed.claimed,
            proxyId: null,
            status: 'unchecked',
            karmaTotal: null, karmaLink: null, karmaComment: null,
            lastActivity: null, accountCreated: null,
            lastChecked: null, error: null,
            batch, saved: false,
            addedAt: nowISO(),
        });
        added++;
    }
    const bound = bindFreeProxies(s);
    save(s);
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); } catch {}
    const noProxy = s.accounts.filter(a => !a.proxyId).length;
    return { added, duplicatesSkipped: dup, parseFailed: fail, boundToProxy: bound, accountsWithoutProxy: noProxy, totalAccounts: s.accounts.length };
}

// ---- Public (redacted) views ----
function listPublic() {
    const s = load();
    const pById = new Map(s.proxies.map(p => [p.id, p]));
    const accounts = s.accounts.map(a => {
        const p = pById.get(a.proxyId);
        return {
            id: a.id, username: a.username, filename: a.filename, status: a.status,
            karmaTotal: a.karmaTotal, karmaLink: a.karmaLink, karmaComment: a.karmaComment,
            lastActivity: a.lastActivity, accountCreated: a.accountCreated,
            cookieExpiry: a.cookieExpiry, claimed: a.claimed,
            proxy: p ? `${p.host}:${p.port}` : null,
            lastChecked: a.lastChecked, error: a.error,
            resetDetectedAt: a.resetDetectedAt || null, resetFirstStatus: a.resetFirstStatus || null,
            firstCheckedAt: a.firstCheckedAt || null, firstStatus: a.firstStatus || null,
            batch: a.batch || '', saved: !!a.saved,
        };
    });
    const batches = [...new Set(s.accounts.map(a => a.batch || '').filter(Boolean))].sort().reverse();
    return {
        accounts, job, batches,
        counts: {
            accounts: s.accounts.length,
            saved: s.accounts.filter(a => a.saved).length,
            pool: s.accounts.filter(a => !a.saved).length,
            proxies: s.proxies.length,
            boundProxies: s.proxies.filter(p => p.boundAccountId).length,
            freeProxies: s.proxies.filter(p => !p.boundAccountId).length,
            withoutProxy: s.accounts.filter(a => !a.proxyId).length,
        },
    };
}

function saveAccounts(ids, saved) {
    const s = load();
    const set = new Set(ids);
    for (const a of s.accounts) if (set.has(a.id)) a.saved = !!saved;
    save(s);
    return { updated: ids.length, saved: !!saved };
}

function deleteAccounts(ids) {
    const s = load();
    const del = new Set(ids);
    // Proxies are SINGLE-USE — one IP per account, forever. When an account is deleted its
    // proxy is burned, so delete the proxy too. Reusing an IP on another account gets it banned.
    const before = s.proxies.length;
    s.proxies = s.proxies.filter(p => !del.has(p.boundAccountId));
    const proxiesDeleted = before - s.proxies.length;
    s.accounts = s.accounts.filter(a => !del.has(a.id));
    save(s);
    return { deleted: ids.length, proxiesDeleted, totalAccounts: s.accounts.length, totalProxies: s.proxies.length };
}

function moveFolder(ids, folder) {
    const s = load();
    const set = new Set(ids);
    folder = (folder || '').trim();
    for (const a of s.accounts) if (set.has(a.id)) a.batch = folder;
    save(s);
    return { updated: ids.length, folder };
}

function clearAll(what) {
    const s = load();
    // Removing accounts also burns their single-use proxies; only never-used (free) proxies remain.
    if (what === 'accounts' || what === 'all') { s.proxies = s.proxies.filter(p => !p.boundAccountId); s.accounts = []; }
    if (what === 'proxies' || what === 'all') { s.proxies = []; s.accounts.forEach(a => a.proxyId = null); }
    save(s);
    return { ok: true };
}

function exportCsv() {
    const s = load();
    const pById = new Map(s.proxies.map(p => [p.id, p]));
    const rows = [['username', 'status', 'karma_total', 'karma_link', 'karma_comment', 'last_activity', 'account_created', 'proxy', 'last_checked', 'error']];
    for (const a of s.accounts) {
        const p = pById.get(a.proxyId);
        rows.push([a.username || '', a.status || '', a.karmaTotal ?? '', a.karmaLink ?? '', a.karmaComment ?? '',
            a.lastActivity || '', a.accountCreated || '', p ? `${p.host}:${p.port}` : '', a.lastChecked || '', (a.error || '').replace(/[\r\n,]/g, ' ')]);
    }
    return rows.map(r => r.join(',')).join('\n');
}

// ---- Reveal secrets (own data) for one-click copy ----
function revealValue(id, what) {
    const s = load();
    const a = s.accounts.find(x => x.id === id);
    if (!a) return null;
    if (what === 'cookie') return a.cookieHeader || '';
    if (what === 'proxy') {
        const p = s.proxies.find(x => x.id === a.proxyId);
        return p ? `${p.host}:${p.port}:${p.user}:${p.pass}` : '';
    }
    return null;
}

// ---- Dolphin Anty export (XLSX matching their import template) ----
// Cookie column = JSON array of cookie objects; Proxy = login:password@host:port.
function dolphinCookies(cookieHeader) {
    return (cookieHeader || '').split('; ').filter(Boolean).map(pair => {
        const i = pair.indexOf('=');
        return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: '.reddit.com', path: '/', httpOnly: true, secure: true };
    });
}
function exportDolphin({ ids, status } = {}) {
    const XLSX = require('xlsx');
    const s = load();
    let accts = s.accounts;
    if (ids && ids.length) accts = accts.filter(a => ids.includes(a.id));
    if (status) accts = accts.filter(a => (a.status || 'unchecked') === status);
    const pById = new Map(s.proxies.map(p => [p.id, p]));
    const rows = [['Profile name', 'Cookie', 'Proxy type', 'Proxy', 'User Agent', 'Notes']];
    for (const a of accts) {
        const p = pById.get(a.proxyId);
        rows.push([
            a.username || a.filename || ('reddit_' + a.id),
            JSON.stringify(dolphinCookies(a.cookieHeader)),
            p ? 'socks5' : '',
            p ? `${p.user}:${p.pass}@${p.host}:${p.port}` : '',
            UA,
            [a.status, a.karmaTotal != null ? `karma ${a.karmaTotal}` : '', a.lastActivity ? `last ${a.lastActivity.slice(0, 10)}` : ''].filter(Boolean).join(' | '),
        ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Accounts');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- HTTP router (mounted at /api/rc/*) ----
function readJson(req) {
    return new Promise((r) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
}
function readRaw(req) {
    return new Promise((r) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => r(Buffer.concat(ch))); });
}

async function handle(req, res, parsed) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
        const p = parsed.pathname;
        if (p === '/api/rc/list' && req.method === 'GET') return send(200, listPublic());
        if (p === '/api/rc/check-status' && req.method === 'GET') return send(200, job);
        if (p === '/api/rc/import-proxies' && req.method === 'POST') return send(200, importProxies((await readJson(req)).text || ''));
        if (p === '/api/rc/import-accounts' && req.method === 'POST') return send(200, await importAccountsZip(await readRaw(req), parsed.searchParams.get('batch')));
        if (p === '/api/rc/check' && req.method === 'POST') return send(200, startCheck((await readJson(req)).ids || 'all'));
        if (p === '/api/rc/delete' && req.method === 'POST') return send(200, deleteAccounts((await readJson(req)).ids || []));
        if (p === '/api/rc/save' && req.method === 'POST') { const b = await readJson(req); return send(200, saveAccounts(b.ids || [], b.saved)); }
        if (p === '/api/rc/move-folder' && req.method === 'POST') { const b = await readJson(req); return send(200, moveFolder(b.ids || [], b.folder)); }
        if (p === '/api/rc/clear' && req.method === 'POST') return send(200, clearAll((await readJson(req)).what || 'all'));
        if (p === '/api/rc/export' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=reddit_accounts.csv' });
            return res.end(exportCsv());
        }
        if (p === '/api/rc/reveal' && req.method === 'GET') {
            const v = revealValue(Number(parsed.searchParams.get('id')), parsed.searchParams.get('what'));
            return v == null ? send(404, { error: 'not found' }) : send(200, { value: v });
        }
        if (p === '/api/rc/export-dolphin' && req.method === 'GET') {
            const idsP = parsed.searchParams.get('ids');
            const buf = exportDolphin({ ids: idsP ? idsP.split(',').map(Number) : null, status: parsed.searchParams.get('status') });
            res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename=dolphin_import.xlsx' });
            return res.end(buf);
        }
        send(404, { error: 'unknown rc route' });
    } catch (e) { send(500, { error: e.message }); }
}

module.exports = { handle, parseCookieFile, parseProxies };
