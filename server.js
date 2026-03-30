// ===== LK Media Group — Reddit Tracker Server =====
// Run: node server.js | Open: http://localhost:3002

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const proxyChain = require('proxy-chain');

const PORT = process.env.PORT || 3002;

const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// --- Proxy config: rotating SOCKS5 ---
const PROXY_BASE = {
    host: 'res.proxy-seller.com',
    login: '8b6cffecb2f54b48',
    password: 'cDUj1XausfevIVti',
    basePort: 10000,
    maxPortOffset: 1000
};

function getRandomProxyPort() {
    return PROXY_BASE.basePort + Math.floor(Math.random() * PROXY_BASE.maxPortOffset);
}

// --- HTTPS request via curl (reliable) ---
function httpsRequest(targetUrl, headers = {}) {
    const headerArgs = Object.entries({ 'User-Agent': 'LKMediaTracker/1.0', 'Accept': 'application/json', ...headers })
        .map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
    try {
        const data = execSync(`curl -sL ${headerArgs} --max-time 15 "${targetUrl}"`, {
            encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 20000
        });
        return { status: 200, data };
    } catch (e) {
        return { status: 502, data: JSON.stringify({ error: e.message }) };
    }
}

// --- HTTP GET (local APIs) ---
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = http.request({
            hostname: parsed.hostname, port: parsed.port,
            path: parsed.pathname + parsed.search, method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

// --- Read POST body ---
function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
}

// ==========================================
//  CHROMIUM RANK CHECKER (no Dolphin needed)
// ==========================================
let nextDebugPort = 9300;

async function launchFreshChromium(proxyPort) {
    const debugPort = nextDebugPort++;
    if (nextDebugPort > 9399) nextDebugPort = 9300;

    // Fresh profile dir — deleted after use
    const userDataDir = `/tmp/rank-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Create authenticated proxy URL and anonymize it for Chromium
    const originalProxy = `socks5://${PROXY_BASE.login}:${PROXY_BASE.password}@${PROXY_BASE.host}:${proxyPort}`;
    const localProxy = await proxyChain.anonymizeProxy(originalProxy);
    console.log(`[Chrome] Proxy: port ${proxyPort} → ${localProxy}`);

    const args = [
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        `--proxy-server=${localProxy}`,
        '--no-first-run', '--disable-default-apps',
        '--disable-features=Translate,OptimizationGuideModelDownloading',
        '--disable-background-networking',
        '--lang=en-US',
        'about:blank'
    ];

    console.log(`[Chrome] Launching on port ${debugPort} with proxy port ${proxyPort}...`);

    const proc = spawn('chromium', args, {
        env: { ...process.env, DISPLAY: ':99' },
        detached: true,
        stdio: 'ignore'
    });
    proc.unref();

    // Wait for Chrome to start
    await new Promise(r => setTimeout(r, 3000));

    // Get WebSocket URL
    let wsEndpoint;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const versionInfo = await httpGet(`http://127.0.0.1:${debugPort}/json/version`);
            wsEndpoint = versionInfo.webSocketDebuggerUrl;
            if (wsEndpoint) break;
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!wsEndpoint) {
        // Cleanup
        try { process.kill(-proc.pid); } catch {}
        execSync(`rm -rf "${userDataDir}" 2>/dev/null; exit 0`, { shell: '/bin/bash' });
        throw new Error('Chrome failed to start');
    }

    return { wsEndpoint, proc, userDataDir, debugPort, proxyPort, localProxy };
}

function killChromium(instance) {
    if (!instance) return;
    try { process.kill(-instance.proc.pid); } catch {}
    try { execSync(`pkill -f "rank-check.*${instance.debugPort}" 2>/dev/null; exit 0`, { shell: '/bin/bash', timeout: 3000 }); } catch {}
    // Close proxy forwarder
    if (instance.localProxy) proxyChain.closeAnonymizedProxy(instance.localProxy, true).catch(() => {});
    // Delete fresh profile
    try { execSync(`rm -rf "${instance.userDataDir}" 2>/dev/null; exit 0`, { shell: '/bin/bash', timeout: 3000 }); } catch {}
}

// --- Google scraping helpers ---
async function scrapeGoogleResults(page) {
    return page.evaluate(() => {
        const links = [];
        const seen = new Set();

        // Method 1: Standard selectors
        document.querySelectorAll('#search .g, #rso .g, [data-sokoban-container] .g').forEach(el => {
            const a = el.querySelector('a[href]');
            if (a && a.href && !a.href.includes('google.com') && !seen.has(a.href)) {
                seen.add(a.href);
                links.push({ url: a.href, title: el.querySelector('h3')?.textContent || '' });
            }
        });

        // Method 2: If standard selectors found nothing, get ALL external links with headings
        if (links.length === 0) {
            document.querySelectorAll('a[href]').forEach(a => {
                if (!a.href || a.href.includes('google.com') || a.href.includes('accounts.google') ||
                    a.href.includes('support.google') || a.href.startsWith('javascript:') ||
                    seen.has(a.href)) return;

                // Must be a real result — has a heading nearby or is in main content
                const parent = a.closest('[data-hveid], [data-ved], .g, [jscontroller]');
                const hasHeading = a.querySelector('h3, h2') || a.closest('[data-hveid]')?.querySelector('h3, h2');
                const isInSearch = a.closest('#search, #rso, #main, [role="main"]');

                if ((parent || hasHeading) && isInSearch) {
                    seen.add(a.href);
                    const title = a.querySelector('h3, h2')?.textContent ||
                                  a.closest('[data-hveid]')?.querySelector('h3, h2')?.textContent ||
                                  a.textContent?.slice(0, 80) || '';
                    links.push({ url: a.href, title });
                }
            });
        }

        // Method 3: Last resort — any link to real websites in search area
        if (links.length === 0) {
            document.querySelectorAll('#search a[href], #rso a[href], [role="main"] a[href]').forEach(a => {
                if (!a.href || seen.has(a.href) || a.href.includes('google.com') ||
                    !a.href.startsWith('http')) return;
                seen.add(a.href);
                links.push({ url: a.href, title: a.textContent?.slice(0, 80) || '' });
            });
        }

        return links;
    });
}

async function detectCaptcha(page) {
    return page.evaluate(() => {
        const body = document.body?.innerText || '';
        return body.includes('unusual traffic') || body.includes('not a robot') ||
               body.includes('captcha') || !!document.querySelector('#captcha-form, .g-recaptcha');
    });
}

function findPostInResults(results, targetUrl) {
    const postIdMatch = targetUrl.match(/comments\/([A-Za-z0-9]+)/i);
    const postId = postIdMatch ? postIdMatch[1].toLowerCase() : null;
    for (let i = 0; i < results.length; i++) {
        const clean = results[i].url.replace(/https?:\/\/(www\.)?/, '').replace(/[\/$?].*$/, '').toLowerCase();
        if (postId && results[i].url.toLowerCase().includes(`comments/${postId}`)) return i + 1;
    }
    return null;
}

// --- Main rank check function ---
async function checkGoogleRank(proxyPort, keyword, targetUrl) {
    let instance, browser;

    try {
        instance = await launchFreshChromium(proxyPort);
        browser = await puppeteer.connect({ browserWSEndpoint: instance.wsEndpoint, defaultViewport: null });
        const page = await browser.newPage();
        await page.setDefaultTimeout(30000);

        // ===== STEP 1: Regular Google search =====
        console.log(`[Rank] Step 1: Google "${keyword}" (proxy port ${proxyPort})...`);
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(keyword)}&num=10&hl=en`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2500));

        if (await detectCaptcha(page)) {
            console.log('[Rank] CAPTCHA on step 1 — skipping');
            return { type: 'captcha', rank: null, redditRank: null, error: 'CAPTCHA' };
        }

        await page.waitForSelector('#search, #rso', { timeout: 10000 }).catch(() => {});
        const googleResults = await scrapeGoogleResults(page);
        const googleRank = findPostInResults(googleResults, targetUrl);

        if (googleRank) {
            console.log(`[Rank] FOUND on Google #${googleRank}!`);
            return { type: 'google', rank: googleRank, redditRank: null, totalResults: googleResults.length };
        }

        console.log(`[Rank] Not on Google page 1. Checking site:reddit.com...`);
        await new Promise(r => setTimeout(r, 1500));

        // ===== STEP 2: site:reddit.com search (pages 1-2) =====
        const siteQuery = `${keyword} site:www.reddit.com`;
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(siteQuery)}&num=20&hl=en`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2500));

        if (await detectCaptcha(page)) {
            console.log('[Rank] CAPTCHA on step 2 — skipping');
            return { type: 'captcha', rank: null, redditRank: null, error: 'CAPTCHA' };
        }

        await page.waitForSelector('#search, #rso', { timeout: 10000 }).catch(() => {});
        let redditResults = await scrapeGoogleResults(page);
        let redditRank = findPostInResults(redditResults, targetUrl);

        // Try page 2 if not found
        if (!redditRank) {
            try {
                await page.goto(`https://www.google.com/search?q=${encodeURIComponent(siteQuery)}&num=10&start=20&hl=en`, { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 2500));
                if (!(await detectCaptcha(page))) {
                    await page.waitForSelector('#search, #rso', { timeout: 10000 }).catch(() => {});
                    const page2 = await scrapeGoogleResults(page);
                    const p2Rank = findPostInResults(page2, targetUrl);
                    if (p2Rank) redditRank = redditResults.length + p2Rank;
                    redditResults = [...redditResults, ...page2];
                }
            } catch {}
        }

        if (redditRank) console.log(`[Rank] Found among Reddit posts #${redditRank}`);
        else console.log(`[Rank] Not found in ${redditResults.length} Reddit results`);

        return { type: 'reddit', rank: null, redditRank, totalResults: redditResults.length };

    } finally {
        if (browser) await browser.disconnect().catch(() => {});
        killChromium(instance);
        // Wait for cleanup
        await new Promise(r => setTimeout(r, 1000));
    }
}

// ==========================================
//  SERVER
// ==========================================
const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- Proxy endpoint (Reddit, Ahrefs) ---
    if (parsed.pathname === '/api/proxy') {
        const targetUrl = parsed.searchParams.get('url');
        if (!targetUrl) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing url' })); return; }
        try {
            const tp = new URL(targetUrl);
            if (!['www.reddit.com', 'reddit.com', 'api.ahrefs.com'].includes(tp.hostname)) {
                res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Domain not allowed' })); return;
            }
        } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid URL' })); return; }

        const proxyHeaders = {};
        if (req.headers.authorization) proxyHeaders['Authorization'] = req.headers.authorization;
        try {
            const result = httpsRequest(targetUrl, proxyHeaders);
            if (targetUrl.includes('ahrefs.com')) console.log(`[Ahrefs] → ${result.data.slice(0, 200)}`);
            res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(result.data);
        } catch (err) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
        return;
    }

    // --- SERP API rank check (clean, no browser) ---
    if (parsed.pathname === '/api/serp-check' && req.method === 'POST') {
        const body = await readBody(req);
        const { keyword, targetUrl, apiKey } = body;

        if (!keyword || !targetUrl || !apiKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing keyword, targetUrl, or apiKey' }));
            return;
        }

        console.log(`[SERP] Checking "${keyword}"...`);

        try {
            // Step 1: Regular Google search
            const googleUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(keyword)}&gl=us&hl=en&location=United+States&google_domain=google.com&num=10&api_key=${apiKey}`;
            const googleResult = JSON.parse(httpsRequest(googleUrl).data);

            if (googleResult.error) throw new Error(googleResult.error);

            const organic = googleResult.organic_results || [];
            const postId = targetUrl.match(/comments\/([A-Za-z0-9]+)/i)?.[1]?.toLowerCase();

            let googleRank = null;
            for (const r of organic) {
                if (postId && r.link?.toLowerCase().includes(`comments/${postId}`)) {
                    googleRank = r.position;
                    break;
                }
            }

            if (googleRank) {
                console.log(`[SERP] Found on Google #${googleRank}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, type: 'google', rank: googleRank, redditRank: null, totalResults: organic.length }));
                return;
            }

            // Step 2: site:reddit.com search
            console.log(`[SERP] Not on Google page 1, checking site:reddit.com...`);
            const redditUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(keyword + ' site:www.reddit.com')}&gl=us&hl=en&location=United+States&google_domain=google.com&num=20&api_key=${apiKey}`;
            const redditResult = JSON.parse(httpsRequest(redditUrl).data);

            if (redditResult.error) throw new Error(redditResult.error);

            const redditOrganic = redditResult.organic_results || [];
            let redditRank = null;
            for (const r of redditOrganic) {
                if (postId && r.link?.toLowerCase().includes(`comments/${postId}`)) {
                    redditRank = r.position;
                    break;
                }
            }

            console.log(`[SERP] Reddit rank: ${redditRank || 'not found'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, type: 'reddit', rank: null, redditRank, totalResults: redditOrganic.length }));
        } catch (err) {
            console.error(`[SERP] Error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Chromium rank check endpoint (fallback) ---
    if (parsed.pathname === '/api/check-rank' && req.method === 'POST') {
        const body = await readBody(req);
        const { keyword, targetUrl, proxyIndex } = body;

        if (!keyword || !targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing keyword or targetUrl' }));
            return;
        }

        // Each check gets a fresh random proxy port
        const proxyPort = proxyIndex != null
            ? PROXY_BASE.basePort + (proxyIndex * 333) + Math.floor(Math.random() * 100)
            : getRandomProxyPort();

        console.log(`[Rank Check] "${keyword}" | Proxy port ${proxyPort}`);

        try {
            const result = await checkGoogleRank(proxyPort, keyword, targetUrl);
            console.log(`[Rank Check] Result: ${result.type} ${result.rank || result.redditRank || 'not found'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
            console.error(`[Rank Check] Error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Static files ---
    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    filePath = path.join(__dirname, filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' }); res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║   LK Media Group — Reddit Tracker           ║
  ║   → http://localhost:${PORT}                    ║
  ║                                              ║
  ║   Rank checker: Chromium + SOCKS5 proxy      ║
  ║   3 parallel checks with fresh profiles      ║
  ║                                              ║
  ║   Press Ctrl+C to stop                       ║
  ╚══════════════════════════════════════════════╝
`);
});
