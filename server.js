// ===== LK Media Group — Local Proxy + Dolphin Rank Checker =====
// Run: node server.js
// Open: http://localhost:3000

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 3002;
const DOLPHIN_API = 'http://localhost:3001/v1.0';

const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// --- HTTPS request helper ---
const { execSync } = require('child_process');

function httpsRequest(targetUrl, headers = {}) {
    // Use curl for reliable HTTP requests (handles redirects, TLS, user-agent properly)
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

// --- HTTP request helper (for Dolphin local API) ---
function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const opts = {
            hostname: parsed.hostname, port: parsed.port,
            path: parsed.pathname + parsed.search, method: 'GET',
            headers: { 'Content-Type': 'application/json', ...headers }
        };
        const req = http.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ raw: data }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

// --- Read POST body ---
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

// ==========================================
//  DOLPHIN + GOOGLE RANK CHECKER
// ==========================================
// Cloud API for listing profiles, Local API for start/stop
const DOLPHIN_CLOUD = 'https://dolphin-anty-api.com';

function dolphinCloudGet(path, token) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'dolphin-anty-api.com', port: 443,
            path, method: 'GET',
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error(`Non-JSON response: ${data.slice(0, 100)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

async function getDolphinProfiles(token) {
    // Use CLOUD API to list profiles (works with JWT token directly)
    const data = await dolphinCloudGet('/browser_profiles?limit=50&page=1', token);
    if (data.data) return data.data;
    if (data.error) throw new Error(data.error);
    throw new Error('Unexpected response from Dolphin API');
}

async function startDolphinProfile(profileId, token) {
    // Use LOCAL API to start profile for automation
    const data = await httpGet(`${DOLPHIN_API}/browser_profiles/${profileId}/start?automation=1`, {
        'Authorization': `Bearer ${token}`
    });
    if (!data.success) throw new Error(data.error || 'Failed to start profile. Is Dolphin Anty running?');
    return data.automation;
}

async function stopDolphinProfile(profileId, token) {
    await httpGet(`${DOLPHIN_API}/browser_profiles/${profileId}/stop`, {
        'Authorization': `Bearer ${token}`
    }).catch(() => {});
}

// --- Scrape Google results from current page ---
async function scrapeGoogleResults(page) {
    return page.evaluate(() => {
        const links = [];
        const containers = document.querySelectorAll('#search .g, #rso .g, #rso [data-sokoban-container] .g, #rso div[data-hveid] > div > div > div > a');
        const seen = new Set();
        containers.forEach(el => {
            const a = el.tagName === 'A' ? el : el.querySelector('a[href]');
            if (!a || !a.href || a.href.includes('google.com') || seen.has(a.href)) return;
            seen.add(a.href);
            const h3 = el.tagName === 'A' ? el.querySelector('h3') : el.querySelector('h3');
            links.push({ url: a.href, title: h3?.textContent || '' });
        });
        return links;
    });
}

// --- Check if Google is showing a captcha ---
async function detectCaptcha(page) {
    return page.evaluate(() => {
        const body = document.body?.innerText || '';
        return body.includes('unusual traffic') ||
               body.includes('not a robot') ||
               body.includes('captcha') ||
               !!document.querySelector('#captcha-form, .g-recaptcha, [data-sitekey]');
    });
}

// --- Wait for captcha to be solved (manual) ---
async function waitForCaptchaSolve(page, maxWait = 120000) {
    console.log('[Rank] CAPTCHA detected — waiting for manual solve (up to 2 min)...');
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 3000));
        const still = await detectCaptcha(page);
        if (!still) {
            console.log('[Rank] CAPTCHA solved!');
            await new Promise(r => setTimeout(r, 1500));
            return true;
        }
    }
    console.log('[Rank] CAPTCHA timeout — skipping this profile');
    return false;
}

// --- Match our post URL in results ---
function findPostInResults(results, targetUrl) {
    // Extract the Reddit post ID from target URL for reliable matching
    const postIdMatch = targetUrl.match(/comments\/([A-Za-z0-9]+)/i);
    const postId = postIdMatch ? postIdMatch[1].toLowerCase() : null;
    const cleanTarget = targetUrl.replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '').replace(/\?.*$/, '').toLowerCase();

    for (let i = 0; i < results.length; i++) {
        const cleanResult = results[i].url.replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '').replace(/\?.*$/, '').toLowerCase();
        // Match by post ID (most reliable) or by URL substring
        if (postId && cleanResult.includes(`comments/${postId}`)) return i + 1;
        if (cleanResult.includes(cleanTarget) || cleanTarget.includes(cleanResult)) return i + 1;
    }
    return null;
}

async function checkGoogleRank(profileId, token, keyword, targetUrl) {
    let browser;

    try {
        // Start Dolphin profile
        const automation = await startDolphinProfile(profileId, token);
        console.log('[Dolphin] Automation response:', JSON.stringify(automation));

        // Build WebSocket URL — Dolphin returns port + wsEndpoint (just the path)
        const port = automation.port;
        let wsEndpoint = automation.wsEndpoint || '';

        // If wsEndpoint is just a path (no ws://), prepend host
        if (wsEndpoint && !wsEndpoint.startsWith('ws')) {
            wsEndpoint = `ws://127.0.0.1:${port}${wsEndpoint}`;
        } else if (!wsEndpoint && port) {
            // No wsEndpoint given — try to discover it from Chrome DevTools
            try {
                const versionInfo = await httpGet(`http://127.0.0.1:${port}/json/version`);
                wsEndpoint = versionInfo.webSocketDebuggerUrl || '';
                if (wsEndpoint && !wsEndpoint.startsWith('ws')) {
                    wsEndpoint = `ws://127.0.0.1:${port}${wsEndpoint}`;
                }
                console.log('[Dolphin] Discovered wsEndpoint:', wsEndpoint);
            } catch (e) {
                wsEndpoint = `ws://127.0.0.1:${port}`;
            }
        }

        if (!wsEndpoint) throw new Error('Could not determine browser WebSocket URL');
        console.log('[Dolphin] Connecting to:', wsEndpoint);

        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
        const page = await browser.newPage();
        await page.setDefaultTimeout(30000);

        // ========== STEP 1: Regular Google search (first page) ==========
        console.log(`[Rank] Step 1: Searching Google for "${keyword}"...`);
        const googleUrl1 = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&num=10&hl=en`;
        await page.goto(googleUrl1, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2500));

        // Check for captcha
        if (await detectCaptcha(page)) {
            const solved = await waitForCaptchaSolve(page);
            if (!solved) {
                await page.close();
                return { type: 'captcha', rank: null, redditRank: null, error: 'CAPTCHA not solved' };
            }
        }

        await page.waitForSelector('#search, #rso', { timeout: 10000 }).catch(() => {});
        const googleResults = await scrapeGoogleResults(page);
        const googleRank = findPostInResults(googleResults, targetUrl);

        if (googleRank) {
            console.log(`[Rank] Found on Google page 1 at #${googleRank}!`);
            await page.close();
            return {
                type: 'google',
                rank: googleRank,
                redditRank: null,
                totalResults: googleResults.length,
                results: googleResults.slice(0, 10)
            };
        }

        console.log(`[Rank] Not found on Google page 1. Moving to site:reddit.com search...`);
        await new Promise(r => setTimeout(r, 1500));

        // ========== STEP 2: site:reddit.com search (pages 1-2) ==========
        const searchQuery2 = `${keyword} site:www.reddit.com`;
        const googleUrl2 = `https://www.google.com/search?q=${encodeURIComponent(searchQuery2)}&num=20&hl=en`;
        await page.goto(googleUrl2, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2500));

        // Check for captcha again
        if (await detectCaptcha(page)) {
            const solved = await waitForCaptchaSolve(page);
            if (!solved) {
                await page.close();
                return { type: 'captcha', rank: null, redditRank: null, error: 'CAPTCHA not solved' };
            }
        }

        await page.waitForSelector('#search, #rso', { timeout: 10000 }).catch(() => {});
        let redditResults = await scrapeGoogleResults(page);
        let redditRank = findPostInResults(redditResults, targetUrl);

        // If not found on page 1, try page 2
        if (!redditRank) {
            console.log('[Rank] Not on page 1 of site:reddit.com, checking page 2...');
            try {
                // Click "Next" or go to start=20
                const page2Url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery2)}&num=10&start=20&hl=en`;
                await page.goto(page2Url, { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 2500));

                if (await detectCaptcha(page)) {
                    const solved = await waitForCaptchaSolve(page);
                    if (!solved) {
                        await page.close();
                        return { type: 'captcha', rank: null, redditRank: null, error: 'CAPTCHA on page 2' };
                    }
                }

                await page.waitForSelector('#search, #rso', { timeout: 10000 }).catch(() => {});
                const page2Results = await scrapeGoogleResults(page);
                // Offset positions by page 1 count
                const page2Rank = findPostInResults(page2Results, targetUrl);
                if (page2Rank) {
                    redditRank = redditResults.length + page2Rank;
                }
                redditResults = [...redditResults, ...page2Results];
            } catch (e) {
                console.log('[Rank] Could not load page 2:', e.message);
            }
        }

        await page.close();

        if (redditRank) {
            console.log(`[Rank] Found among Reddit posts at #${redditRank}`);
        } else {
            console.log(`[Rank] Not found in Reddit results (checked ${redditResults.length} results)`);
        }

        return {
            type: 'reddit',
            rank: null,
            redditRank,
            totalResults: redditResults.length,
            results: redditResults.slice(0, 10)
        };

    } finally {
        if (browser) await browser.disconnect().catch(() => {});
        if (profileId && token) {
            await stopDolphinProfile(profileId, token);
            // Wait for profile to fully close before next one starts
            await new Promise(r => setTimeout(r, 2000));
        }
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

    // --- Proxy endpoint ---
    if (parsed.pathname === '/api/proxy') {
        const targetUrl = parsed.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        try {
            const targetParsed = new URL(targetUrl);
            const allowed = ['www.reddit.com', 'reddit.com', 'old.reddit.com', 'api.ahrefs.com'];
            if (!allowed.includes(targetParsed.hostname)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Domain not allowed' }));
                return;
            }
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid URL' }));
            return;
        }

        const proxyHeaders = {};
        if (req.headers.authorization) proxyHeaders['Authorization'] = req.headers.authorization;

        try {
            const result = await httpsRequest(targetUrl, proxyHeaders);
            // Log Ahrefs responses for debugging
            if (targetUrl.includes('ahrefs.com')) {
                console.log(`[Ahrefs] ${targetUrl.split('?')[0].split('/').pop()} → ${result.data.slice(0, 300)}`);
            }
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(result.data);
        } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Dolphin: list profiles ---
    if (parsed.pathname === '/api/dolphin/profiles') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!token) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No Dolphin token provided' }));
            return;
        }
        try {
            const profiles = await getDolphinProfiles(token);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, profiles }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Dolphin: check Google rank ---
    if (parsed.pathname === '/api/dolphin/check-rank' && req.method === 'POST') {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const body = await readBody(req);
        const { profileId, keyword, targetUrl } = body;

        if (!token || !profileId || !keyword || !targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing: token, profileId, keyword, targetUrl' }));
            return;
        }

        console.log(`[Rank Check] Keyword: "${keyword}" | Profile: ${profileId}`);

        try {
            const result = await checkGoogleRank(profileId, token, keyword, targetUrl);
            console.log(`[Rank Check] Result: ${result.rank ? '#' + result.rank : 'Not found'} / ${result.totalResults} results`);
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
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║   LK Media Group — Reddit Tracker           ║
  ║   → http://localhost:${PORT}  (local)           ║
  ║   → http://0.0.0.0:${PORT}   (network)          ║
  ║                                              ║
  ║   Deploy on a VPS with Dolphin Anty          ║
  ║   to check ranks without opening browsers    ║
  ║   on your machine.                           ║
  ║                                              ║
  ║   Press Ctrl+C to stop                       ║
  ╚══════════════════════════════════════════════╝
`);
});
