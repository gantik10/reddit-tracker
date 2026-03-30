// ===== LK Media Group — Reddit Tracker (v3) =====

// --- Storage (synced to server for team sharing) ---
const S = {
    get(k) { try { return JSON.parse(localStorage.getItem('lk_' + k)) || []; } catch { return []; } },
    set(k, v) {
        localStorage.setItem('lk_' + k, JSON.stringify(v));
        S._pushToServer();
    },
    nextId(k) { const items = this.get(k); return items.length ? Math.max(...items.map(i => i.id)) + 1 : 1; },

    // Debounced push to server (avoids hammering on rapid saves)
    _pushTimer: null,
    _pushToServer() {
        if (S._pushTimer) clearTimeout(S._pushTimer);
        S._pushTimer = setTimeout(() => {
            const data = {};
            ['subreddits', 'team'].forEach(k => {
                try { data[k] = JSON.parse(localStorage.getItem('lk_' + k)) || []; } catch { data[k] = []; }
            });
            fetch(`${window.location.origin}/api/data`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).catch(err => console.log('[Sync] Push failed:', err.message));
        }, 500);
    },

    // Pull from server on load
    async pullFromServer() {
        try {
            const res = await fetch(`${window.location.origin}/api/data`);
            const data = await res.json();

            // If server has data, use it
            if (data.subreddits?.length) {
                localStorage.setItem('lk_subreddits', JSON.stringify(data.subreddits));
                if (data.team) localStorage.setItem('lk_team', JSON.stringify(data.team));
                console.log('[Sync] Pulled from server:', data.subreddits.length, 'subreddits');
            } else {
                // Server empty — push local data up (one-time migration)
                const localSubs = S.get('subreddits');
                if (localSubs.length) {
                    console.log('[Sync] Server empty, pushing local data up...');
                    S._pushToServer();
                }
            }
            return true;
        } catch (err) {
            console.log('[Sync] Pull failed, using local data:', err.message);
            return false;
        }
    }
};

let currentSubId = null;
let fetchedSubData = null; // temp store for fetched subreddit data
let fetchedPostData = null; // temp store for fetched post data

// --- Helpers ---
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtNum(n) {
    if (n == null || n === '' || n === 0) return '—';
    n = Number(n);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
}
function fmtNumAlways(n) {
    if (n == null) return '0';
    n = Number(n);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
}
function initials(name) { return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2); }
function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateFull(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Extract subreddit name from input ---
function parseSubredditInput(input) {
    input = input.trim();
    // Handle URLs like reddit.com/r/name, old.reddit.com/r/name, etc.
    const urlMatch = input.match(/(?:reddit\.com|redd\.it)\/r\/([A-Za-z0-9_]+)/i);
    if (urlMatch) return urlMatch[1];
    // Handle r/name
    const rMatch = input.match(/^r\/([A-Za-z0-9_]+)$/i);
    if (rMatch) return rMatch[1];
    // Plain name
    if (/^[A-Za-z0-9_]+$/.test(input)) return input;
    return null;
}

// --- Extract post ID from Reddit post URL ---
function parsePostUrl(input) {
    input = input.trim();
    // https://reddit.com/r/sub/comments/POST_ID/...
    // https://www.reddit.com/r/sub/comments/POST_ID/...
    const match = input.match(/reddit\.com\/r\/[^/]+\/comments\/([A-Za-z0-9]+)/i);
    if (match) return { postId: match[1], url: input };
    return null;
}

// --- Clean Reddit image URLs (they sometimes have encoded amp entities) ---
function cleanImgUrl(url) {
    if (!url) return '';
    return url.split('?')[0].replace(/&amp;/g, '&');
}

// --- Modals ---
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) {
    const m = document.getElementById(id);
    m.classList.remove('active');
    m.querySelectorAll('input:not([type=hidden]), textarea').forEach(el => el.value = '');
    m.querySelectorAll('input[type=hidden]').forEach(el => el.value = '');
    m.querySelectorAll('select').forEach(el => el.selectedIndex = 0);
    // Reset previews
    m.querySelectorAll('.fetch-preview, .mp-manual-fields').forEach(el => el.classList.add('hidden'));
    m.querySelectorAll('.fetch-status').forEach(el => el.innerHTML = '');
    m.querySelectorAll('#subSaveBtn, #mpSaveBtn').forEach(el => el.classList.add('hidden'));
    fetchedSubData = null;
    fetchedPostData = null;
}

document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); });
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(m => closeModal(m.id));
});

// --- Theme ---
const themeToggle = document.getElementById('themeToggle');
function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('lk_theme', dark ? 'dark' : 'light');
}
if (localStorage.getItem('lk_theme') === 'dark') applyTheme(true);
themeToggle.addEventListener('click', () => applyTheme(!document.documentElement.classList.contains('dark')));

// ==========================================
//  NAVIGATION
// ==========================================
function goHome() {
    currentSubId = null;
    document.getElementById('homeView').classList.remove('hidden');
    document.getElementById('detailView').classList.add('hidden');
    document.getElementById('addSubredditBtn').classList.remove('hidden');
    renderHome();
}

function openSubreddit(id) {
    currentSubId = id;
    document.getElementById('homeView').classList.add('hidden');
    document.getElementById('detailView').classList.remove('hidden');
    document.getElementById('addSubredditBtn').classList.add('hidden');
    renderDetail();
}

// ==========================================
//  API FETCH (with local proxy)
// ==========================================
// Server URL — auto-detects: uses current host when deployed, localhost when local
const SERVER = window.location.origin;
const LOCAL_PROXY = `${SERVER}/api/proxy`;

async function proxyFetch(targetUrl, extraHeaders = {}) {
    // Try local proxy first (node server.js)
    try {
        const res = await fetch(`${LOCAL_PROXY}?url=${encodeURIComponent(targetUrl)}`, {
            headers: { 'Accept': 'application/json', ...extraHeaders }
        });
        const text = await res.text();
        // Parse response
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text.slice(0, 100)}`); }
        // Ahrefs returns errors as ["Error", "message"]
        if (Array.isArray(json) && json[0] === 'Error') {
            throw new Error(`Ahrefs: ${json[1] || 'Unknown error'}. Check your API key in Settings.`);
        }
        if (!res.ok && json.error) throw new Error(json.error);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return json;
    } catch (e) {
        // If it's an Ahrefs-specific error, don't try fallback proxies
        if (e.message.includes('Ahrefs:') || e.message.includes('API key')) throw e;
        // If local proxy is not running, try public CORS proxies (Reddit only)
        if (targetUrl.includes('reddit.com')) {
            const proxies = [
                url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
                url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            ];
            for (const makeUrl of proxies) {
                try {
                    const res = await fetch(makeUrl(targetUrl), {
                        headers: { 'Accept': 'application/json', ...extraHeaders }
                    });
                    if (res.ok) {
                        const text = await res.text();
                        if (text.trim().startsWith('{') || text.trim().startsWith('[')) return JSON.parse(text);
                    }
                } catch {}
            }
        }
        throw new Error('Could not fetch data. Make sure "node server.js" is running.');
    }
}

async function redditFetch(endpoint) {
    return proxyFetch(`https://www.reddit.com${endpoint}`);
}

// ==========================================
//  FETCH SUBREDDIT
// ==========================================
function openAddSubreddit() {
    openModal('subredditModal');
}

async function fetchSubreddit() {
    const input = document.getElementById('subInput').value;
    const status = document.getElementById('subFetchStatus');
    const preview = document.getElementById('subPreview');
    const saveBtn = document.getElementById('subSaveBtn');

    const name = parseSubredditInput(input);
    if (!name) {
        status.className = 'fetch-status error';
        status.textContent = 'Enter a valid subreddit name or link (e.g. r/MrMarketing)';
        return;
    }

    // Check if already added
    const existing = S.get('subreddits').find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
        status.className = 'fetch-status error';
        status.textContent = `r/${name} is already being tracked.`;
        return;
    }

    status.className = 'fetch-status loading';
    status.innerHTML = '<span class="spinner"></span> Fetching subreddit data...';
    preview.classList.add('hidden');
    saveBtn.classList.add('hidden');

    try {
        const data = await redditFetch(`/r/${name}/about.json`);
        const sub = data.data;

        fetchedSubData = {
            name: sub.display_name || name,
            subscribers: sub.subscribers || 0,
            description: sub.public_description || sub.title || '',
            bannerImg: cleanImgUrl(sub.banner_background_image || sub.banner_img || ''),
            iconImg: cleanImgUrl(sub.community_icon || sub.icon_img || ''),
            bannerColor: sub.banner_background_color || sub.key_color || '#1A1A2E',
            primaryColor: sub.primary_color || '#FF4500',
        };

        // Render preview
        const bannerEl = document.getElementById('previewBanner');
        if (fetchedSubData.bannerImg) {
            bannerEl.style.backgroundImage = `url('${fetchedSubData.bannerImg}')`;
            bannerEl.style.backgroundColor = fetchedSubData.bannerColor;
        } else {
            bannerEl.style.backgroundImage = '';
            bannerEl.style.backgroundColor = fetchedSubData.bannerColor || '#1A1A2E';
        }

        const avatarEl = document.getElementById('previewAvatar');
        if (fetchedSubData.iconImg) {
            avatarEl.style.backgroundImage = `url('${fetchedSubData.iconImg}')`;
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = fetchedSubData.name[0].toUpperCase();
        }
        avatarEl.style.backgroundColor = fetchedSubData.primaryColor || '#FF4500';

        document.getElementById('previewName').textContent = `r/${fetchedSubData.name}`;
        document.getElementById('previewSubs').textContent = `${fmtNumAlways(fetchedSubData.subscribers)} members`;
        document.getElementById('previewDesc').textContent = fetchedSubData.description || 'No description';

        status.className = 'fetch-status success';
        status.textContent = 'Subreddit found!';
        preview.classList.remove('hidden');
        saveBtn.classList.remove('hidden');
    } catch (err) {
        status.className = 'fetch-status error';
        status.textContent = err.message;
        preview.classList.add('hidden');
        saveBtn.classList.add('hidden');
    }
}

function saveSubreddit() {
    if (!fetchedSubData) return;

    let subs = S.get('subreddits');
    subs.push({
        id: S.nextId('subreddits'),
        name: fetchedSubData.name,
        bannerImg: fetchedSubData.bannerImg,
        iconImg: fetchedSubData.iconImg,
        bannerColor: fetchedSubData.bannerColor,
        primaryColor: fetchedSubData.primaryColor,
        description: fetchedSubData.description,
        followerHistory: [{ count: fetchedSubData.subscribers, date: new Date().toISOString() }],
        moneyPosts: [],
        tasks: [],
        ahrefs: { dr: 0, seoRank: 0, traffic: 0, refDomains: 0, history: [] },
        createdAt: new Date().toISOString()
    });
    S.set('subreddits', subs);
    closeModal('subredditModal');
    renderHome();
}

// Allow Enter key to trigger fetch
document.getElementById('subInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchSubreddit();
});

// ==========================================
//  REFRESH SUBREDDIT DATA
// ==========================================
async function refreshSubredditData() {
    const sub = getSub();
    if (!sub) return;

    const banner = document.getElementById('detailBanner');
    const origBg = banner.style.backgroundColor;

    try {
        const data = await redditFetch(`/r/${sub.name}/about.json`);
        const rd = data.data;

        updateSub(s => {
            // Update images
            s.bannerImg = cleanImgUrl(rd.banner_background_image || rd.banner_img || s.bannerImg || '');
            s.iconImg = cleanImgUrl(rd.community_icon || rd.icon_img || s.iconImg || '');
            s.bannerColor = rd.banner_background_color || rd.key_color || s.bannerColor;
            s.primaryColor = rd.primary_color || s.primaryColor;
            s.description = rd.public_description || rd.title || s.description;

            // Update followers
            const newCount = rd.subscribers || 0;
            if (!s.followerHistory) s.followerHistory = [];
            const last = s.followerHistory.length ? s.followerHistory[s.followerHistory.length - 1] : null;
            // Only add new entry if count changed or it's been more than 1 hour
            if (!last || last.count !== newCount) {
                s.followerHistory.push({ count: newCount, date: new Date().toISOString() });
            }
        });

        renderDetail();
    } catch (err) {
        toast('error', 'Refresh failed', err.message);
    }
}

// ==========================================
//  FETCH MONEY POST
// ==========================================
function openAddMoneyPost() {
    document.getElementById('moneyPostModalTitle').textContent = 'Add Money Post';
    fetchedPostData = null;
    openModal('moneyPostModal');
}

async function fetchMoneyPost() {
    const input = document.getElementById('mpInput').value;
    const status = document.getElementById('mpFetchStatus');
    const preview = document.getElementById('mpPreview');
    const manual = document.getElementById('mpManualFields');
    const saveBtn = document.getElementById('mpSaveBtn');

    const parsed = parsePostUrl(input);
    if (!parsed) {
        status.className = 'fetch-status error';
        status.textContent = 'Paste a valid Reddit post URL (e.g. reddit.com/r/.../comments/...)';
        return;
    }

    status.className = 'fetch-status loading';
    status.innerHTML = '<span class="spinner"></span> Fetching post data...';
    preview.classList.add('hidden');
    manual.classList.add('hidden');
    saveBtn.classList.add('hidden');

    try {
        const data = await redditFetch(`/comments/${parsed.postId}.json`);
        const post = data[0].data.children[0].data;

        fetchedPostData = {
            title: post.title,
            url: `https://www.reddit.com${post.permalink}`,
            upvotes: post.ups || post.score || 0,
            comments: post.num_comments || 0,
            author: post.author || '',
            created: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : '',
            subreddit: post.subreddit || '',
            flair: post.link_flair_text || '',
        };

        document.getElementById('mpPreviewTitle').textContent = fetchedPostData.title;
        document.getElementById('mpPreviewStats').innerHTML = `
            <span>${fmtNumAlways(fetchedPostData.upvotes)} upvotes</span>
            <span>${fmtNumAlways(fetchedPostData.comments)} comments</span>
            <span>by u/${esc(fetchedPostData.author)}</span>
            ${fetchedPostData.flair ? `<span class="badge badge-orange">${esc(fetchedPostData.flair)}</span>` : ''}
        `;

        status.className = 'fetch-status success';
        status.textContent = 'Post found!';
        preview.classList.remove('hidden');
        manual.classList.remove('hidden');
        saveBtn.classList.remove('hidden');
    } catch (err) {
        status.className = 'fetch-status error';
        status.textContent = err.message;
    }
}

function saveMoneyPost() {
    const editId = document.getElementById('mpEditId').value;

    if (editId) {
        // Editing existing post — re-fetch might have happened
        updateSub(sub => {
            const mp = (sub.moneyPosts || []).find(p => p.id === Number(editId));
            if (mp) {
                mp.rank = Number(document.getElementById('mpRank').value) || mp.rank;
                mp.revenueTag = document.getElementById('mpRevenue').value;
                if (fetchedPostData) {
                    mp.title = fetchedPostData.title;
                    mp.url = fetchedPostData.url;
                    mp.upvotes = fetchedPostData.upvotes;
                    mp.comments = fetchedPostData.comments;
                    mp.author = fetchedPostData.author;
                    // Track upvote history
                    if (!mp.history) mp.history = [];
                    mp.history.push({ upvotes: fetchedPostData.upvotes, comments: fetchedPostData.comments, date: new Date().toISOString() });
                }
            }
        });
    } else {
        if (!fetchedPostData) return toast('warning', 'Fetch first', 'Paste a Reddit post link and click Fetch.');
        updateSub(sub => {
            if (!sub.moneyPosts) sub.moneyPosts = [];
            const id = sub.moneyPosts.length ? Math.max(...sub.moneyPosts.map(p => p.id)) + 1 : 1;
            sub.moneyPosts.push({
                id,
                title: fetchedPostData.title,
                url: fetchedPostData.url,
                upvotes: fetchedPostData.upvotes,
                comments: fetchedPostData.comments,
                author: fetchedPostData.author,
                rank: Number(document.getElementById('mpRank').value) || null,
                seoRank: 0,
                revenueTag: document.getElementById('mpRevenue').value,
                history: [{ upvotes: fetchedPostData.upvotes, comments: fetchedPostData.comments, date: new Date().toISOString() }],
                tasks: []
            });
        });
    }

    closeModal('moneyPostModal');
    renderDetail();
}

document.getElementById('mpInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchMoneyPost();
});

// --- Refresh a single money post ---
async function refreshMoneyPost(mpId) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp || !mp.url) return;

    const parsed = parsePostUrl(mp.url);
    if (!parsed) return;

    try {
        const data = await redditFetch(`/comments/${parsed.postId}.json`);
        const post = data[0].data.children[0].data;

        updateSub(s => {
            const p = s.moneyPosts.find(x => x.id === mpId);
            if (!p) return;
            p.upvotes = post.ups || post.score || p.upvotes;
            p.comments = post.num_comments || p.comments;
            p.title = post.title || p.title;
            if (!p.history) p.history = [];
            p.history.push({ upvotes: p.upvotes, comments: p.comments, date: new Date().toISOString() });
        });
        renderDetail();
    } catch (err) {
        toast('error', 'Post refresh failed', err.message);
    }
}

function deleteMoneyPost(mpId) {
    confirmDelete('Delete this money post and its tasks?', () => {
        updateSub(sub => { sub.moneyPosts = (sub.moneyPosts || []).filter(p => p.id !== mpId); });
        renderDetail();
    });
}

// ==========================================
//  HOME — SUBREDDIT CARDS
// ==========================================
function renderHome() {
    const subs = S.get('subreddits');
    const grid = document.getElementById('subredditGrid');
    const empty = document.getElementById('emptyHome');

    if (subs.length === 0) {
        grid.innerHTML = '';
        grid.style.display = 'none';
        empty.style.display = '';
        return;
    }

    empty.style.display = 'none';
    grid.style.display = '';

    grid.innerHTML = subs.map(sub => {
        const fl = sub.followerHistory || [];
        const currentF = fl.length ? fl[fl.length - 1].count : 0;
        const prevF = fl.length > 1 ? fl[fl.length - 2].count : currentF;
        const diff = currentF - prevF;
        const diffStr = diff > 0 ? `+${fmtNum(diff)}` : diff < 0 ? `${fmtNum(diff)}` : '—';
        const diffClass = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral';

        const bannerStyle = sub.bannerImg
            ? `background-image:url('${esc(sub.bannerImg)}');background-color:${sub.bannerColor || '#1A1A2E'};`
            : `background:${sub.bannerColor || '#1A1A2E'};`;

        const avatarHasImg = !!sub.iconImg;
        const avatarStyle = avatarHasImg
            ? `background-image:url('${esc(sub.iconImg)}');background-color:${sub.primaryColor || '#FF4500'};`
            : `background:${sub.primaryColor || '#FF4500'};`;

        // Build money posts summary rows
        const mps = sub.moneyPosts || [];
        const hasKeywords = mps.some(mp => mp.googleKeywords?.length > 0);
        const mpRowsHtml = mps.length > 0 ? mps.map(mp => {
            // Best keyword rank
            const keywords = mp.googleKeywords || [];
            let bestRank = null, bestType = 'none', bestKw = '';
            keywords.forEach(kw => {
                const r = kw.avgRank || kw.rank;
                if (r && (!bestRank || (kw.rankType === 'google' && bestType !== 'google') || r < bestRank)) {
                    bestRank = r;
                    bestType = kw.rankType || 'none';
                    bestKw = kw.keyword;
                }
            });

            const rankBadge = bestType === 'google'
                ? `<span class="home-rank home-rank-google" title="${esc(bestKw)}: Google #${bestRank}">G#${bestRank}</span>`
                : bestType === 'reddit' && bestRank
                ? `<span class="home-rank home-rank-reddit" title="${esc(bestKw)}: Reddit #${bestRank}">R#${bestRank}</span>`
                : `<span class="home-rank home-rank-none">—</span>`;

            // Money comment position
            const mc = mp.moneyComment;
            const mcBadge = mc?.position
                ? `<span class="home-mc ${mc.position === 1 ? 'home-mc-1' : mc.position <= 3 ? 'home-mc-top' : 'home-mc-bad'}" title="Money comment #${mc.position}">#${mc.position}</span>`
                : mc?.commentId
                ? `<span class="home-mc home-mc-none" title="Not checked yet">?</span>`
                : '';

            return `<div class="home-mp-row">
                <span class="home-mp-title" title="${esc(mp.title)}">${esc(mp.title.length > 45 ? mp.title.slice(0, 42) + '...' : mp.title)}</span>
                <span class="home-mp-badges">
                    ${rankBadge}
                    ${mcBadge ? `<span class="home-mc-label">MC</span>${mcBadge}` : ''}
                </span>
            </div>`;
        }).join('') : '<div class="home-mp-empty">No money posts yet</div>';

        // Tasks summary — count by assignee
        const team = S.get('team');
        const allTasks = [
            ...(sub.tasks || []),
            ...(sub.moneyPosts || []).flatMap(mp => mp.tasks || [])
        ];
        const activeTasks = allTasks.filter(t => t.status !== 'Done');
        const doneTasks = allTasks.filter(t => t.status === 'Done');

        // Group active tasks by assignee
        const byAssignee = {};
        activeTasks.forEach(t => {
            const key = t.assigneeId || 0;
            if (!byAssignee[key]) byAssignee[key] = 0;
            byAssignee[key]++;
        });

        const assigneeBadges = Object.entries(byAssignee).map(([id, count]) => {
            const member = team.find(m => m.id === Number(id));
            if (member) {
                return `<span class="home-assignee" style="background:${member.color || 'var(--primary)'}" title="${esc(member.name)}: ${count} task${count > 1 ? 's' : ''}">${initials(member.name)} ${count}</span>`;
            }
            return `<span class="home-assignee home-assignee-none" title="Unassigned: ${count}">? ${count}</span>`;
        }).join('');

        const tasksHtml = allTasks.length > 0 ? `<div class="home-tasks-section">
            <div class="home-tasks-bar">
                <span class="home-tasks-count">${activeTasks.length} active${doneTasks.length ? ` · ${doneTasks.length} done` : ''}</span>
                <span class="home-assignees">${assigneeBadges}</span>
            </div>
        </div>` : '';

        return `<div class="sub-card" onclick="openSubreddit(${sub.id})">
            <div class="sub-card-banner" style="${bannerStyle}"></div>
            <div class="sub-card-identity">
                <div class="sub-card-avatar" style="${avatarStyle}">${avatarHasImg ? '' : esc(sub.name[0].toUpperCase())}</div>
                <div class="sub-card-name">r/${esc(sub.name)}</div>
            </div>
            <div class="sub-card-body">
                <div class="sub-card-followers">
                    <span class="count">${fmtNumAlways(currentF)}</span>
                    <span class="label">Followers</span>
                    <span class="change ${diffClass}">${diffStr}</span>
                </div>
                <div class="home-mp-section">
                    <div class="home-mp-header">
                        <span class="home-mp-heading">Money Posts (${mps.length})</span>
                        ${hasKeywords ? `<button class="btn btn-xs btn-primary home-check-btn" onclick="event.stopPropagation();homeCheckAll(${sub.id})" title="Check all keyword ranks">Check All</button>` : ''}
                    </div>
                    ${mpRowsHtml}
                </div>
                ${tasksHtml}
            </div>
        </div>`;
    }).join('');
}

// ==========================================
//  HOME — CHECK ALL RANKS FOR A SUBREDDIT
// ==========================================
async function homeCheckAll(subId) {
    const subs = S.get('subreddits');
    const sub = subs.find(s => s.id === subId);
    if (!sub) return;

    const serpKey = getSerpApiKey();
    if (!serpKey) return toast('warning', 'Need SERP API', 'Set a SERP API key in Settings.');

    const posts = (sub.moneyPosts || []).filter(mp => mp.googleKeywords?.length > 0);
    if (!posts.length) return toast('warning', 'No keywords', 'No keywords to check in this subreddit.');

    const totalKw = posts.reduce((s, mp) => s + mp.googleKeywords.length, 0);
    toast('info', `Checking r/${sub.name}`, `${totalKw} keyword(s) across ${posts.length} post(s)`, 4000);

    // Temporarily set currentSubId to allow updateSub to work
    const prevSubId = currentSubId;
    currentSubId = subId;

    for (const mp of posts) {
        for (let i = 0; i < mp.googleKeywords.length; i++) {
            await autoCheckRank(mp.id, i);
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    currentSubId = prevSubId;
    toast('success', 'Done', `All rank checks complete for r/${sub.name}`, 5000);
    renderHome();
}

// ==========================================
//  DETAIL VIEW
// ==========================================
function getSub() { return S.get('subreddits').find(s => s.id === currentSubId); }
function updateSub(fn) {
    let subs = S.get('subreddits');
    const idx = subs.findIndex(s => s.id === currentSubId);
    if (idx === -1) return;
    fn(subs[idx]);
    S.set('subreddits', subs);
}

function renderDetail() {
    const sub = getSub();
    if (!sub) return goHome();

    // Banner
    const banner = document.getElementById('detailBanner');
    banner.style.backgroundImage = sub.bannerImg ? `url('${sub.bannerImg}')` : '';
    banner.style.backgroundColor = sub.bannerColor || '#1A1A2E';

    // Avatar
    const avatar = document.getElementById('detailAvatar');
    if (sub.iconImg) {
        avatar.style.backgroundImage = `url('${sub.iconImg}')`;
        avatar.textContent = '';
    } else {
        avatar.style.backgroundImage = '';
        avatar.textContent = sub.name[0].toUpperCase();
    }
    avatar.style.backgroundColor = sub.primaryColor || '#FF4500';

    document.getElementById('detailName').textContent = `r/${sub.name}`;
    document.getElementById('detailDesc').textContent = sub.description || '';

    // Followers
    const fl = sub.followerHistory || [];
    const currentF = fl.length ? fl[fl.length - 1].count : 0;
    document.getElementById('detailFollowers').textContent = fmtNumAlways(currentF);

    const changeEl = document.getElementById('detailFollowersChange');
    if (fl.length > 1) {
        const prev = fl[fl.length - 2].count;
        const diff = currentF - prev;
        if (diff !== 0) {
            changeEl.textContent = (diff > 0 ? '+' : '') + fmtNumAlways(diff);
            changeEl.className = 'followers-change ' + (diff > 0 ? 'up' : 'down');
            changeEl.style.display = '';
        } else {
            changeEl.style.display = 'none';
        }
    } else {
        changeEl.style.display = 'none';
    }

    // Follower history bar
    const histBar = document.getElementById('followersHistoryBar');
    if (fl.length > 1) {
        const entries = fl.slice(-8);
        histBar.innerHTML = entries.map((entry, i) => {
            const prev = i > 0 ? entries[i - 1].count : (fl.length > entries.length ? fl[fl.length - entries.length - 1]?.count : entry.count);
            const diff = entry.count - prev;
            let diffHtml = '';
            if (i > 0 && diff !== 0) {
                diffHtml = `<span class="fh-diff ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${fmtNumAlways(diff)}</span>`;
            }
            return `<div class="fh-entry">
                <span class="fh-date">${fmtDate(entry.date)}</span>
                <span class="fh-count">${fmtNumAlways(entry.count)}</span>
                ${diffHtml}
            </div>`;
        }).join('');
    } else {
        histBar.innerHTML = '';
    }

    // Ahrefs
    const a = sub.ahrefs || {};
    document.getElementById('ahrefsDR').textContent = a.dr || '—';
    document.getElementById('ahrefsTraffic').textContent = a.traffic ? fmtNum(a.traffic) : '—';
    document.getElementById('ahrefsRank').textContent = a.seoRank ? '#' + fmtNum(a.seoRank) : '—';
    document.getElementById('ahrefsRefDomains').textContent = a.refDomains ? fmtNum(a.refDomains) : '—';

    renderMoneyPosts(sub);
    renderSubredditTasks(sub);
}

function deleteCurrentSubreddit() {
    const sub = getSub();
    if (!sub) return;
    confirmDelete(`Delete r/${sub.name} and all its data?`, () => {
        S.set('subreddits', S.get('subreddits').filter(s => s.id !== sub.id));
        goHome();
    });
}

// ==========================================
//  SETTINGS
// ==========================================
function getAhrefsKey() { return localStorage.getItem('lk_ahrefs_key') || ''; }
function getSerpApiKey() { return localStorage.getItem('lk_serp_key') || ''; }
function getDolphinToken() { return localStorage.getItem('lk_dolphin_token') || ''; }
function getDolphinProfiles() {
    try { return JSON.parse(localStorage.getItem('lk_dolphin_profiles')) || []; } catch { return []; }
}

function openSettings() {
    document.getElementById('ahrefsKeyInput').value = getAhrefsKey();
    document.getElementById('serpApiKeyInput').value = getSerpApiKey();
    document.getElementById('dolphinTokenInput').value = getDolphinToken();

    const status = document.getElementById('settingsStatus');
    const parts = [];
    if (getAhrefsKey()) parts.push('Ahrefs');
    if (getSerpApiKey()) parts.push('SERP API');
    const profiles = getDolphinProfiles();
    if (getDolphinToken() && profiles.length) parts.push(`Dolphin (${profiles.length})`);
    if (parts.length) {
        status.className = 'api-key-status connected';
        status.textContent = 'Connected: ' + parts.join(' | ');
    } else {
        status.className = 'api-key-status';
        status.textContent = '';
    }

    if (getDolphinToken()) loadDolphinProfiles();
    openModal('settingsModal');
}

function saveSettings() {
    const ahrefsKey = document.getElementById('ahrefsKeyInput').value.trim();
    const serpKey = document.getElementById('serpApiKeyInput').value.trim();
    const dolphinToken = document.getElementById('dolphinTokenInput').value.trim();
    const profiles = [
        document.getElementById('dolphinProfile1').value,
        document.getElementById('dolphinProfile2').value,
        document.getElementById('dolphinProfile3').value,
    ].filter(p => p);

    ahrefsKey ? localStorage.setItem('lk_ahrefs_key', ahrefsKey) : localStorage.removeItem('lk_ahrefs_key');
    serpKey ? localStorage.setItem('lk_serp_key', serpKey) : localStorage.removeItem('lk_serp_key');
    dolphinToken ? localStorage.setItem('lk_dolphin_token', dolphinToken) : localStorage.removeItem('lk_dolphin_token');
    localStorage.setItem('lk_dolphin_profiles', JSON.stringify(profiles));

    closeModal('settingsModal');
    toast('success', 'Settings saved', '');
}

function toggleKeyVisibility(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function loadDolphinProfiles() {
    const token = document.getElementById('dolphinTokenInput').value.trim() || getDolphinToken();
    if (!token) return toast('warning', 'No token', 'Enter your Dolphin Anty token first.');

    const selects = ['dolphinProfile1', 'dolphinProfile2', 'dolphinProfile3'];
    selects.forEach(id => {
        document.getElementById(id).innerHTML = '<option value="">Loading...</option>';
    });

    try {
        const res = await fetch(`${SERVER}/api/dolphin/profiles`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const profiles = data.profiles || [];
        const saved = getDolphinProfiles();
        const optionsHtml = '<option value="">Select profile...</option>' +
            profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

        selects.forEach((id, i) => {
            const sel = document.getElementById(id);
            sel.innerHTML = optionsHtml;
            if (saved[i]) sel.value = saved[i];
        });
    } catch (err) {
        selects.forEach(id => {
            document.getElementById(id).innerHTML = '<option value="">Failed to load</option>';
        });
        toast('error', 'Dolphin error', err.message);
    }
}

// ==========================================
//  TOAST NOTIFICATION SYSTEM
// ==========================================
function toast(type, title, message, duration = 5000) {
    const container = document.getElementById('toastContainer');
    const icons = { success: 'OK', error: '!', info: 'i', warning: '!' };
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `
        <div class="toast-icon ${type}">${icons[type] || 'i'}</div>
        <div class="toast-body">
            <div class="toast-title">${esc(title)}</div>
            ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" onclick="this.closest('.toast').remove()">&times;</button>
    `;
    container.appendChild(el);
    if (duration > 0) {
        setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, duration);
    }
    return el;
}

// ==========================================
//  RANK CHECK PROGRESS PANEL
// ==========================================
function showRankPanel(keyword, checks) {
    const panel = document.getElementById('rankPanel');
    panel.classList.remove('hidden');
    document.getElementById('rankPanelKeyword').textContent = keyword;
    document.getElementById('rankPanelResult').classList.add('hidden');

    const container = document.getElementById('rankPanelProfiles');
    const count = Array.isArray(checks) ? checks.length : 1;
    container.innerHTML = Array.from({ length: count }, (_, i) => `
        <div class="rp-profile" id="rpProfile${i}">
            <div class="rp-status-dot running" id="rpDot${i}"></div>
            <span class="rp-label">Check ${i + 1}</span>
            <span class="rp-step" id="rpStep${i}">Searching Google...</span>
            <span class="rp-result" id="rpResult${i}"></span>
        </div>
    `).join('');
}

function updateRankProfile(index, status, step, result = '') {
    const dot = document.getElementById(`rpDot${index}`);
    const stepEl = document.getElementById(`rpStep${index}`);
    const resultEl = document.getElementById(`rpResult${index}`);
    if (dot) dot.className = `rp-status-dot ${status}`;
    if (stepEl) stepEl.textContent = step;
    if (resultEl) resultEl.innerHTML = result;
}

function showRankResult(type, avgRank) {
    const el = document.getElementById('rankPanelResult');
    el.classList.remove('hidden');
    el.innerHTML = `
        <span class="rp-final-type ${type}">${type === 'google' ? 'On Google' : type === 'reddit' ? 'Among Reddit' : 'Not Found'}</span>
        <span class="rp-final-rank ${type}">AVG ${avgRank ? '#' + avgRank : '—'}</span>
    `;
}

function closeRankPanel() {
    document.getElementById('rankPanel').classList.add('hidden');
}

// ==========================================
//  PARALLEL RANK CHECKING (3 fresh proxies)
// ==========================================
const NUM_CHECKS = 3; // 3 parallel checks with different proxy ports

async function checkRankWithProxy(keyword, targetUrl, proxyIndex) {
    const serpKey = getSerpApiKey();

    // Use SERP API if key is set (faster, no browser needed)
    if (serpKey) {
        const res = await fetch(`${SERVER}/api/serp-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword, targetUrl, apiKey: serpKey })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data;
    }

    // Fallback: Chromium + proxy
    const res = await fetch(`${SERVER}/api/check-rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, targetUrl, proxyIndex })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
}

async function autoCheckRank(mpId, kwIndex) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    const kw = mp?.googleKeywords?.[kwIndex];
    if (!kw || !mp.url) return;

    const serpKey = getSerpApiKey();

    // SERP API: single request, no panel needed
    if (serpKey) {
        toast('info', 'Checking rank...', `"${kw.keyword}"`, 3000);

        try {
            const data = await checkRankWithProxy(kw.keyword, mp.url, 0);
            const rankType = data.type === 'google' ? 'google' : data.redditRank ? 'reddit' : 'none';
            const avgRank = data.rank || data.redditRank || null;

            // Save rank + SERP results in one call
            updateSub(s => {
                const p = s.moneyPosts.find(x => x.id === mpId);
                const k = p?.googleKeywords?.[kwIndex];
                if (!k) return;
                if (!k.history) k.history = [];
                if (k.rankType) k.history.push({ rankType: k.rankType, avgRank: k.avgRank, date: k.updatedAt });
                k.rankType = rankType;
                k.avgRank = avgRank;
                k.rank = avgRank;
                k.checks = [{ profileIndex: 1, type: rankType, googleRank: data.rank, redditRank: data.redditRank }];
                k.updatedAt = new Date().toISOString();
                // SERP results + competitors
                if (data.competitors?.length) k.pendingCompetitors = data.competitors;
                if (data.serpResults) k.serpResults = data.serpResults;
                if (data.redditSerpResults) k.redditSerpResults = data.redditSerpResults;
                k.serpQuery = data.serpQuery || kw.keyword;
            });

            renderDetail();

            if (rankType === 'google') toast('success', `Google #${avgRank}`, `"${kw.keyword}" is on Google!`, 6000);
            else if (rankType === 'reddit') toast('info', `Reddit #${avgRank}`, `"${kw.keyword}" among Reddit posts`, 6000);
            else toast('warning', 'Not ranking', `"${kw.keyword}" not found`, 6000);
            return;
        } catch (err) {
            toast('error', 'Check failed', err.message, 6000);
            return;
        }
    }

    // Fallback: Chromium with proxy (single check)
    showRankPanel(kw.keyword, [0]);
    updateRankProfile(0, 'running', 'Searching Google...');

    let rankType = 'none', avgRank = null;

    try {
        const data = await checkRankWithProxy(kw.keyword, mp.url, 0);
        if (data.type === 'google') {
            updateRankProfile(0, 'done', 'Found on Google', `<span class="rp-result google">G#${data.rank}</span>`);
            rankType = 'google'; avgRank = data.rank;
        } else if (data.type === 'reddit' && data.redditRank) {
            updateRankProfile(0, 'done', 'Found on Reddit', `<span class="rp-result reddit">R#${data.redditRank}</span>`);
            rankType = 'reddit'; avgRank = data.redditRank;
        } else if (data.type === 'captcha') {
            updateRankProfile(0, 'captcha', 'CAPTCHA — retrying...', '<span class="rp-result none">CAP</span>');
        } else {
            updateRankProfile(0, 'done', 'Not found', '<span class="rp-result none">—</span>');
        }
    } catch (err) {
        updateRankProfile(0, 'error', err.message.slice(0, 40), '<span class="rp-result none">ERR</span>');
    }

    showRankResult(rankType, avgRank);

    // Save
    updateSub(s => {
        const p = s.moneyPosts.find(x => x.id === mpId);
        const k = p?.googleKeywords?.[kwIndex];
        if (!k) return;
        if (!k.history) k.history = [];
        if (k.rankType) {
            k.history.push({ rankType: k.rankType, avgRank: k.avgRank, date: k.updatedAt });
        }
        k.rankType = rankType;
        k.avgRank = avgRank;
        k.rank = avgRank ? Math.round(avgRank) : null;
        k.checks = [{ profileIndex: 1, type: rankType, googleRank: rankType === 'google' ? avgRank : null, redditRank: rankType === 'reddit' ? avgRank : null }];
        k.updatedAt = new Date().toISOString();
    });

    renderDetail();

    // Toast summary
    if (rankType === 'google') {
        toast('success', `Google #${avgRank}`, `"${kw.keyword}" is ranking on Google!`, 8000);
    } else if (rankType === 'reddit') {
        toast('info', `Reddit #${avgRank}`, `"${kw.keyword}" found among Reddit posts`, 8000);
    } else {
        toast('warning', 'Not ranking', `"${kw.keyword}" not found${captchaCount ? ` (${captchaCount} CAPTCHA)` : ''}`, 8000);
    }
}

// Check ALL keywords for a single money post
async function autoCheckAllRanks(mpId) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp?.googleKeywords?.length) return;

    toast('info', 'Checking all keywords', `${mp.googleKeywords.length} keyword(s) for "${mp.title.slice(0, 30)}..."`, 3000);

    for (let i = 0; i < mp.googleKeywords.length; i++) {
        await autoCheckRank(mpId, i);
        if (i < mp.googleKeywords.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
}

// Check ALL keywords across ALL money posts in current subreddit
async function autoCheckSubreddit() {
    const sub = getSub();
    if (!sub) return;
    const posts = (sub.moneyPosts || []).filter(mp => mp.googleKeywords?.length > 0);
    if (!posts.length) { toast('warning', 'Nothing to check', 'No keywords to track in this subreddit'); return; }

    const totalKw = posts.reduce((s, mp) => s + mp.googleKeywords.length, 0);
    toast('info', 'Subreddit rank check', `Checking ${totalKw} keyword(s) across ${posts.length} post(s)`, 4000);

    for (const mp of posts) {
        for (let i = 0; i < mp.googleKeywords.length; i++) {
            await autoCheckRank(mp.id, i);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    toast('success', 'Done', `All rank checks complete for r/${sub.name}`, 5000);
}

// ==========================================
//  AHREFS API
// ==========================================
async function ahrefsFetch(endpoint, params = {}) {
    const key = getAhrefsKey();
    if (!key) throw new Error('No Ahrefs API key. Go to Settings (gear icon) to add it.');

    const query = new URLSearchParams(params).toString();
    const targetUrl = `https://api.ahrefs.com/v3${endpoint}${query ? '?' + query : ''}`;

    return proxyFetch(targetUrl, { 'Authorization': `Bearer ${key}` });
}

// Fetch Ahrefs metrics for a specific URL (subreddit or post)
async function fetchAhrefsForTarget(target) {
    const [drData, metricsData] = await Promise.allSettled([
        ahrefsFetch('/site-explorer/domain-rating', { target }),
        ahrefsFetch('/site-explorer/metrics', { target })
    ]);

    const dr = drData.status === 'fulfilled' ? drData.value : {};
    const met = metricsData.status === 'fulfilled' ? metricsData.value : {};

    // Log raw responses for debugging
    console.log('[Ahrefs DR raw]', JSON.stringify(dr));
    console.log('[Ahrefs Metrics raw]', JSON.stringify(met));

    // Deep-search for values — Ahrefs nests differently per endpoint
    function dig(obj, ...keys) {
        for (const key of keys) {
            if (obj == null) return 0;
            // Search at current level
            if (obj[key] !== undefined) return obj[key];
            // Search one level deep
            for (const v of Object.values(obj)) {
                if (v && typeof v === 'object' && v[key] !== undefined) return v[key];
            }
        }
        return 0;
    }

    return {
        dr: dig(dr, 'domain_rating', 'domainRating', 'dr'),
        ahrefsRank: dig(dr, 'ahrefs_rank', 'ahrefsRank', 'rank'),
        organicTraffic: dig(met, 'organic_traffic', 'org_traffic', 'traffic'),
        organicKeywords: dig(met, 'organic_keywords', 'org_keywords', 'keywords'),
        refDomains: dig(met, 'referring_domains', 'ref_domains', 'refdomains'),
        refPages: dig(met, 'referring_pages', 'ref_pages'),
        trafficValue: dig(met, 'organic_cost', 'org_cost', 'cost', 'traffic_value'),
    };
}

async function fetchAhrefsData() {
    const sub = getSub();
    if (!sub) return;

    const status = document.getElementById('ahrefsFetchStatus');
    const target = `www.reddit.com/r/${sub.name}/`;

    status.className = 'fetch-status loading';
    status.innerHTML = '<span class="spinner"></span> Fetching from Ahrefs...';

    try {
        const data = await fetchAhrefsForTarget(target);

        document.getElementById('updateDR').value = data.dr || 0;
        document.getElementById('updateSeoRank').value = data.ahrefsRank || 0;
        document.getElementById('updateTraffic').value = data.organicTraffic || 0;
        document.getElementById('updateRefDomains').value = data.refDomains || 0;

        const summary = `DR: ${data.dr || 0} | Traffic: ${fmtNumAlways(data.organicTraffic)} | Rank: ${data.ahrefsRank || '—'} | Ref domains: ${fmtNumAlways(data.refDomains)}`;
        status.className = 'fetch-status success';
        status.textContent = data.dr || data.organicTraffic ? `Fetched: ${summary}` : 'Fetched but no data found for this target. Try entering manually.';
    } catch (err) {
        status.className = 'fetch-status error';
        status.textContent = err.message;
    }
}

// Fetch Ahrefs data for a specific money post
async function fetchAhrefsForPost(mpId) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp?.url) return toast('warning', 'No URL', 'This post has no URL to check.');

    try {
        // Extract the path from the URL for Ahrefs target
        const urlObj = new URL(mp.url);
        const target = urlObj.hostname + urlObj.pathname;
        const data = await fetchAhrefsForTarget(target);

        updateSub(s => {
            const p = s.moneyPosts.find(x => x.id === mpId);
            if (!p) return;
            if (!p.ahrefsHistory) p.ahrefsHistory = [];
            // Save current to history
            if (p.ahrefs) {
                p.ahrefsHistory.push({ ...p.ahrefs, date: new Date().toISOString() });
            }
            p.ahrefs = { ...data, date: new Date().toISOString() };
        });
        renderDetail();
    } catch (err) {
        toast('error', 'Ahrefs failed', err.message);
    }
}

function openUpdateAhrefs() {
    const sub = getSub();
    if (!sub) return;
    const a = sub.ahrefs || {};
    document.getElementById('updateDR').value = a.dr || '';
    document.getElementById('updateSeoRank').value = a.seoRank || '';
    document.getElementById('updateTraffic').value = a.traffic || '';
    document.getElementById('updateRefDomains').value = a.refDomains || '';

    // Show/hide auto-fetch based on whether key exists
    const hasKey = !!getAhrefsKey();
    document.getElementById('ahrefsAutoSection').style.display = hasKey ? '' : 'none';
    document.querySelector('.divider-or').style.display = hasKey ? '' : 'none';
    document.getElementById('ahrefsFetchStatus').innerHTML = '';

    const hist = a.history || [];
    const histEl = document.getElementById('ahrefsHistory');
    if (hist.length > 0) {
        histEl.innerHTML = `<div class="history-title">Ahrefs History</div>` +
            hist.slice().reverse().slice(0, 8).map(e =>
                `<div class="history-row">
                    <span class="history-date">${fmtDate(e.date)}</span>
                    <span class="history-val">DR ${e.dr} | Traffic ${fmtNum(e.traffic)} | Rank #${fmtNum(e.seoRank)}</span>
                </div>`
            ).join('');
    } else {
        histEl.innerHTML = '';
    }

    openModal('ahrefsModal');
}

function saveAhrefsUpdate() {
    updateSub(sub => {
        if (!sub.ahrefs) sub.ahrefs = {};
        if (sub.ahrefs.dr || sub.ahrefs.traffic) {
            if (!sub.ahrefs.history) sub.ahrefs.history = [];
            sub.ahrefs.history.push({
                dr: sub.ahrefs.dr, seoRank: sub.ahrefs.seoRank,
                traffic: sub.ahrefs.traffic, refDomains: sub.ahrefs.refDomains,
                date: new Date().toISOString()
            });
        }
        sub.ahrefs.dr = Number(document.getElementById('updateDR').value) || 0;
        sub.ahrefs.seoRank = Number(document.getElementById('updateSeoRank').value) || 0;
        sub.ahrefs.traffic = Number(document.getElementById('updateTraffic').value) || 0;
        sub.ahrefs.refDomains = Number(document.getElementById('updateRefDomains').value) || 0;
    });
    closeModal('ahrefsModal');
    renderDetail();
}


// ==========================================
//  FULL SERP RESULTS (collapsible)
// ==========================================
const _serpOpen = {};

function toggleSerp(serpId) {
    _serpOpen[serpId] = !_serpOpen[serpId];
    const el = document.getElementById(serpId);
    if (el) el.classList.toggle('hidden', !_serpOpen[serpId]);
}

function renderSerpResults(serpId, kw) {
    const isOpen = !!_serpOpen[serpId];
    const googleResults = kw.serpResults || [];
    const redditResults = kw.redditSerpResults || [];
    const hasGoogle = googleResults.length > 0;
    const hasReddit = redditResults.length > 0;

    function serpResultHtml(r) {
        const domain = (() => { try { return new URL(r.url).hostname; } catch { return ''; } })();
        const highlightClass = r.isTarget ? 'serp-result-ours' : '';

        return `<div class="serp-result ${highlightClass}">
            <div class="serp-result-url">
                <img class="serp-result-icon" src="${r.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`}" width="16" height="16" alt="" onerror="this.style.display='none'">
                <span class="serp-result-source">${esc(r.source || domain)}</span>
                <span class="serp-result-link">${esc(r.displayedLink || r.url || '')}</span>
            </div>
            <a class="serp-result-title" href="${esc(r.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(r.title || '')}</a>
            <div class="serp-result-snippet">${esc(r.snippet || '')}</div>
            <span class="serp-result-pos">#${r.position}</span>
            ${r.isTarget ? '<span class="serp-result-tag">YOUR POST</span>' : ''}
        </div>`;
    }

    return `<div class="serp-full-panel ${isOpen ? '' : 'hidden'}" id="${serpId}">
        ${hasGoogle ? `<div class="serp-section">
            <div class="serp-section-header">
                <span class="serp-section-title">Google Results for "${esc(kw.serpQuery || kw.keyword)}"</span>
                <a class="serp-section-link" href="https://www.google.com/search?q=${encodeURIComponent(kw.keyword)}&gl=us&hl=en" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open in Google</a>
            </div>
            ${googleResults.map(serpResultHtml).join('')}
        </div>` : ''}
        ${hasReddit ? `<div class="serp-section">
            <div class="serp-section-header">
                <span class="serp-section-title">Reddit Results (site:reddit.com)</span>
                <a class="serp-section-link" href="https://www.google.com/search?q=${encodeURIComponent(kw.keyword + ' site:www.reddit.com')}&gl=us&hl=en" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open in Google</a>
            </div>
            ${redditResults.map(serpResultHtml).join('')}
        </div>` : ''}
    </div>`;
}

// ==========================================
//  MONEY POSTS RENDERING
// ==========================================
function renderMoneyPosts(sub) {
    const list = document.getElementById('moneyPostsList');
    const empty = document.getElementById('emptyMoneyPosts');
    const posts = (sub.moneyPosts || []).sort((a, b) => (a.rank || 999) - (b.rank || 999));

    if (posts.length === 0) {
        list.innerHTML = '';
        empty.classList.add('show');
        return;
    }

    empty.classList.remove('show');
    const team = S.get('team');
    const hasAhrefsKey = !!getAhrefsKey();
    const revColors = { 'Direct Sale': 'badge-green', 'Affiliate': 'badge-orange', 'Lead Gen': 'badge-blue', 'Brand Awareness': 'badge-yellow', 'Traffic Driver': 'badge-yellow' };

    list.innerHTML = posts.map(mp => {
        const activeTasks = (mp.tasks || []).filter(t => t.status !== 'Done').length;
        const tasksHtml = (mp.tasks || []).map(t => renderTaskRow(t, 'post', mp.id, team)).join('');
        const ah = mp.ahrefs || {};
        const keywords = mp.googleKeywords || [];

        // Ahrefs metrics bar for this post
        const ahrefsHtml = `<div class="mp-ahrefs-bar">
            <div class="mp-ahrefs-stat"><span class="lbl">DR</span><span class="val">${ah.dr || '—'}</span></div>
            <div class="mp-ahrefs-stat"><span class="lbl">Ref. Domains</span><span class="val">${ah.refDomains ? fmtNum(ah.refDomains) : '—'}</span></div>
            <div class="mp-ahrefs-stat"><span class="lbl">Organic Traffic</span><span class="val">${ah.organicTraffic ? fmtNumAlways(ah.organicTraffic) : '—'}</span></div>
            <div class="mp-ahrefs-stat"><span class="lbl">Keywords</span><span class="val">${ah.organicKeywords || '—'}</span></div>
            <div class="mp-ahrefs-stat"><span class="lbl">Value</span><span class="val">${ah.trafficValue ? '$' + fmtNumAlways(ah.trafficValue) : '—'}</span></div>
            ${hasAhrefsKey ? `<button class="btn-icon" onclick="fetchAhrefsForPost(${mp.id})" title="Fetch Ahrefs data">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            </button>` : ''}
        </div>`;

        // Google rank tracking
        const hasDolphin = true; // Always available — uses Chromium + proxy directly
        const profileCount = NUM_CHECKS;
        const keywordsHtml = keywords.length > 0 ? keywords.map((kw, i) => {
            const rType = kw.rankType || (kw.rank ? 'reddit' : 'none');
            const avg = kw.avgRank || kw.rank;
            const checks = kw.checks || [];

            // Visual differentiation: Google = green/gold, Reddit = blue, None = gray
            let rankClass, badgeClass, statusText, statusIcon;
            if (rType === 'google') {
                rankClass = 'rank-google';
                badgeClass = 'gr-badge-google';
                statusText = 'Ranked on Google';
                statusIcon = '&#x1f30d;'; // not using emoji per rules, use text
            } else if (rType === 'reddit' && avg) {
                rankClass = avg <= 3 ? 'rank-reddit-top' : 'rank-reddit';
                badgeClass = 'gr-badge-reddit';
                statusText = 'Among Reddit posts';
            } else {
                rankClass = 'rank-none';
                badgeClass = 'gr-badge-none';
                statusText = 'Not ranking';
            }

            // Individual check pills
            const pillsHtml = checks.length > 1 ? `<div class="gr-ranks-detail">
                ${checks.map((c, j) => {
                    if (c.type === 'google') return `<span class="gr-pill gr-pill-google" title="Profile ${j+1}: Google #${c.googleRank}">G#${c.googleRank}</span>`;
                    if (c.type === 'reddit' && c.redditRank) return `<span class="gr-pill gr-pill-reddit" title="Profile ${j+1}: Reddit #${c.redditRank}">R#${c.redditRank}</span>`;
                    if (c.type === 'captcha') return `<span class="gr-pill gr-pill-captcha" title="Profile ${j+1}: CAPTCHA">CAP</span>`;
                    return `<span class="gr-pill gr-pill-none" title="Profile ${j+1}: Not found">—</span>`;
                }).join('')}
                <span class="gr-avg-label">AVG</span>
            </div>` : '';

            const hasSerpData = kw.serpResults?.length || kw.redditSerpResults?.length;
            const serpId = `serp_${mp.id}_${i}`;

            return `<div class="google-rank-block">
                <div class="google-rank-row">
                    <span class="gr-keyword">${esc(kw.keyword)}</span>
                    <span class="gr-type-badge ${badgeClass}">${rType === 'google' ? 'GOOGLE' : rType === 'reddit' ? 'REDDIT' : 'N/A'}</span>
                    <span class="gr-rank ${rankClass}">${avg ? '#' + avg : '—'}</span>
                    ${pillsHtml}
                    <span class="gr-note">${statusText}${kw.updatedAt ? ' · ' + fmtDate(kw.updatedAt) : ''}${kw.captchaCount ? ' · ' + kw.captchaCount + ' captcha' : ''}</span>
                    ${hasSerpData ? `<button class="btn-icon" onclick="toggleSerp('${serpId}')" title="View full SERP results">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                    </button>` : ''}
                    ${hasDolphin ? `<button class="btn-icon" onclick="autoCheckRank(${mp.id},${i})" title="Check rank">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                    </button>` : `<button class="btn-icon" onclick="updateKeywordRank(${mp.id},${i})" title="Update rank manually">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                    </button>`}
                    <a class="btn-icon" href="https://www.google.com/search?q=${encodeURIComponent(kw.keyword)}&gl=us&hl=en" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Search Google">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </a>
                    <button class="btn-icon danger" onclick="removeKeyword(${mp.id},${i})" title="Remove">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                ${hasSerpData ? renderSerpResults(serpId, kw) : ''}
            </div>`;
        }).join('') : '';

        const mpIdx = posts.indexOf(mp);
        return `<div class="money-post-item" draggable="true" ondragstart="mpDragStart(event,${mpIdx})" ondragover="mpDragOver(event,${mpIdx})" ondragend="mpDragEnd(event)" ondrop="mpDrop(event,${mpIdx})">
            <div class="money-post-header">
                <div class="mp-rank">${mp.rank || '—'}</div>
                <div class="mp-info">
                    <div class="mp-title">${esc(mp.title)}</div>
                    <div class="mp-meta">
                        <span class="badge ${revColors[mp.revenueTag] || 'badge-gray'}">${mp.revenueTag || 'Untagged'}</span>
                        <span>${fmtNumAlways(mp.upvotes)} upvotes</span>
                        <span>${fmtNumAlways(mp.comments)} comments</span>
                        ${mp.url ? `<a href="${esc(mp.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent-blue)">View</a>` : ''}
                    </div>
                </div>
                <div class="mp-actions">
                    <button class="btn-icon" onclick="refreshMoneyPost(${mp.id})" title="Refresh Reddit stats">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                    </button>
                    <button class="btn-icon danger" onclick="deleteMoneyPost(${mp.id})" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                </div>
            </div>
            ${ahrefsHtml}
            <div class="mp-google-section">
                <div class="mp-tasks-header">
                    <span class="mp-tasks-label">Google Rank Tracking (site:reddit.com)</span>
                    <span style="display:flex;gap:4px;">
                        ${hasDolphin && keywords.length > 0 ? `<button class="btn btn-xs btn-ghost" onclick="autoCheckAllRanks(${mp.id})">Check All</button>` : ''}
                        <button class="btn btn-xs btn-ghost" onclick="addKeyword(${mp.id})">+ Add Keyword</button>
                    </span>
                </div>
                ${keywordsHtml || '<div class="empty-keywords">No keywords tracked. Add a keyword to monitor Google ranking.</div>'}
            </div>
            ${renderMoneyComment(mp)}
            ${renderRecommendations(mp.id, keywords)}
            <div class="mp-tasks">
                <div class="mp-tasks-header">
                    <span class="mp-tasks-label">Post Tasks (${activeTasks} active)</span>
                    <button class="btn btn-xs btn-ghost" onclick="openAddTask('post',${mp.id})">+ Task</button>
                </div>
                ${tasksHtml}
            </div>
        </div>`;
    }).join('');
}

// ==========================================
//  GOOGLE RANK TRACKING
// ==========================================
function addKeyword(mpId) {
    document.getElementById('kwMpId').value = mpId;
    document.getElementById('kwKeyword').value = '';
    document.getElementById('keywordModalTitle').textContent = 'Add Keyword to Track';
    openModal('keywordModal');
}

function saveKeyword() {
    const mpId = Number(document.getElementById('kwMpId').value);
    const keyword = document.getElementById('kwKeyword').value.trim();
    if (!keyword) return toast('warning', 'Enter a keyword', '');

    updateSub(sub => {
        const mp = sub.moneyPosts.find(p => p.id === mpId);
        if (!mp) return;
        if (!mp.googleKeywords) mp.googleKeywords = [];
        mp.googleKeywords.push({
            keyword,
            rank: null,
            rankType: null,
            avgRank: null,
            checks: [],
            history: [],
            updatedAt: new Date().toISOString()
        });
    });

    closeModal('keywordModal');
    renderDetail();
    toast('success', 'Keyword added', `"${keyword}" is now being tracked. Click the check icon to check its rank.`);
}

function updateKeywordRank(mpId, kwIndex) {
    const sub = getSub();
    const kw = sub?.moneyPosts?.find(p => p.id === mpId)?.googleKeywords?.[kwIndex];
    if (!kw) return;

    document.getElementById('ruMpId').value = mpId;
    document.getElementById('ruKwIndex').value = kwIndex;
    document.getElementById('ruKeywordLabel').textContent = `Rank for "${kw.keyword}"`;
    document.getElementById('ruRank').value = kw.rank || '';
    openModal('rankUpdateModal');
}

function saveRankUpdate() {
    const mpId = Number(document.getElementById('ruMpId').value);
    const kwIndex = Number(document.getElementById('ruKwIndex').value);
    const newRank = Number(document.getElementById('ruRank').value) || null;

    updateSub(s => {
        const k = s.moneyPosts.find(x => x.id === mpId)?.googleKeywords?.[kwIndex];
        if (!k) return;
        if (!k.history) k.history = [];
        if (k.rank) k.history.push({ rankType: k.rankType, avgRank: k.avgRank, date: k.updatedAt });
        k.rank = newRank;
        k.avgRank = newRank;
        k.updatedAt = new Date().toISOString();
    });

    closeModal('rankUpdateModal');
    renderDetail();
}

// ==========================================
//  MONEY COMMENT — Render
// ==========================================
function renderMoneyComment(mp) {
    const mc = mp.moneyComment;
    if (!mc?.commentId) {
        return `<div class="mp-money-comment-section">
            <div class="mp-tasks-header">
                <span class="mp-tasks-label">Money Comment</span>
                <button class="btn btn-xs btn-ghost" onclick="openSetMoneyComment(${mp.id})">+ Set Comment</button>
            </div>
            <div class="empty-keywords">No money comment set. Define which comment is your money comment to track its position.</div>
        </div>`;
    }

    const posClass = mc.position === 1 ? 'mc-pos-1' : mc.position && mc.position <= 3 ? 'mc-pos-top' : mc.position ? 'mc-pos-other' : 'mc-pos-unknown';
    const posText = mc.position ? `#${mc.position}` : '?';

    // Position history mini-chart
    const historyHtml = (mc.history || []).length > 0 ? `<div class="mc-history">
        ${mc.history.slice(-6).map(h => `<span class="mc-hist-entry ${h.position === 1 ? 'mc-pos-1' : h.position <= 3 ? 'mc-pos-top' : 'mc-pos-other'}" title="${fmtDate(h.date)}: #${h.position}">#${h.position}</span>`).join('')}
        <span class="mc-hist-entry ${posClass}" title="Now">${posText}</span>
    </div>` : '';

    return `<div class="mp-money-comment-section">
        <div class="mp-tasks-header">
            <span class="mp-tasks-label">Money Comment</span>
            <span style="display:flex;gap:4px;">
                <button class="btn btn-xs btn-ghost" onclick="checkMoneyCommentPosition(${mp.id})">Check Position</button>
                <button class="btn btn-xs btn-ghost" onclick="openSetMoneyComment(${mp.id})">Change</button>
            </span>
        </div>
        <div class="mc-card" onclick="checkMoneyCommentPosition(${mp.id})">
            <div class="mc-position ${posClass}">${posText}</div>
            <div class="mc-info">
                <div class="mc-author">u/${esc(mc.author || '?')} ${mc.upvotes ? `· ${fmtNumAlways(mc.upvotes)} upvotes` : ''} ${mc.replies ? `· ${mc.replies} replies` : ''}</div>
                ${mc.checkedAt ? `<div class="mc-checked">Last checked: ${fmtDate(mc.checkedAt)} · ${mc.totalTopLevel || '?'} top-level comments</div>` : ''}
            </div>
            ${historyHtml}
            <button class="btn-icon danger" onclick="event.stopPropagation();removeMoneyComment(${mp.id})" title="Remove" style="margin-left:auto;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    </div>`;
}

// ==========================================
//  SEO ADVISOR — Render Recommendations
// ==========================================
function renderRecommendations(mpId, keywords) {
    // Check if any keyword has recommendations
    const hasRecs = keywords.some(kw => kw.recommendations?.length);
    // Check if any keyword has competitors or pending competitors (meaning analysis is possible)
    const hasCompetitors = keywords.some(kw => kw.competitorAnalysis?.length || kw.pendingCompetitors?.length || kw.rankType);

    if (!hasRecs && !hasCompetitors) return '';

    // If recommendations exist, show them
    if (hasRecs) {
        const allRecs = [];
        keywords.forEach(kw => {
            if (kw.recommendations?.length) {
                allRecs.push(...kw.recommendations.map(r => ({ ...r, keyword: kw.keyword })));
            }
        });

        const priorityColors = {
            critical: 'rec-critical', high: 'rec-high', medium: 'rec-medium', low: 'rec-low', info: 'rec-info'
        };
        const priorityLabels = {
            critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO'
        };

        const collapsed = isRecsCollapsed(mpId);
        return `<div class="mp-recommendations">
            <div class="mp-tasks-header">
                <span class="mp-tasks-label rec-toggle" onclick="toggleRecs(${mpId})">
                    <svg class="rec-chevron ${collapsed ? '' : 'rec-chevron-open'}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                    SEO Advisor (${allRecs.length})
                </span>
                <span style="display:flex;gap:4px;">
                    <button class="btn btn-xs btn-ghost" onclick="refreshRecommendations(${mpId})">Refresh</button>
                    <button class="btn btn-xs btn-ghost danger" onclick="clearRecommendations(${mpId})">Clear</button>
                </span>
            </div>
            <div class="rec-body ${collapsed ? 'hidden' : ''}">
            ${allRecs.map((r, i) => `
                <div class="rec-item">
                    <span class="rec-priority ${priorityColors[r.priority]}">${priorityLabels[r.priority]}</span>
                    <div class="rec-content">
                        <div class="rec-category">${esc(r.category)}</div>
                        <div class="rec-action">${esc(r.action)}</div>
                        <div class="rec-detail">${esc(r.detail)}</div>
                        ${r.metric ? `<div class="rec-metric">${esc(r.metric)}</div>` : ''}
                    </div>
                    <button class="btn-icon rec-add-task" onclick="addRecAsTask(${mpId},'${esc(r.category).replace(/'/g, "\\'")}','${esc(r.action).replace(/'/g, "\\'")}')" title="Add as task">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                </div>
            `).join('')}
            </div>
        </div>`;
    }

    // No recommendations yet but competitors available — show "Check Recommendations" button
    return `<div class="mp-recommendations">
        <div class="mp-tasks-header">
            <span class="mp-tasks-label">SEO Advisor</span>
        </div>
        <div class="rec-check-prompt">
            <button class="btn btn-sm btn-primary" onclick="refreshRecommendations(${mpId})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                Check Recommendations
            </button>
            <span class="rec-check-hint">Analyze competitors and get actionable SEO advice</span>
        </div>
    </div>`;
}

// Clear all recommendations for a money post
function clearRecommendations(mpId) {
    updateSub(s => {
        const p = s.moneyPosts.find(x => x.id === mpId);
        if (!p?.googleKeywords) return;
        p.googleKeywords.forEach(kw => {
            delete kw.recommendations;
            delete kw.competitorAnalysis;
            delete kw.ourAnalysis;
            delete kw.pendingCompetitors;
        });
    });
    renderDetail();
    toast('success', 'Cleared', 'Recommendations removed');
}

// Toggle recommendations collapsed/expanded
const _recsCollapsed = {};
function isRecsCollapsed(mpId) { return !!_recsCollapsed[mpId]; }
function toggleRecs(mpId) {
    _recsCollapsed[mpId] = !_recsCollapsed[mpId];
    renderDetail();
}

// Manually trigger recommendation analysis for a money post
async function refreshRecommendations(mpId) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp?.googleKeywords?.length) return toast('warning', 'No keywords', 'Add keywords first to get recommendations.');

    toast('info', 'Analyzing...', 'Fetching competitor data for recommendations', 4000);

    const serpKey = getSerpApiKey();
    if (!serpKey) return toast('warning', 'Need SERP API', 'Set a SERP API key in Settings for recommendation analysis.');

    for (let i = 0; i < mp.googleKeywords.length; i++) {
        const kw = mp.googleKeywords[i];
        // Use pending competitors from last rank check if available
        if (kw.pendingCompetitors?.length) {
            await analyzeCompetitors(mpId, i, kw.pendingCompetitors, kw.rankType || 'none', kw.avgRank);
            updateSub(s => {
                const k = s.moneyPosts.find(x => x.id === mpId)?.googleKeywords?.[i];
                if (k) delete k.pendingCompetitors;
            });
        } else {
            // Fresh SERP check + analysis
            try {
                const data = await checkRankWithProxy(kw.keyword, mp.url, 0);
                if (data.competitors?.length) {
                    await analyzeCompetitors(mpId, i, data.competitors, data.type, data.rank || data.redditRank);
                }
            } catch (err) {
                toast('error', 'Analysis failed', err.message);
            }
        }
    }
}

// Add a recommendation as a task to the money post
function addRecAsTask(mpId, category, action) {
    const title = `[${category}] ${action}`;
    updateSub(sub => {
        const mp = sub.moneyPosts.find(p => p.id === mpId);
        if (!mp) return;
        if (!mp.tasks) mp.tasks = [];
        const id = mp.tasks.length ? Math.max(...mp.tasks.map(t => t.id)) + 1 : 1;
        mp.tasks.push({
            id,
            title,
            assigneeId: null,
            priority: 'High',
            status: 'To Do',
            dueDate: ''
        });
    });
    renderDetail();
    toast('success', 'Task added', title.slice(0, 50));
}

// ==========================================
//  SEO ADVISOR — Competitor Analysis
// ==========================================
async function analyzeCompetitors(mpId, kwIndex, competitors, rankType, rank) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp) return;

    try {
        const res = await fetch(`${SERVER}/api/analyze-competitors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                competitors,
                ourPost: { url: mp.url, rankType, rank, redditRank: rank }
            })
        });
        const data = await res.json();
        if (!data.success) return;

        // Save recommendations to the keyword
        updateSub(s => {
            const p = s.moneyPosts.find(x => x.id === mpId);
            const k = p?.googleKeywords?.[kwIndex];
            if (!k) return;
            k.recommendations = data.recommendations || [];
            k.competitorAnalysis = data.analyses || [];
            k.ourAnalysis = data.ourData;
        });

        renderDetail();

        if (data.recommendations?.length) {
            toast('info', 'SEO Advisor', `${data.recommendations.length} recommendations for "${mp.googleKeywords[kwIndex]?.keyword}"`, 5000);
        }
    } catch (e) {
        console.log('Competitor analysis failed:', e.message);
    }
}

// ==========================================
//  MONEY COMMENT TRACKING
// ==========================================
async function openSetMoneyComment(mpId) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp?.url) return toast('warning', 'No post URL', 'Add a post URL first.');

    document.getElementById('mcMpId').value = mpId;
    document.getElementById('mcCommentId').value = '';

    const status = document.getElementById('mcStatus');
    const listEl = document.getElementById('mcCommentList');

    status.className = 'fetch-status loading';
    status.innerHTML = '<span class="spinner"></span> Loading top comments...';
    listEl.innerHTML = '';

    openModal('moneyCommentModal');

    try {
        const res = await fetch(`${SERVER}/api/top-comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postUrl: mp.url })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (!data.comments?.length) {
            status.className = 'fetch-status error';
            status.textContent = 'No comments found on this post.';
            return;
        }

        status.className = 'fetch-status';
        status.textContent = 'Select your money comment:';

        const currentId = mp.moneyComment?.commentId;
        listEl.innerHTML = data.comments.map(c => {
            const isCurrent = c.id === currentId;
            const bodyPreview = c.body.replace(/\n/g, ' ').slice(0, 120);
            return `<div class="mc-pick ${isCurrent ? 'mc-pick-current' : ''}" onclick="pickMoneyComment(${mpId},'${c.id}')">
                <div class="mc-pick-pos">#${c.position}</div>
                <div class="mc-pick-body">
                    <div class="mc-pick-author">u/${esc(c.author)} · ${c.upvotes} upvotes · ${c.replies} replies${c.isStickied ? ' · pinned' : ''}</div>
                    <div class="mc-pick-text">${esc(bodyPreview)}${c.body.length > 120 ? '...' : ''}</div>
                </div>
                ${isCurrent ? '<span class="mc-pick-tag">CURRENT</span>' : ''}
            </div>`;
        }).join('');
    } catch (err) {
        status.className = 'fetch-status error';
        status.textContent = err.message;
    }
}

function pickMoneyComment(mpId, commentId) {
    updateSub(s => {
        const p = s.moneyPosts.find(x => x.id === mpId);
        if (!p) return;
        if (!p.moneyComment) p.moneyComment = {};
        p.moneyComment.commentId = commentId;
        p.moneyComment.setAt = new Date().toISOString();
        if (!p.moneyComment.history) p.moneyComment.history = [];
    });

    closeModal('moneyCommentModal');
    renderDetail();
    toast('success', 'Money comment set', 'Checking position...');
    checkMoneyCommentPosition(mpId);
}

async function checkMoneyCommentPosition(mpId) {
    const sub = getSub();
    const mp = sub?.moneyPosts?.find(p => p.id === mpId);
    if (!mp?.moneyComment?.commentId || !mp.url) return;

    try {
        const res = await fetch(`${SERVER}/api/check-comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postUrl: mp.url, commentId: mp.moneyComment.commentId })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        updateSub(s => {
            const p = s.moneyPosts.find(x => x.id === mpId);
            if (!p?.moneyComment) return;
            const mc = p.moneyComment;

            // Save to history
            if (mc.position) {
                if (!mc.history) mc.history = [];
                mc.history.push({
                    position: mc.position,
                    upvotes: mc.upvotes,
                    totalTopLevel: mc.totalTopLevel,
                    date: mc.checkedAt
                });
            }

            mc.position = data.position;
            mc.totalTopLevel = data.totalTopLevel;
            mc.upvotes = data.commentData?.upvotes || 0;
            mc.author = data.commentData?.author || '';
            mc.replies = data.commentData?.replies || 0;
            mc.checkedAt = new Date().toISOString();
        });

        renderDetail();

        // Silent when #1. Critical alert when not #1.
        if (data.position === 1) {
            toast('success', 'Comment is #1', `Holding top position · ${data.commentData?.upvotes || 0} upvotes`);
        } else if (data.position && data.position > 1) {
            toast('error',
                'CRITICAL: Money comment is NOT #1!',
                `Currently #${data.position}/${data.totalTopLevel}. Needs immediate action.`,
                0  // persistent — must be manually dismissed
            );
        } else {
            toast('error', 'Comment not found', 'Not in top 25 comments — check the comment ID', 0);
        }
    } catch (err) {
        toast('error', 'Check failed', err.message);
    }
}

function removeMoneyComment(mpId) {
    updateSub(s => {
        const p = s.moneyPosts.find(x => x.id === mpId);
        if (p) delete p.moneyComment;
    });
    renderDetail();
}

function removeKeyword(mpId, kwIndex) {
    updateSub(sub => {
        const mp = sub.moneyPosts.find(p => p.id === mpId);
        if (mp?.googleKeywords) mp.googleKeywords.splice(kwIndex, 1);
    });
    renderDetail();
}

// ==========================================
//  TASKS
// ==========================================
function openAddTask(type, parentId) {
    document.getElementById('taskType').value = type;
    document.getElementById('taskParentId').value = parentId || '';
    document.getElementById('taskModalTitle').textContent = type === 'post' ? 'Add Post Task' : 'Add Subreddit Task';
    populateAssigneeDropdown();
    openModal('taskModal');
}
function openAddSubredditTask() { openAddTask('sub', ''); }

function populateAssigneeDropdown() {
    const sel = document.getElementById('taskAssignee');
    const team = S.get('team');
    sel.innerHTML = '<option value="">Unassigned</option>' +
        team.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
}

function saveTask() {
    const editId = document.getElementById('taskEditId').value;
    const type = document.getElementById('taskType').value;
    const parentId = Number(document.getElementById('taskParentId').value) || null;
    const title = document.getElementById('taskTitle').value.trim();
    if (!title) return toast('warning', 'Missing title', 'Enter a task title.');

    const taskData = {
        title,
        assigneeId: Number(document.getElementById('taskAssignee').value) || null,
        priority: document.getElementById('taskPriority').value,
        status: document.getElementById('taskStatus').value,
        dueDate: document.getElementById('taskDueDate').value
    };

    updateSub(sub => {
        if (type === 'post') {
            const mp = (sub.moneyPosts || []).find(p => p.id === parentId);
            if (!mp) return;
            if (!mp.tasks) mp.tasks = [];
            if (editId) {
                const t = mp.tasks.find(t => t.id === Number(editId));
                if (t) Object.assign(t, taskData);
            } else {
                const id = mp.tasks.length ? Math.max(...mp.tasks.map(t => t.id)) + 1 : 1;
                mp.tasks.push({ id, ...taskData });
            }
        } else {
            if (!sub.tasks) sub.tasks = [];
            if (editId) {
                const t = sub.tasks.find(t => t.id === Number(editId));
                if (t) Object.assign(t, taskData);
            } else {
                const id = sub.tasks.length ? Math.max(...sub.tasks.map(t => t.id)) + 1 : 1;
                sub.tasks.push({ id, ...taskData });
            }
        }
    });
    closeModal('taskModal');
    // Re-render whichever view is active
    if (!document.getElementById('taskBoardView').classList.contains('hidden')) {
        renderTaskBoard();
    } else {
        renderDetail();
    }
}

function editTask(type, parentId, taskId) {
    const sub = getSub();
    if (!sub) return;
    let task;
    if (type === 'post') {
        task = (sub.moneyPosts || []).find(p => p.id === parentId)?.tasks?.find(t => t.id === taskId);
    } else {
        task = (sub.tasks || []).find(t => t.id === taskId);
    }
    if (!task) return;

    document.getElementById('taskEditId').value = task.id;
    document.getElementById('taskType').value = type;
    document.getElementById('taskParentId').value = parentId || '';
    document.getElementById('taskTitle').value = task.title;
    document.getElementById('taskPriority').value = task.priority;
    document.getElementById('taskStatus').value = task.status;
    document.getElementById('taskDueDate').value = task.dueDate || '';
    populateAssigneeDropdown();
    document.getElementById('taskAssignee').value = task.assigneeId || '';
    document.getElementById('taskModalTitle').textContent = 'Edit Task';
    openModal('taskModal');
}

function toggleTaskStatus(type, parentId, taskId) {
    updateSub(sub => {
        let task;
        if (type === 'post') {
            task = (sub.moneyPosts || []).find(p => p.id === parentId)?.tasks?.find(t => t.id === taskId);
        } else {
            task = (sub.tasks || []).find(t => t.id === taskId);
        }
        if (!task) return;
        if (task.status === 'Done') task.status = 'To Do';
        else if (task.status === 'To Do') task.status = 'In Progress';
        else task.status = 'Done';
    });
    renderDetail();
}

function deleteTask(type, parentId, taskId) {
    updateSub(sub => {
        if (type === 'post') {
            const mp = (sub.moneyPosts || []).find(p => p.id === parentId);
            if (mp) mp.tasks = (mp.tasks || []).filter(t => t.id !== taskId);
        } else {
            sub.tasks = (sub.tasks || []).filter(t => t.id !== taskId);
        }
    });
    renderDetail();
}

function renderTaskRow(task, type, parentId, team) {
    const member = team.find(m => m.id === task.assigneeId);
    const checkClass = task.status === 'Done' ? 'done' : task.status === 'In Progress' ? 'in-progress' : '';
    const titleClass = task.status === 'Done' ? 'done-text' : '';

    return `<div class="task-row">
        <div class="task-checkbox ${checkClass}" onclick="toggleTaskStatus('${type}',${parentId || 'null'},${task.id})"></div>
        <div class="task-content">
            <div class="task-title ${titleClass}">${esc(task.title)}</div>
            <div class="task-meta">
                ${task.priority ? `<span class="badge priority-${task.priority}">${task.priority}</span>` : ''}
                ${task.dueDate ? `<span>${task.dueDate}</span>` : ''}
                ${member ? `<span>${esc(member.name)}</span>` : ''}
            </div>
        </div>
        ${member ? `<div class="task-assignee-badge" style="background:${member.color || 'var(--primary)'}" title="${esc(member.name)}">${initials(member.name)}</div>` : ''}
        <div class="task-row-actions">
            <button class="btn-icon" onclick="editTask('${type}',${parentId || 'null'},${task.id})" title="Edit">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon danger" onclick="deleteTask('${type}',${parentId || 'null'},${task.id})" title="Delete">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
        </div>
    </div>`;
}

let currentTaskView = localStorage.getItem('lk_task_view') || 'list';

function setTaskView(view) {
    currentTaskView = view;
    localStorage.setItem('lk_task_view', view);
    document.getElementById('listViewBtn').classList.toggle('active', view === 'list');
    document.getElementById('kanbanViewBtn').classList.toggle('active', view === 'kanban');
    const sub = getSub();
    if (sub) renderSubredditTasks(sub);
}

function renderSubredditTasks(sub) {
    const list = document.getElementById('subredditTasksList');
    const kanban = document.getElementById('kanbanBoard');
    const empty = document.getElementById('emptySubTasks');
    const tasks = sub.tasks || [];
    const team = S.get('team');

    // Update toggle buttons
    document.getElementById('listViewBtn')?.classList.toggle('active', currentTaskView === 'list');
    document.getElementById('kanbanViewBtn')?.classList.toggle('active', currentTaskView === 'kanban');

    if (tasks.length === 0) {
        list.innerHTML = '';
        kanban.classList.add('hidden');
        list.style.display = 'none';
        empty.classList.add('show');
        return;
    }

    empty.classList.remove('show');

    if (currentTaskView === 'kanban') {
        list.style.display = 'none';
        kanban.classList.remove('hidden');
        renderKanban(tasks, team);
    } else {
        kanban.classList.add('hidden');
        list.style.display = '';
        // List view with drag-and-drop
        list.innerHTML = tasks.map((t, i) => {
            const row = renderTaskRow(t, 'sub', null, team);
            // Add draggable + data attributes
            return row.replace('<div class="task-row">', `<div class="task-row" draggable="true" data-task-index="${i}" ondragstart="taskDragStart(event,${i})" ondragover="taskDragOver(event,${i})" ondragend="taskDragEnd(event)" ondrop="taskDrop(event,${i})">`);
        }).join('');
    }
}

// ==========================================
//  KANBAN BOARD
// ==========================================
function renderKanban(tasks, team) {
    const buckets = { 'To Do': [], 'In Progress': [], 'Done': [] };
    tasks.forEach(t => {
        const status = t.status || 'To Do';
        if (buckets[status]) buckets[status].push(t);
        else buckets['To Do'].push(t);
    });

    for (const [status, items] of Object.entries(buckets)) {
        const colId = status === 'To Do' ? 'kanbanTodo' : status === 'In Progress' ? 'kanbanProgress' : 'kanbanDone';
        const countId = status === 'To Do' ? 'kanbanCountTodo' : status === 'In Progress' ? 'kanbanCountProgress' : 'kanbanCountDone';

        document.getElementById(countId).textContent = items.length;
        document.getElementById(colId).innerHTML = items.map(t => {
            const member = team.find(m => m.id === t.assigneeId);
            return `<div class="kanban-card" draggable="true" data-task-id="${t.id}"
                ondragstart="kanbanCardDragStart(event,${t.id})" ondragend="kanbanCardDragEnd(event)">
                <div class="kanban-card-title">${esc(t.title)}</div>
                <div class="kanban-card-meta">
                    ${t.priority ? `<span class="badge priority-${t.priority}">${t.priority}</span>` : ''}
                    ${t.dueDate ? `<span>${t.dueDate}</span>` : ''}
                    ${member ? `<div class="kanban-card-assignee" style="background:${member.color || 'var(--primary)'}">${initials(member.name)}</div>` : ''}
                </div>
            </div>`;
        }).join('') || '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:11px;">Drop tasks here</div>';
    }
}

let kanbanDragId = null;

function kanbanCardDragStart(e, taskId) {
    kanbanDragId = taskId;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function kanbanCardDragEnd(e) {
    e.target.classList.remove('dragging');
}

function kanbanDrop(e) {
    e.preventDefault();
    if (kanbanDragId == null) return;

    const col = e.target.closest('.kanban-col');
    if (!col) return;
    const newStatus = col.dataset.status;

    updateSub(sub => {
        const task = (sub.tasks || []).find(t => t.id === kanbanDragId);
        if (task) task.status = newStatus;
    });

    kanbanDragId = null;
    renderDetail();
}

// ==========================================
//  LIST DRAG & DROP (reorder tasks)
// ==========================================
let dragTaskIndex = null;

function taskDragStart(e, index) {
    dragTaskIndex = index;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function taskDragOver(e, index) {
    e.preventDefault();
    if (dragTaskIndex === null || dragTaskIndex === index) return;
    document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drag-target'));
    e.target.closest('.task-row')?.classList.add('drag-target');
}

function taskDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drag-target'));
}

function taskDrop(e, targetIndex) {
    e.preventDefault();
    if (dragTaskIndex === null || dragTaskIndex === targetIndex) return;

    updateSub(sub => {
        if (!sub.tasks) return;
        const [moved] = sub.tasks.splice(dragTaskIndex, 1);
        sub.tasks.splice(targetIndex, 0, moved);
    });

    dragTaskIndex = null;
    renderDetail();
}

// ==========================================
//  MONEY POST DRAG & DROP (reorder)
// ==========================================
let dragMpIndex = null;

function mpDragStart(e, index) {
    dragMpIndex = index;
    e.target.closest('.money-post-item')?.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function mpDragOver(e, index) {
    e.preventDefault();
    if (dragMpIndex === null || dragMpIndex === index) return;
}

function mpDragEnd(e) {
    document.querySelectorAll('.money-post-item').forEach(el => el.classList.remove('dragging'));
}

function mpDrop(e, targetIndex) {
    e.preventDefault();
    if (dragMpIndex === null || dragMpIndex === targetIndex) return;

    updateSub(sub => {
        if (!sub.moneyPosts) return;
        const sorted = sub.moneyPosts.sort((a, b) => (a.rank || 999) - (b.rank || 999));
        const [moved] = sorted.splice(dragMpIndex, 1);
        sorted.splice(targetIndex, 0, moved);
        // Update ranks based on new order
        sorted.forEach((mp, i) => mp.rank = i + 1);
        sub.moneyPosts = sorted;
    });

    dragMpIndex = null;
    renderDetail();
}

// ==========================================
//  TEAM
// ==========================================
function openTeamPanel() { renderTeamList(); openModal('teamModal'); }

function renderTeamList() {
    const team = S.get('team');
    const el = document.getElementById('teamList');
    if (team.length === 0) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No team members yet.</p>';
        return;
    }
    el.innerHTML = team.map(m => `<div class="team-row">
        <div class="team-row-avatar" style="background:${m.color || 'var(--primary)'}">${initials(m.name)}</div>
        <div class="team-row-info"><strong>${esc(m.name)}</strong><span>${esc(m.role) || ''}</span></div>
        <button class="btn-icon danger" onclick="deleteTeamMember(${m.id})" title="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
    </div>`).join('');
}

function addTeamMember() {
    const name = document.getElementById('newMemberName').value.trim();
    const role = document.getElementById('newMemberRole').value.trim();
    if (!name) return;
    const colors = ['#FF4500','#0079D3','#46D160','#FFB000','#EA0027','#7193FF','#0DD3BB','#FF6934'];
    let team = S.get('team');
    team.push({ id: team.length ? Math.max(...team.map(m => m.id)) + 1 : 1, name, role, color: colors[team.length % colors.length] });
    S.set('team', team);
    document.getElementById('newMemberName').value = '';
    document.getElementById('newMemberRole').value = '';
    renderTeamList();
}

function deleteTeamMember(id) {
    S.set('team', S.get('team').filter(m => m.id !== id));
    renderTeamList();
}

// ==========================================
//  DELETE CONFIRM
// ==========================================
let pendingDeleteFn = null;
function confirmDelete(msg, fn) {
    document.getElementById('deleteMessage').textContent = msg;
    pendingDeleteFn = fn;
    openModal('deleteModal');
}
document.getElementById('deleteConfirmBtn').addEventListener('click', () => {
    if (pendingDeleteFn) { pendingDeleteFn(); pendingDeleteFn = null; }
    closeModal('deleteModal');
});

// ==========================================
//  AUTO-REFRESH (followers + post stats)
// ==========================================
let autoRefreshInterval = null;
let moneyCommentInterval = null;

function startAutoRefresh() {
    if (autoRefreshInterval) return;
    // Refresh followers + posts every 5 minutes
    autoRefreshInterval = setInterval(autoRefreshAll, 5 * 60 * 1000);
    // Money comment check every hour
    moneyCommentInterval = setInterval(autoCheckAllMoneyComments, 60 * 60 * 1000);
    // Run followers after 10 seconds, money comments after 30 seconds on load
    setTimeout(autoRefreshAll, 10000);
    setTimeout(autoCheckAllMoneyComments, 30000);
}

async function autoRefreshAll() {
    const subs = S.get('subreddits');
    if (!subs.length) return;

    for (const sub of subs) {
        try {
            const data = await redditFetch(`/r/${sub.name}/about.json`);
            const rd = data.data;
            let changed = false;

            let allSubs = S.get('subreddits');
            const idx = allSubs.findIndex(s => s.id === sub.id);
            if (idx === -1) continue;
            const s = allSubs[idx];

            // Update followers
            const newCount = rd.subscribers || 0;
            if (!s.followerHistory) s.followerHistory = [];
            const last = s.followerHistory.length ? s.followerHistory[s.followerHistory.length - 1] : null;
            if (!last || last.count !== newCount) {
                s.followerHistory.push({ count: newCount, date: new Date().toISOString() });
                changed = true;
            }

            // Update images/description
            s.bannerImg = cleanImgUrl(rd.banner_background_image || rd.banner_img || s.bannerImg || '');
            s.iconImg = cleanImgUrl(rd.community_icon || rd.icon_img || s.iconImg || '');
            s.description = rd.public_description || rd.title || s.description;

            S.set('subreddits', allSubs);

            // Refresh money post stats
            for (const mp of (s.moneyPosts || [])) {
                if (!mp.url) continue;
                const parsed = parsePostUrl(mp.url);
                if (!parsed) continue;
                try {
                    const postData = await redditFetch(`/comments/${parsed.postId}.json`);
                    const post = postData[0].data.children[0].data;
                    allSubs = S.get('subreddits');
                    const si = allSubs.findIndex(x => x.id === sub.id);
                    const p = allSubs[si]?.moneyPosts?.find(x => x.id === mp.id);
                    if (p) {
                        const oldUp = p.upvotes;
                        p.upvotes = post.ups || post.score || p.upvotes;
                        p.comments = post.num_comments || p.comments;
                        if (p.upvotes !== oldUp) {
                            if (!p.history) p.history = [];
                            p.history.push({ upvotes: p.upvotes, comments: p.comments, date: new Date().toISOString() });
                        }
                        S.set('subreddits', allSubs);
                    }
                } catch {}
                // Small delay between post fetches
                await new Promise(r => setTimeout(r, 1000));
            }

            if (changed) console.log(`[Auto] Updated r/${sub.name}: ${newCount} followers`);
        } catch (e) {
            console.log(`[Auto] Failed r/${sub.name}: ${e.message}`);
        }
        // Delay between subreddits
        await new Promise(r => setTimeout(r, 2000));
    }

    // Re-render current view
    if (currentSubId) renderDetail();
    else renderHome();
}

// ==========================================
//  TASK BOARD — Global task management
// ==========================================
let tbView = localStorage.getItem('lk_tb_view') || 'kanban';

function openTaskBoard() {
    currentSubId = null;
    document.getElementById('homeView').classList.add('hidden');
    document.getElementById('detailView').classList.add('hidden');
    document.getElementById('taskBoardView').classList.remove('hidden');
    document.getElementById('addSubredditBtn').classList.add('hidden');
    populateTbFilters();
    renderTaskBoard();
}

function setTbView(view) {
    tbView = view;
    localStorage.setItem('lk_tb_view', view);
    document.getElementById('tbListBtn').classList.toggle('active', view === 'list');
    document.getElementById('tbKanbanBtn').classList.toggle('active', view === 'kanban');
    renderTaskBoard();
}

function populateTbFilters() {
    const subs = S.get('subreddits');
    const team = S.get('team');

    const subSel = document.getElementById('tbFilterSub');
    subSel.innerHTML = '<option value="">All Subreddits</option>' +
        subs.map(s => `<option value="${s.id}">r/${esc(s.name)}</option>`).join('');

    const assigneeSel = document.getElementById('tbFilterAssignee');
    assigneeSel.innerHTML = '<option value="">All Assignees</option><option value="0">Unassigned</option>' +
        team.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
}

// Gather ALL tasks from all subreddits into a flat array with context
function gatherAllTasks() {
    const subs = S.get('subreddits');
    const tasks = [];

    subs.forEach(sub => {
        // Subreddit-level tasks
        (sub.tasks || []).forEach(t => {
            tasks.push({
                ...t,
                subId: sub.id,
                subName: sub.name,
                type: 'sub',
                parentId: null,
                postTitle: null,
                _key: `s${sub.id}_t${t.id}`
            });
        });
        // Post-level tasks
        (sub.moneyPosts || []).forEach(mp => {
            (mp.tasks || []).forEach(t => {
                tasks.push({
                    ...t,
                    subId: sub.id,
                    subName: sub.name,
                    type: 'post',
                    parentId: mp.id,
                    postTitle: mp.title,
                    _key: `s${sub.id}_p${mp.id}_t${t.id}`
                });
            });
        });
    });

    return tasks;
}

function filterAndSortTasks(tasks) {
    const filterSub = document.getElementById('tbFilterSub')?.value || '';
    const filterAssignee = document.getElementById('tbFilterAssignee')?.value || '';
    const filterPriority = document.getElementById('tbFilterPriority')?.value || '';
    const filterStatus = document.getElementById('tbFilterStatus')?.value || '';
    const sortBy = document.getElementById('tbSortBy')?.value || 'priority';

    let filtered = tasks;
    if (filterSub) filtered = filtered.filter(t => t.subId === Number(filterSub));
    if (filterAssignee === '0') filtered = filtered.filter(t => !t.assigneeId);
    else if (filterAssignee) filtered = filtered.filter(t => t.assigneeId === Number(filterAssignee));
    if (filterPriority) filtered = filtered.filter(t => t.priority === filterPriority);
    if (filterStatus) filtered = filtered.filter(t => t.status === filterStatus);

    const priorityOrder = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
    const statusOrder = { 'To Do': 0, 'In Progress': 1, 'Done': 2 };

    filtered.sort((a, b) => {
        if (sortBy === 'priority') return (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
        if (sortBy === 'dueDate') {
            if (!a.dueDate && !b.dueDate) return 0;
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            return a.dueDate.localeCompare(b.dueDate);
        }
        if (sortBy === 'status') return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
        if (sortBy === 'assignee') return (a.assigneeId || 999) - (b.assigneeId || 999);
        if (sortBy === 'subreddit') return a.subName.localeCompare(b.subName);
        return 0;
    });

    return filtered;
}

function renderTaskBoard() {
    const team = S.get('team');
    const allTasks = gatherAllTasks();
    const tasks = filterAndSortTasks(allTasks);

    const active = allTasks.filter(t => t.status !== 'Done').length;
    const done = allTasks.filter(t => t.status === 'Done').length;
    document.getElementById('tbCount').textContent = `${active} active · ${done} done · ${allTasks.length} total`;

    if (tbView === 'kanban') {
        document.getElementById('tbList').classList.add('hidden');
        document.getElementById('tbKanban').classList.remove('hidden');
        renderTbKanban(tasks, team);
    } else {
        document.getElementById('tbKanban').classList.add('hidden');
        document.getElementById('tbList').classList.remove('hidden');
        renderTbList(tasks, team);
    }

    document.getElementById('tbListBtn').classList.toggle('active', tbView === 'list');
    document.getElementById('tbKanbanBtn').classList.toggle('active', tbView === 'kanban');
}

function tbTaskCard(t, team, showStatus) {
    const member = team.find(m => m.id === t.assigneeId);
    const isOverdue = t.dueDate && t.status !== 'Done' && t.dueDate < new Date().toISOString().slice(0, 10);
    const isDueSoon = t.dueDate && t.status !== 'Done' && !isOverdue && t.dueDate <= new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const doneClass = t.status === 'Done' ? 'tb-card-done' : '';

    return `<div class="tb-card ${doneClass}" draggable="true" data-key="${t._key}"
        ondragstart="tbDragStart(event,'${t._key}')" ondragend="tbDragEnd(event)">
        <div class="tb-card-top">
            <span class="badge priority-${t.priority}" style="font-size:9px;">${t.priority}</span>
            ${showStatus ? `<span class="tb-card-status tb-status-${t.status.replace(/\s/g, '')}">${t.status}</span>` : ''}
            <span class="tb-card-sub">r/${esc(t.subName)}</span>
        </div>
        <div class="tb-card-title ${t.status === 'Done' ? 'done-text' : ''}">${esc(t.title)}</div>
        ${t.postTitle ? `<div class="tb-card-post" title="${esc(t.postTitle)}">Post: ${esc(t.postTitle.length > 35 ? t.postTitle.slice(0, 32) + '...' : t.postTitle)}</div>` : ''}
        <div class="tb-card-bottom">
            ${t.dueDate ? `<span class="tb-card-due ${isOverdue ? 'overdue' : isDueSoon ? 'due-soon' : ''}">${isOverdue ? 'OVERDUE ' : ''}${fmtDate(t.dueDate)}</span>` : '<span></span>'}
            <div class="tb-card-right">
                <button class="btn-icon" onclick="tbEditTask('${t._key}')" title="Edit">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                ${member ? `<div class="tb-card-assignee" style="background:${member.color || 'var(--primary)'}" title="${esc(member.name)}">${initials(member.name)}</div>` : ''}
            </div>
        </div>
    </div>`;
}

function renderTbList(tasks, team) {
    const list = document.getElementById('tbList');
    if (!tasks.length) {
        list.innerHTML = '<div class="tb-empty">No tasks match your filters</div>';
        return;
    }
    list.innerHTML = tasks.map(t => tbTaskCard(t, team, true)).join('');
}

function renderTbKanban(tasks, team) {
    const buckets = { 'To Do': [], 'In Progress': [], 'Done': [] };
    tasks.forEach(t => {
        if (buckets[t.status]) buckets[t.status].push(t);
        else buckets['To Do'].push(t);
    });

    document.getElementById('tbKcTodo').textContent = buckets['To Do'].length;
    document.getElementById('tbKcProgress').textContent = buckets['In Progress'].length;
    document.getElementById('tbKcDone').textContent = buckets['Done'].length;

    document.getElementById('tbKbTodo').innerHTML = buckets['To Do'].map(t => tbTaskCard(t, team, false)).join('') || '<div class="tb-empty-col">No tasks</div>';
    document.getElementById('tbKbProgress').innerHTML = buckets['In Progress'].map(t => tbTaskCard(t, team, false)).join('') || '<div class="tb-empty-col">No tasks</div>';
    document.getElementById('tbKbDone').innerHTML = buckets['Done'].map(t => tbTaskCard(t, team, false)).join('') || '<div class="tb-empty-col">No tasks</div>';
}

// Drag-and-drop on task board kanban
let tbDragKey = null;

function tbDragStart(e, key) {
    tbDragKey = key;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function tbDragEnd(e) {
    e.target.classList.remove('dragging');
}

function tbKanbanDrop(e) {
    e.preventDefault();
    if (!tbDragKey) return;

    const col = e.target.closest('.tb-kanban-col');
    if (!col) return;
    const newStatus = col.dataset.status;

    // Parse key to find the task: s{subId}_t{taskId} or s{subId}_p{mpId}_t{taskId}
    const keyMatch = tbDragKey.match(/^s(\d+)(?:_p(\d+))?_t(\d+)$/);
    if (!keyMatch) return;

    const subId = Number(keyMatch[1]);
    const mpId = keyMatch[2] ? Number(keyMatch[2]) : null;
    const taskId = Number(keyMatch[3]);

    let subs = S.get('subreddits');
    const sub = subs.find(s => s.id === subId);
    if (!sub) return;

    if (mpId) {
        const mp = (sub.moneyPosts || []).find(p => p.id === mpId);
        const task = mp?.tasks?.find(t => t.id === taskId);
        if (task) task.status = newStatus;
    } else {
        const task = (sub.tasks || []).find(t => t.id === taskId);
        if (task) task.status = newStatus;
    }

    S.set('subreddits', subs);
    tbDragKey = null;
    renderTaskBoard();
}

// Edit task from task board
function tbEditTask(key) {
    const keyMatch = key.match(/^s(\d+)(?:_p(\d+))?_t(\d+)$/);
    if (!keyMatch) return;

    const subId = Number(keyMatch[1]);
    const mpId = keyMatch[2] ? Number(keyMatch[2]) : null;
    const taskId = Number(keyMatch[3]);

    // Temporarily set currentSubId for editTask to work
    const prevSubId = currentSubId;
    currentSubId = subId;

    if (mpId) {
        editTask('post', mpId, taskId);
    } else {
        editTask('sub', null, taskId);
    }

    // Override the save to return to task board
    const origSave = window._origSaveTask;
    if (!origSave) {
        window._origSaveTask = saveTask;
    }
    // We'll handle re-render in the patched goHome
}

// Add global task — pick subreddit first
function openAddGlobalTask() {
    const subs = S.get('subreddits');
    if (!subs.length) return toast('warning', 'No subreddits', 'Add a subreddit first.');

    // If only one subreddit, use it directly
    if (subs.length === 1) {
        currentSubId = subs[0].id;
        openAddTask('sub', '');
        return;
    }

    // Build quick picker
    const picker = document.getElementById('tbSubPicker');
    if (picker) picker.remove();

    const div = document.createElement('div');
    div.id = 'tbSubPicker';
    div.className = 'modal-overlay active';
    div.onclick = e => { if (e.target === div) div.remove(); };
    div.innerHTML = `<div class="modal modal-sm">
        <div class="modal-header">
            <h3>Add Task to...</h3>
            <button class="modal-close" onclick="document.getElementById('tbSubPicker').remove()">&times;</button>
        </div>
        <div class="modal-body">
            ${subs.map(s => `<button class="btn btn-ghost" style="width:100%;justify-content:flex-start;margin-bottom:4px;" onclick="document.getElementById('tbSubPicker').remove();currentSubId=${s.id};openAddTask('sub','')">r/${esc(s.name)}</button>`).join('')}
        </div>
    </div>`;
    document.body.appendChild(div);
}

// Override goHome to handle returning from task board
const _origGoHome = goHome;
goHome = function() {
    document.getElementById('taskBoardView').classList.add('hidden');
    _origGoHome();
};

// Also patch openSubreddit to hide task board
const _origOpenSub = openSubreddit;
openSubreddit = function(id) {
    document.getElementById('taskBoardView').classList.add('hidden');
    _origOpenSub(id);
};

// ==========================================
//  HOURLY MONEY COMMENT CHECK
// ==========================================
async function autoCheckAllMoneyComments() {
    const subs = S.get('subreddits');
    if (!subs.length) return;

    for (const sub of subs) {
        for (const mp of (sub.moneyPosts || [])) {
            if (!mp.moneyComment?.commentId || !mp.url) continue;

            try {
                const mcRes = await fetch(`${SERVER}/api/check-comment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ postUrl: mp.url, commentId: mp.moneyComment.commentId })
                });
                const mcData = await mcRes.json();
                if (!mcData.success) continue;

                let allSubs = S.get('subreddits');
                const si = allSubs.findIndex(x => x.id === sub.id);
                const p = allSubs[si]?.moneyPosts?.find(x => x.id === mp.id);
                if (!p?.moneyComment) continue;

                const mc = p.moneyComment;
                const oldPos = mc.position;

                // Save current to history
                if (mc.position) {
                    if (!mc.history) mc.history = [];
                    mc.history.push({
                        position: mc.position, upvotes: mc.upvotes,
                        totalTopLevel: mc.totalTopLevel, date: mc.checkedAt
                    });
                }

                mc.position = mcData.position;
                mc.totalTopLevel = mcData.totalTopLevel;
                mc.upvotes = mcData.commentData?.upvotes || 0;
                mc.author = mcData.commentData?.author || '';
                mc.replies = mcData.commentData?.replies || 0;
                mc.checkedAt = new Date().toISOString();
                S.set('subreddits', allSubs);

                // CRITICAL ALERT if lost #1 — persistent toast, no auto-dismiss
                if (mcData.position && mcData.position > 1) {
                    toast('error',
                        'CRITICAL: Money comment lost #1!',
                        `"${p.title?.slice(0, 40)}..." in r/${sub.name} dropped to #${mcData.position}. Was ${oldPos ? '#' + oldPos : 'unchecked'}. Immediate action needed.`,
                        0  // 0 = no auto-dismiss, stays until manually closed
                    );
                }

                console.log(`[MC] r/${sub.name} "${p.title?.slice(0, 30)}": comment #${mcData.position || '?'}/${mcData.totalTopLevel}`);
            } catch (err) {
                console.log(`[MC] Failed for post ${mp.id}: ${err.message}`);
            }

            // Delay between checks
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // Re-render if viewing a subreddit
    if (currentSubId) renderDetail();
}

// ==========================================
//  INIT
// ==========================================
// Pull shared data from server, then render
S.pullFromServer().then(() => {
    renderHome();
    startAutoRefresh();
});
