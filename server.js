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
//  SEO ADVISOR — Dynamic Recommendations
// ==========================================
function generateRecommendations(ourData, competitors, ourPost) {
    const recs = [];
    if (!ourData || !competitors.length) return recs;

    const rankType = ourPost?.rankType || 'none';
    const rank = ourPost?.rank || ourPost?.redditRank || null;

    // Average competitor stats
    const avgUpvotes = Math.round(competitors.reduce((s, c) => s + c.upvotes, 0) / competitors.length);
    const avgComments = Math.round(competitors.reduce((s, c) => s + c.comments, 0) / competitors.length);
    const avgSubs = Math.round(competitors.reduce((s, c) => s + c.subredditSubscribers, 0) / competitors.length);
    const avgAge = Math.round(competitors.reduce((s, c) => s + c.ageInDays, 0) / competitors.length);
    const avgTitleLen = Math.round(competitors.reduce((s, c) => s + c.titleWords, 0) / competitors.length);
    const avgPostLen = Math.round(competitors.reduce((s, c) => s + c.postLength, 0) / competitors.length);

    // Top competitor (rank #1 among reddit)
    const top = competitors[0];

    // ---- COMMENTS ----
    if (ourData.comments < avgComments) {
        const diff = avgComments - ourData.comments;
        recs.push({
            priority: 'high',
            category: 'Comments',
            action: `Add ${diff}+ comments to match competitors`,
            detail: `Your post: ${ourData.comments} comments. Competitors above you average ${avgComments}. Top post (${top?.subreddit}): ${top?.comments} comments.`,
            metric: `${ourData.comments} → ${avgComments}+`
        });
    }

    if (top && ourData.comments < top.comments * 0.7) {
        recs.push({
            priority: 'critical',
            category: 'Comments',
            action: `#1 competitor has ${top.comments} comments vs your ${ourData.comments}`,
            detail: `Big gap with the top-ranking post. Add keyword-rich comments with variations of the target keyword. Mix short and long comments.`,
            metric: `Gap: ${top.comments - ourData.comments}`
        });
    }

    // ---- UPVOTES ----
    if (ourData.upvotes < avgUpvotes) {
        recs.push({
            priority: 'high',
            category: 'Upvotes',
            action: `Boost upvotes from ${ourData.upvotes} to ${avgUpvotes}+`,
            detail: `Competitors average ${avgUpvotes} upvotes. Top post has ${top?.upvotes}. Gradual increase looks more natural.`,
            metric: `${ourData.upvotes} → ${avgUpvotes}+`
        });
    }

    // ---- SUBREDDIT AUTHORITY ----
    if (ourData.subredditSubscribers < avgSubs) {
        const subDiff = avgSubs - ourData.subredditSubscribers;
        recs.push({
            priority: 'medium',
            category: 'Subreddit Authority',
            action: `Grow r/${ourData.subreddit} subscribers by ${subDiff.toLocaleString()}+`,
            detail: `Your subreddit: ${ourData.subredditSubscribers.toLocaleString()} subs. Competitor subreddits average ${avgSubs.toLocaleString()}. Top post's subreddit (r/${top?.subreddit}): ${top?.subredditSubscribers?.toLocaleString()} subs. Google weighs subreddit authority.`,
            metric: `${ourData.subredditSubscribers.toLocaleString()} → ${avgSubs.toLocaleString()}+`
        });
    }

    // ---- POST AGE ----
    if (ourData.ageInDays > avgAge * 1.5 && competitors.some(c => c.ageInDays < ourData.ageInDays * 0.5)) {
        recs.push({
            priority: 'medium',
            category: 'Post Freshness',
            action: 'Consider creating a fresh post',
            detail: `Your post is ${ourData.ageInDays} days old. Some competitors are newer (avg ${avgAge} days). Newer posts can overtake older ones. Keep this post but also create a fresh one targeting the same keyword.`,
            metric: `${ourData.ageInDays} days old`
        });
    }

    // ---- TITLE OPTIMIZATION ----
    if (ourData.titleWords < avgTitleLen) {
        recs.push({
            priority: 'low',
            category: 'Title',
            action: `Title could be longer — competitors average ${avgTitleLen} words, yours has ${ourData.titleWords}`,
            detail: `Longer titles capture more long-tail keywords. Top post title: "${top?.title}"`,
            metric: `${ourData.titleWords} → ${avgTitleLen} words`
        });
    }

    // ---- POST BODY LENGTH ----
    if (ourData.postLength < avgPostLen * 0.5 && avgPostLen > 200) {
        recs.push({
            priority: 'medium',
            category: 'Post Content',
            action: `Post body is shorter than competitors`,
            detail: `Your post: ${ourData.postLength} chars. Competitors average ${avgPostLen} chars. Longer posts with keyword-rich content tend to rank better.`,
            metric: `${ourData.postLength} → ${avgPostLen}+ chars`
        });
    }

    // ---- BACKLINKS ----
    // Always recommend if not on Google
    if (rankType !== 'google') {
        recs.push({
            priority: 'high',
            category: 'Backlinks',
            action: 'Increase backlink velocity to push into Google',
            detail: `You're ranking among Reddit posts but not on Google yet. Push more backlinks targeting the post URL. The post needs enough domain authority to break into Google's main results.`,
            metric: 'Not on Google yet'
        });
    }

    // ---- BEHAVIORAL ----
    if (rankType === 'reddit' && rank && rank <= 3) {
        recs.push({
            priority: 'high',
            category: 'Behavioral',
            action: 'Push CTR and behavioral signals — you\'re close to Google',
            detail: `At Reddit position #${rank}, you're almost breaking into Google. Run behavioral campaigns (search → click → dwell time) to signal Google that users prefer your post.`,
            metric: `Reddit #${rank} → Google`
        });
    }

    // ---- GOOGLE TOP POSITION MAINTENANCE ----
    if (rankType === 'google' && rank && rank <= 3) {
        recs.push({
            priority: 'low',
            category: 'Maintenance',
            action: 'Maintain position — add 2-3 fresh comments weekly',
            detail: `You're ranking Google #${rank}. Don't over-optimize. Keep natural activity: a few new comments per week, steady upvote flow, occasional backlinks. Monitor for competitors gaining on you.`,
            metric: `Google #${rank} ✓`
        });
    }

    // ---- TOP COMMENT ANALYSIS ----
    const topWithComments = competitors.filter(c => c.topComments?.length > 0);
    if (topWithComments.length > 0) {
        const topComp = topWithComments[0];
        const topComment = topComp.topComments[0];
        if (topComment) {
            const avgTopCommentLen = Math.round(
                topWithComments.reduce((s, c) => s + (c.topComments[0]?.length || 0), 0) / topWithComments.length
            );
            const avgTopCommentUpvotes = Math.round(
                topWithComments.reduce((s, c) => s + (c.topComments[0]?.upvotes || 0), 0) / topWithComments.length
            );
            const linksInTopComments = topWithComments.filter(c => c.topComments[0]?.hasLinks).length;

            recs.push({
                priority: 'high',
                category: 'Top Comment Strategy',
                action: `#1 competitor's top comment: ${avgTopCommentUpvotes} upvotes, ${avgTopCommentLen} chars`,
                detail: `Top-ranking post (r/${topComp.subreddit}) has a strong top comment by u/${topComment.author} with ${topComment.upvotes} upvotes and ${topComment.replies} replies. ${linksInTopComments > 0 ? `${linksInTopComments}/${topWithComments.length} competitors have links in their top comment.` : 'No links in top comments.'} Preview: "${topComment.body.slice(0, 150)}..."`,
                metric: `${avgTopCommentUpvotes} avg upvotes`
            });
        }
    }

    // ---- COMPETITOR-SPECIFIC INSIGHTS ----
    competitors.forEach(comp => {
        if (comp.position < (rank || 999)) {
            const insights = [];
            if (comp.comments > ourData.comments * 1.5) insights.push(`${comp.comments} comments (${Math.round(comp.comments / ourData.comments)}x yours)`);
            if (comp.upvotes > ourData.upvotes * 1.5) insights.push(`${comp.upvotes} upvotes (${Math.round(comp.upvotes / ourData.upvotes)}x yours)`);
            if (comp.subredditSubscribers > ourData.subredditSubscribers * 2) insights.push(`r/${comp.subreddit} has ${comp.subredditSubscribers.toLocaleString()} subs (${Math.round(comp.subredditSubscribers / ourData.subredditSubscribers)}x yours)`);

            if (insights.length > 0) {
                recs.push({
                    priority: 'info',
                    category: `Competitor #${comp.position}`,
                    action: `r/${comp.subreddit}: "${comp.title.slice(0, 60)}..."`,
                    detail: insights.join('. ') + '.',
                    metric: `Position #${comp.position}`
                });
            }
        }
    });

    // Sort: critical > high > medium > low > info
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    recs.sort((a, b) => (priorityOrder[a.priority] || 5) - (priorityOrder[b.priority] || 5));

    return recs;
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

    // --- Shared data storage ---
    const DATA_FILE = path.join(__dirname, 'data.json');

    if (parsed.pathname === '/api/data' && req.method === 'GET') {
        try {
            if (fs.existsSync(DATA_FILE)) {
                const data = fs.readFileSync(DATA_FILE, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(data);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    if (parsed.pathname === '/api/data' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(body, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Upvote Shop API proxy ---
    if (parsed.pathname.startsWith('/api/upvote/') && req.method === 'POST') {
        const body = await readBody(req);
        const apiToken = req.headers['x-upvote-token'];
        if (!apiToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing Upvote Shop token' }));
            return;
        }

        const endpoint = parsed.pathname.replace('/api/upvote/', '');
        const targetUrl = `https://panel.upvote.shop/api/${endpoint}`;

        console.log(`[UpvoteShop] ${endpoint}`);
        try {
            const headerArgs = `-H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json"`;
            const bodyArg = Object.keys(body).length ? `-d '${JSON.stringify(body)}'` : '';
            const data = execSync(`curl -sL ${headerArgs} ${bodyArg} --max-time 15 "${targetUrl}"`, {
                encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20000
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (parsed.pathname.startsWith('/api/upvote/') && req.method === 'GET') {
        const apiToken = req.headers['x-upvote-token'];
        if (!apiToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing token' }));
            return;
        }

        const endpoint = parsed.pathname.replace('/api/upvote/', '');
        const targetUrl = `https://panel.upvote.shop/api/${endpoint}`;

        try {
            const data = execSync(`curl -sL -H "Authorization: Bearer ${apiToken}" --max-time 15 "${targetUrl}"`, {
                encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20000
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // --- Image upload for task logs ---
    if (parsed.pathname === '/api/upload' && req.method === 'POST') {
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const buf = Buffer.concat(chunks);
                const fileName = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
                fs.writeFileSync(path.join(uploadsDir, fileName), buf);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, url: `/uploads/${fileName}` }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // --- Serve uploaded images ---
    if (parsed.pathname.startsWith('/uploads/')) {
        const filePath2 = path.join(__dirname, parsed.pathname);
        if (!filePath2.startsWith(path.join(__dirname, 'uploads'))) {
            res.writeHead(403); res.end('Forbidden'); return;
        }
        fs.readFile(filePath2, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); return; }
            const ext2 = path.extname(filePath2);
            res.writeHead(200, { 'Content-Type': MIME[ext2] || 'application/octet-stream' });
            res.end(data);
        });
        return;
    }

    // --- DataForSEO SERP check (Live mode — instant) ---
    if (parsed.pathname === '/api/df-live' && req.method === 'POST') {
        const body = await readBody(req);
        const { keyword, targetUrl, login, password } = body;
        if (!keyword || !targetUrl || !login || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing params' }));
            return;
        }

        const postId = targetUrl.match(/comments\/([A-Za-z0-9]+)/i)?.[1]?.toLowerCase();
        const auth = Buffer.from(`${login}:${password}`).toString('base64');
        console.log(`[DataForSEO] Live check "${keyword}"...`);

        try {
            // Step 1: Regular Google search
            const googleBody = JSON.stringify([{ keyword, location_code: 2840, language_code: 'en', depth: 10, device: 'desktop' }]);
            const googleRaw = execSync(`curl -sL -X POST "https://api.dataforseo.com/v3/serp/google/organic/live/advanced" -H "Authorization: Basic ${auth}" -H "Content-Type: application/json" -d '${googleBody.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', maxBuffer: 10*1024*1024, timeout: 30000 });
            const googleData = JSON.parse(googleRaw);

            if (googleData.status_code !== 20000) throw new Error(googleData.status_message || 'DataForSEO error');

            const items = googleData.tasks?.[0]?.result?.[0]?.items || [];
            const organic = items.filter(i => i.type === 'organic');

            let googleRank = null;
            const googleSerp = [];
            const googleCompetitors = [];

            organic.forEach((r, idx) => {
                const pos = r.rank_group || (idx + 1);
                const isTarget = !!(postId && r.url?.toLowerCase().includes(`comments/${postId}`));
                if (isTarget && !googleRank) googleRank = pos;
                googleSerp.push({ position: pos, url: r.url, title: r.title, snippet: r.description || '', displayedLink: r.breadcrumb || '', source: r.domain || '', favicon: '', isTarget });
                if (r.url?.includes('reddit.com/r/') && r.url?.includes('/comments/')) {
                    googleCompetitors.push({ position: pos, url: r.url, title: r.title, snippet: r.description || '' });
                }
            });

            if (googleRank) {
                console.log(`[DataForSEO] Found on Google #${googleRank}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, type: 'google', rank: googleRank, redditRank: null, totalResults: organic.length, competitors: googleCompetitors, serpResults: googleSerp, serpQuery: keyword }));
                return;
            }

            // Step 2: site:reddit.com (up to 30 results = 3 pages worth)
            console.log(`[DataForSEO] Not on Google, checking site:reddit.com...`);
            const redditBody = JSON.stringify([{ keyword: keyword + ' site:www.reddit.com', location_code: 2840, language_code: 'en', depth: 10, device: 'desktop' }]);
            const redditRaw = execSync(`curl -sL -X POST "https://api.dataforseo.com/v3/serp/google/organic/live/advanced" -H "Authorization: Basic ${auth}" -H "Content-Type: application/json" -d '${redditBody.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', maxBuffer: 10*1024*1024, timeout: 30000 });
            const redditData = JSON.parse(redditRaw);

            const redditItems = redditData.tasks?.[0]?.result?.[0]?.items || [];
            const redditOrganic = redditItems.filter(i => i.type === 'organic');
            let redditRank = null;
            const redditCompetitors = [];
            const redditSerp = [];

            redditOrganic.forEach((r, idx) => {
                const pos = r.rank_group || (idx + 1);
                const isTarget = !!(postId && r.url?.toLowerCase().includes(`comments/${postId}`));
                if (isTarget && !redditRank) redditRank = pos;
                else if (!redditRank) redditCompetitors.push({ position: pos, url: r.url, title: r.title, snippet: r.description || '' });
                redditSerp.push({ position: pos, url: r.url, title: r.title, snippet: r.description || '', displayedLink: r.breadcrumb || '', source: r.domain || '', favicon: '', isTarget });
            });

            console.log(`[DataForSEO] Reddit rank: ${redditRank || 'not found'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, type: 'reddit', rank: null, redditRank, totalResults: redditOrganic.length, competitors: redditCompetitors, serpResults: googleSerp, redditSerpResults: redditSerp, serpQuery: keyword }));
        } catch (err) {
            console.error(`[DataForSEO] Error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- DataForSEO Queue check (Standard Queue — cheap, for auto-checks) ---
    if (parsed.pathname === '/api/df-queue' && req.method === 'POST') {
        const body = await readBody(req);
        const { keyword, targetUrl, login, password } = body;
        if (!keyword || !targetUrl || !login || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing params' }));
            return;
        }

        const auth = Buffer.from(`${login}:${password}`).toString('base64');
        console.log(`[DataForSEO] Queue task "${keyword}"...`);

        try {
            // Post both tasks: regular + site:reddit.com
            const tasks = [
                { keyword, location_code: 2840, language_code: 'en', depth: 10, tag: `google|${targetUrl}` },
                { keyword: keyword + ' site:www.reddit.com', location_code: 2840, language_code: 'en', depth: 10, tag: `reddit|${targetUrl}` }
            ];
            const raw = execSync(`curl -sL -X POST "https://api.dataforseo.com/v3/serp/google/organic/task_post" -H "Authorization: Basic ${auth}" -H "Content-Type: application/json" -d '${JSON.stringify(tasks).replace(/'/g, "'\\''")}'`, { encoding: 'utf8', maxBuffer: 5*1024*1024, timeout: 20000 });
            const data = JSON.parse(raw);

            const taskIds = (data.tasks || []).map(t => t.id).filter(Boolean);
            console.log(`[DataForSEO] Queued ${taskIds.length} tasks: ${taskIds.join(', ')}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, taskIds }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- DataForSEO get queue results ---
    if (parsed.pathname === '/api/df-result' && req.method === 'POST') {
        const body = await readBody(req);
        const { taskId, login, password } = body;
        if (!taskId || !login || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing params' }));
            return;
        }

        const auth = Buffer.from(`${login}:${password}`).toString('base64');
        try {
            const raw = execSync(`curl -sL "https://api.dataforseo.com/v3/serp/google/organic/task_get/regular/${taskId}" -H "Authorization: Basic ${auth}"`, { encoding: 'utf8', maxBuffer: 10*1024*1024, timeout: 20000 });
            const data = JSON.parse(raw);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Telegram notification endpoint ---
    if (parsed.pathname === '/api/telegram' && req.method === 'POST') {
        const body = await readBody(req);
        const { message } = body;
        const DATA_FILE2 = path.join(__dirname, 'data.json');
        try {
            const d = JSON.parse(fs.readFileSync(DATA_FILE2, 'utf8'));
            await sendTelegramAlert(d, message || 'No message');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

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

            // Collect all Reddit posts from Google results (competitors)
            const googleCompetitors = organic
                .filter(r => r.link?.includes('reddit.com/r/') && r.link?.includes('/comments/'))
                .map(r => ({ position: r.position, url: r.link, title: r.title, snippet: r.snippet || '' }));

            // Full SERP results for preview
            const googleSerp = organic.map(r => ({
                position: r.position, url: r.link, title: r.title,
                snippet: r.snippet || '', displayedLink: r.displayed_link || '',
                source: r.source || '', favicon: r.favicon || '',
                isTarget: !!(postId && r.link?.toLowerCase().includes(`comments/${postId}`))
            }));

            if (googleRank) {
                console.log(`[SERP] Found on Google #${googleRank}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true, type: 'google', rank: googleRank, redditRank: null,
                    totalResults: organic.length, competitors: googleCompetitors,
                    serpResults: googleSerp, serpQuery: keyword
                }));
                return;
            }

            // Step 2: site:reddit.com search (up to 3 pages)
            console.log(`[SERP] Not on Google page 1, checking site:reddit.com (up to 3 pages)...`);
            const siteQuery = keyword + ' site:www.reddit.com';
            const redditUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(siteQuery)}&gl=us&hl=en&location=United+States&google_domain=google.com&num=10&api_key=${apiKey}`;
            const redditResult = JSON.parse(httpsRequest(redditUrl).data);
            if (redditResult.error) throw new Error(redditResult.error);

            const allRedditOrganic = (redditResult.organic_results || []).map((r, i) => ({ ...r, position: i + 1 }));
            let redditRank = null;
            const redditCompetitors = [];

            for (const r of allRedditOrganic) {
                const isOurs = postId && r.link?.toLowerCase().includes(`comments/${postId}`);
                if (isOurs && !redditRank) {
                    redditRank = r.position;
                } else if (!redditRank) {
                    redditCompetitors.push({ position: r.position, url: r.link, title: r.title, snippet: r.snippet || '' });
                }
            }

            // Full Reddit SERP results for preview
            const redditSerp = allRedditOrganic.map(r => ({
                position: r.position, url: r.link, title: r.title,
                snippet: r.snippet || '', displayedLink: r.displayed_link || '',
                source: r.source || '', favicon: r.favicon || '',
                isTarget: !!(postId && r.link?.toLowerCase().includes(`comments/${postId}`))
            }));

            console.log(`[SERP] Reddit rank: ${redditRank || 'not found'}, ${redditCompetitors.length} competitors, ${allRedditOrganic.length} total results`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true, type: 'reddit', rank: null, redditRank,
                totalResults: allRedditOrganic.length, competitors: redditCompetitors,
                serpResults: googleSerp, redditSerpResults: redditSerp,
                serpQuery: keyword
            }));
        } catch (err) {
            console.error(`[SERP] Error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Analyze competitors endpoint ---
    if (parsed.pathname === '/api/analyze-competitors' && req.method === 'POST') {
        const body = await readBody(req);
        const { competitors, ourPost } = body;

        if (!competitors?.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, analyses: [] }));
            return;
        }

        console.log(`[Analyze] Analyzing ${competitors.length} competitors...`);

        const analyses = [];
        for (const comp of competitors.slice(0, 5)) { // max 5 competitors
            try {
                // Extract post ID from URL
                const compPostId = comp.url.match(/comments\/([A-Za-z0-9]+)/i)?.[1];
                if (!compPostId) continue;

                // Fetch Reddit post data with comments
                const postData = JSON.parse(httpsRequest(`https://www.reddit.com/comments/${compPostId}.json?limit=5`).data);
                const post = postData?.[0]?.data?.children?.[0]?.data;
                if (!post) continue;

                // Fetch subreddit data
                const subData = JSON.parse(httpsRequest(`https://www.reddit.com/r/${post.subreddit}/about.json`).data);
                const sub = subData?.data;

                // Extract top comments for analysis
                const topComments = (postData?.[1]?.data?.children || [])
                    .filter(c => c.kind === 't1')
                    .slice(0, 3)
                    .map(c => ({
                        author: c.data.author,
                        body: (c.data.body || '').slice(0, 300),
                        upvotes: c.data.ups || c.data.score || 0,
                        replies: c.data.replies?.data?.children?.length || 0,
                        hasLinks: (c.data.body || '').includes('http'),
                        length: (c.data.body || '').length,
                    }));

                analyses.push({
                    position: comp.position,
                    url: comp.url,
                    title: post.title,
                    subreddit: post.subreddit,
                    subredditSubscribers: sub?.subscribers || 0,
                    upvotes: post.ups || post.score || 0,
                    comments: post.num_comments || 0,
                    author: post.author,
                    createdUtc: post.created_utc,
                    ageInDays: Math.floor((Date.now() / 1000 - post.created_utc) / 86400),
                    postLength: (post.selftext || '').length,
                    hasLinks: (post.selftext || '').includes('http'),
                    flair: post.link_flair_text || '',
                    titleLength: post.title.length,
                    titleWords: post.title.split(/\s+/).length,
                    topComments,
                });
            } catch (e) {
                console.log(`[Analyze] Failed for ${comp.url}: ${e.message}`);
            }
        }

        // Fetch our post data for comparison
        let ourData = null;
        if (ourPost?.url) {
            try {
                const ourPostId = ourPost.url.match(/comments\/([A-Za-z0-9]+)/i)?.[1];
                if (ourPostId) {
                    const pd = JSON.parse(httpsRequest(`https://www.reddit.com/comments/${ourPostId}.json`).data);
                    const p = pd?.[0]?.data?.children?.[0]?.data;
                    const sd = JSON.parse(httpsRequest(`https://www.reddit.com/r/${p.subreddit}/about.json`).data);
                    ourData = {
                        title: p.title,
                        subreddit: p.subreddit,
                        subredditSubscribers: sd?.data?.subscribers || 0,
                        upvotes: p.ups || p.score || 0,
                        comments: p.num_comments || 0,
                        ageInDays: Math.floor((Date.now() / 1000 - p.created_utc) / 86400),
                        postLength: (p.selftext || '').length,
                        titleLength: p.title.length,
                        titleWords: p.title.split(/\s+/).length,
                    };
                }
            } catch {}
        }

        // Generate recommendations
        const recommendations = generateRecommendations(ourData, analyses, ourPost);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, analyses, ourData, recommendations }));
        return;
    }

    // --- Fetch top comments for selection ---
    if (parsed.pathname === '/api/top-comments' && req.method === 'POST') {
        const body = await readBody(req);
        const { postUrl } = body;

        const postId = postUrl?.match(/comments\/([A-Za-z0-9]+)/i)?.[1];
        if (!postId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid post URL' }));
            return;
        }

        console.log(`[Comments] Fetching top comments for ${postId}...`);

        try {
            const data = JSON.parse(httpsRequest(`https://www.reddit.com/comments/${postId}.json?limit=10`).data);
            const comments = (data?.[1]?.data?.children || [])
                .filter(c => c.kind === 't1')
                .slice(0, 7)
                .map((c, i) => ({
                    id: c.data.id,
                    author: c.data.author,
                    body: (c.data.body || '').slice(0, 200),
                    upvotes: c.data.ups || c.data.score || 0,
                    replies: c.data.replies?.data?.children?.length || 0,
                    position: i + 1,
                    isStickied: c.data.stickied || false,
                }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, comments }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // --- Money Comment position check ---
    if (parsed.pathname === '/api/check-comment' && req.method === 'POST') {
        const body = await readBody(req);
        const { postUrl, commentId } = body;

        if (!postUrl || !commentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing postUrl or commentId' }));
            return;
        }

        const postId = postUrl.match(/comments\/([A-Za-z0-9]+)/i)?.[1];
        if (!postId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid post URL' }));
            return;
        }

        console.log(`[Comment] Checking position of ${commentId} in post ${postId}...`);

        try {
            // Fetch post with comments sorted by best (default Reddit sort)
            const data = JSON.parse(httpsRequest(`https://www.reddit.com/comments/${postId}.json?limit=25`).data);
            const comments = data?.[1]?.data?.children || [];

            let position = null;
            let totalTopLevel = 0;
            let commentData = null;

            for (let i = 0; i < comments.length; i++) {
                const c = comments[i];
                if (c.kind !== 't1') continue; // skip "more" items
                totalTopLevel++;
                if (c.data.id === commentId || c.data.name === `t1_${commentId}`) {
                    position = totalTopLevel;
                    commentData = {
                        author: c.data.author,
                        body: (c.data.body || '').slice(0, 500),
                        upvotes: c.data.ups || c.data.score || 0,
                        awards: c.data.total_awards_received || 0,
                        replies: c.data.replies?.data?.children?.length || 0,
                        createdUtc: c.data.created_utc,
                        isStickied: c.data.stickied || false,
                    };
                }
            }

            console.log(`[Comment] ${commentId}: position ${position}/${totalTopLevel}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true, position, totalTopLevel, commentData,
                postId, commentId
            }));
        } catch (err) {
            console.error(`[Comment] Error: ${err.message}`);
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
  ║   Auto rank check: every hour (DataForSEO)  ║
  ║   Press Ctrl+C to stop                       ║
  ╚══════════════════════════════════════════════╝
`);
    // Start hourly auto-check after 2 minutes, then every hour
    setTimeout(autoRankCheck, 2 * 60 * 1000);
    setInterval(autoRankCheck, 60 * 60 * 1000);
});

// ==========================================
//  HOURLY AUTO RANK CHECK (Standard Queue)
// ==========================================
async function autoRankCheck() {
    const DATA_FILE = path.join(__dirname, 'data.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return; }

    const login = data.keys?.lk_df_login;
    const password = data.keys?.lk_df_password;
    if (!login || !password) {
        console.log('[AutoRank] No DataForSEO credentials, skipping');
        return;
    }

    const subs = data.subreddits || [];
    const allKeywords = [];

    subs.forEach(sub => {
        (sub.moneyPosts || []).forEach(mp => {
            if (!mp.url || !mp.googleKeywords?.length) return; // skip posts without URL
            mp.googleKeywords.forEach((kw, kwIdx) => {
                if (!kw.keyword?.trim()) return; // skip empty keywords
                allKeywords.push({ subId: sub.id, subName: sub.name, mpId: mp.id, mpUrl: mp.url, kwIdx, keyword: kw.keyword.trim() });
            });
        });
    });

    if (!allKeywords.length) { console.log('[AutoRank] No keywords to check'); return; }
    console.log(`[AutoRank] Checking ${allKeywords.length} keywords via Standard Queue...`);

    const auth = Buffer.from(`${login}:${password}`).toString('base64');
    const pendingTasks = [];

    // Queue all tasks (2 per keyword: google + reddit)
    for (const kw of allKeywords) {
        try {
            const tasks = [
                { keyword: kw.keyword, location_code: 2840, language_code: 'en', depth: 10, tag: `google|${kw.mpUrl}|${kw.subId}|${kw.mpId}|${kw.kwIdx}` },
                { keyword: kw.keyword + ' site:www.reddit.com', location_code: 2840, language_code: 'en', depth: 10, tag: `reddit|${kw.mpUrl}|${kw.subId}|${kw.mpId}|${kw.kwIdx}` }
            ];
            const raw = execSync(`curl -sL -X POST "https://api.dataforseo.com/v3/serp/google/organic/task_post" -H "Authorization: Basic ${auth}" -H "Content-Type: application/json" -d '${JSON.stringify(tasks).replace(/'/g, "'\\''")}'`, { encoding: 'utf8', maxBuffer: 5*1024*1024, timeout: 20000 });
            const result = JSON.parse(raw);
            (result.tasks || []).forEach(t => {
                if (t.id) pendingTasks.push({ id: t.id, tag: t.data?.tag || '', keyword: kw.keyword });
            });
        } catch (e) {
            console.log(`[AutoRank] Queue failed for "${kw.keyword}": ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[AutoRank] Queued ${pendingTasks.length} tasks, waiting 6 minutes for results...`);

    // Wait for Standard Queue to process (avg 5 min)
    await new Promise(r => setTimeout(r, 6 * 60 * 1000));

    // Fetch results and update data.json
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return; }

    let updated = 0;
    for (const task of pendingTasks) {
        try {
            const raw = execSync(`curl -sL "https://api.dataforseo.com/v3/serp/google/organic/task_get/regular/${task.id}" -H "Authorization: Basic ${auth}"`, { encoding: 'utf8', maxBuffer: 10*1024*1024, timeout: 20000 });
            const result = JSON.parse(raw);
            const items = result.tasks?.[0]?.result?.[0]?.items?.filter(i => i.type === 'organic') || [];
            if (!items.length) continue;

            const tagParts = task.tag.split('|');
            const searchType = tagParts[0]; // google or reddit
            const targetUrl = tagParts[1];
            const subId = Number(tagParts[2]);
            const mpId = Number(tagParts[3]);
            const kwIdx = Number(tagParts[4]);
            const postId = targetUrl?.match(/comments\/([A-Za-z0-9]+)/i)?.[1]?.toLowerCase();

            const sub = data.subreddits?.find(s => s.id === subId);
            const mp = sub?.moneyPosts?.find(p => p.id === mpId);
            const kw = mp?.googleKeywords?.[kwIdx];
            if (!kw) continue;

            let rank = null;
            for (const item of items) {
                if (postId && item.url?.toLowerCase().includes(`comments/${postId}`)) {
                    rank = item.rank_group || items.indexOf(item) + 1;
                    break;
                }
            }

            if (searchType === 'google' && rank) {
                const prevType = kw.rankType;
                if (!kw.history) kw.history = [];
                if (kw.updatedAt) kw.history.push({ rankType: kw.rankType || 'none', avgRank: kw.avgRank, date: kw.updatedAt });
                kw.rankType = 'google';
                kw.avgRank = rank;
                kw.rank = rank;
                kw.updatedAt = new Date().toISOString();
                kw._googleFoundThisCycle = true;
                updated++;
                console.log(`[AutoRank] "${kw.keyword}": Google #${rank}`);

                // Telegram: only notify ONCE when first appearing on Google
                if (prevType !== 'google') {
                    await sendTelegramAlert(data,
                        `🟢 *GOOGLE RANKING*\n\n` +
                        `Keyword: *${kw.keyword}*\n` +
                        `Position: *#${rank}* on Google\n` +
                        `Subreddit: r/${sub.name}\n` +
                        `Post: ${mp.title?.slice(0, 60)}\n` +
                        `🔗 ${targetUrl}`
                    );
                }

            } else if (searchType === 'google' && !rank) {
                // Mark that Google was lost — will send alert after Reddit result
                if (kw.rankType === 'google') {
                    kw._lostGoogle = kw.avgRank;
                }

            } else if (searchType === 'reddit' && !kw._googleFoundThisCycle) {
                if (!kw.history) kw.history = [];
                if (kw.updatedAt) kw.history.push({ rankType: kw.rankType || 'none', avgRank: kw.avgRank, date: kw.updatedAt });
                kw.rankType = rank ? 'reddit' : 'none';
                kw.avgRank = rank;
                kw.rank = rank;
                kw.updatedAt = new Date().toISOString();
                updated++;
                console.log(`[AutoRank] "${kw.keyword}": ${rank ? 'Reddit #' + rank : '10+'}`);

                // Send Google lost alert now that we know Reddit position
                if (kw._lostGoogle) {
                    await sendTelegramAlert(data,
                        `🔴 *GOOGLE POSITION LOST*\n\n` +
                        `Keyword: *${kw.keyword}*\n` +
                        `Was: Google #${kw._lostGoogle}\n` +
                        `Now: ${rank ? 'Reddit #' + rank : 'Not in top 10'}\n` +
                        `Subreddit: r/${sub.name}\n` +
                        `Post: ${mp.title?.slice(0, 60)}\n` +
                        `🔗 ${targetUrl}`
                    );
                    delete kw._lostGoogle;
                }
            }
        } catch (e) {
            console.log(`[AutoRank] Result fetch failed for ${task.id}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 100));
    }

    // Clean up temp flags
    (data.subreddits || []).forEach(sub => {
        (sub.moneyPosts || []).forEach(mp => {
            (mp.googleKeywords || []).forEach(kw => { delete kw._googleFoundThisCycle; delete kw._lostGoogle; });
        });
    });

    if (updated) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[AutoRank] Updated ${updated} keyword positions`);
    } else {
        console.log('[AutoRank] No updates');
    }
}

// ==========================================
//  TELEGRAM NOTIFICATIONS
// ==========================================
// Telegram bot polling for commands
let tgOffset = 0;

async function pollTelegramCommands() {
    const DATA_FILE = path.join(__dirname, 'data.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return; }
    const botToken = data.keys?.lk_telegram_bot;
    const chatId = data.keys?.lk_telegram_chat;
    if (!botToken || !chatId) return;

    try {
        const raw = execSync(`curl -sL "https://api.telegram.org/bot${botToken}/getUpdates?offset=${tgOffset}&timeout=1&limit=10"`, { encoding: 'utf8', timeout: 15000 });
        const result = JSON.parse(raw);
        if (!result.ok || !result.result?.length) return;

        for (const update of result.result) {
            tgOffset = update.update_id + 1;
            const msg = update.message;
            if (!msg?.text) continue;

            const text = msg.text.toLowerCase().trim();

            // Respond to /check or /status
            if (text === '/check' || text === '/status' || text.includes('check')) {
                // Gather all keyword positions
                const subs = data.subreddits || [];
                const lines = [];

                subs.forEach(sub => {
                    const kwLines = [];
                    (sub.moneyPosts || []).forEach(mp => {
                        (mp.googleKeywords || []).forEach(kw => {
                            if (!kw.keyword) return;
                            const pos = kw.rankType === 'google' ? `🟢 Google #${kw.avgRank}`
                                : kw.rankType === 'reddit' && kw.avgRank ? `🟠 Reddit #${kw.avgRank}`
                                : '⚪ 10+';
                            const time = kw.updatedAt ? new Date(kw.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
                            kwLines.push(`  ${pos}  *${kw.keyword}*  ${time}`);
                        });

                        // Money comment
                        const mc = mp.moneyComment;
                        if (mc?.commentId) {
                            const mcPos = mc.position === 1 ? '🟢 #1' : mc.position ? `🔴 #${mc.position}` : '⚪ ?';
                            kwLines.push(`  💬 MC ${mcPos}`);
                        }
                    });

                    if (kwLines.length) {
                        lines.push(`\n📌 *r/${sub.name}*`);
                        lines.push(...kwLines);
                    }
                });

                const reply = lines.length
                    ? `📊 *Current Positions*\n${lines.join('\n')}`
                    : '📊 No keywords being tracked yet.';

                await sendTelegramAlert(data, reply);
            }

            // Check specific keyword: /kw buy tiktok views
            if (text.startsWith('/kw ')) {
                const searchKw = msg.text.slice(4).trim();
                if (!searchKw) continue;

                // Find this keyword in tracked data
                let found = false;
                const subs = data.subreddits || [];
                subs.forEach(sub => {
                    (sub.moneyPosts || []).forEach(mp => {
                        (mp.googleKeywords || []).forEach(kw => {
                            if (kw.keyword?.toLowerCase() === searchKw.toLowerCase()) {
                                found = true;
                                const pos = kw.rankType === 'google' ? `🟢 Google #${kw.avgRank}`
                                    : kw.rankType === 'reddit' && kw.avgRank ? `🟠 Reddit #${kw.avgRank}`
                                    : '⚪ Not in top 10';
                                const time = kw.updatedAt ? new Date(kw.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'never';
                                sendTelegramAlert(data,
                                    `🔍 *Keyword Check*\n\n` +
                                    `Keyword: *${kw.keyword}*\n` +
                                    `Position: ${pos}\n` +
                                    `Last checked: ${time}\n` +
                                    `Subreddit: r/${sub.name}\n` +
                                    `🔗 ${mp.url || ''}`
                                );
                            }
                        });
                    });
                });

                if (!found) {
                    await sendTelegramAlert(data, `🔍 Keyword "*${searchKw}*" is not being tracked.`);
                }
            }
        }
    } catch (e) {
        // Silent — polling errors are normal
    }
}

// Poll every 10 seconds
setInterval(pollTelegramCommands, 10000);
setTimeout(pollTelegramCommands, 5000);

async function sendTelegramAlert(data, message) {
    const botToken = data.keys?.lk_telegram_bot;
    const chatId = data.keys?.lk_telegram_chat;
    if (!botToken || !chatId) return;

    try {
        const text = `🔔 *LK Media Tracker*\n\n${message}`;
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
        const tmpFile = `/tmp/tg_${Date.now()}.json`;
        fs.writeFileSync(tmpFile, payload);
        execSync(`curl -sL -X POST "${url}" -H "Content-Type: application/json" -d @${tmpFile}`, { timeout: 10000 });
        fs.unlinkSync(tmpFile);
        console.log(`[Telegram] Sent: ${message.slice(0, 60)}`);
    } catch (e) {
        console.log(`[Telegram] Failed: ${e.message}`);
    }
}
