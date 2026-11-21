// ============================================================
//  Proxy-Seller residential API client.
//  Lets the checker self-provision proxies instead of pasting lists.
//  Each "list" = one login into res.proxy-seller.com ports 10000-10999;
//  each (login, port) is a distinct sticky residential exit IP, so
//  N lists  =>  up to N*1000 distinct concurrent exits.
//  API key lives in data.json keys.lk_proxyseller_key (read at runtime).
//  Residential is metered by BANDWIDTH (GB) + a package expiry; creating
//  a list is free (only traffic used is billed). No endpoint buys capacity.
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

const DATA_FILE = path.join(__dirname, 'data.json');
const HOST = 'res.proxy-seller.com';
const PORT_MIN = 10000, PORT_MAX = 10999; // 1000 ports per login

function apiKey() {
    try {
        const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return ((d.keys && d.keys.lk_proxyseller_key) || '').trim();
    } catch { return ''; }
}
function base() {
    const k = apiKey();
    if (!k) throw new Error('no proxy-seller api key (set data.json keys.lk_proxyseller_key)');
    return 'https://proxy-seller.com/personal/api/v1/' + k + '/resident';
}
async function curlJson(args) {
    const { stdout } = await pexec('curl', ['-s', '--max-time', '45', ...args], { maxBuffer: 20 * 1024 * 1024 });
    let j;
    try { j = JSON.parse(stdout); } catch { throw new Error('proxy-seller: bad JSON (' + String(stdout).slice(0, 120) + ')'); }
    if (j.status && j.status !== 'success') throw new Error('proxy-seller api: ' + JSON.stringify(j.errors || j.status).slice(0, 200));
    return j.data;
}
const apiGet = (p) => curlJson([base() + p]);
const apiPost = (p, body) => curlJson(['-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify(body), base() + p]);
const apiDelete = (p, body) => curlJson(['-X', 'DELETE', '-H', 'Content-Type: application/json', '-d', JSON.stringify(body || {}), base() + p]);

async function getPackage() {
    const d = await apiGet('/package');
    const left = Number(d.traffic_left || 0), limit = Number(d.traffic_limit || 0), used = Number(d.traffic_usage || 0);
    return {
        trafficLeftBytes: left,
        trafficLeftGB: +(left / 1e9).toFixed(2),
        trafficLimitGB: +(limit / 1e9).toFixed(2),
        trafficUsedGB: +(used / 1e9).toFixed(2),
        expiredAt: d.expired_at, active: !!d.is_active, autoRenew: !!d.auto_renew,
    };
}
async function getLists() {
    const d = await apiGet('/lists');
    const rows = Array.isArray(d) ? d : (d && (d.items || d.lists)) || [];
    return rows.map(r => ({ id: r.id, title: r.title, login: r.login, password: r.password, geo: r.geo, rotation: r.rotation }));
}
// Best-effort create (verified against the live API before relying on it).
async function createList(title, country) {
    const body = { title, whitelist: '', rotation: -1, geo: [{ country: country || 'US', region: '', city: '', isp: '' }], export: { ports: PORT_MAX - PORT_MIN + 1, ext: 'txt' } };
    const d = await apiPost('/list/add', body);
    const id = d && (d.id || (d.list && d.list.id));
    const lists = await getLists();
    return lists.find(l => (id ? l.id === id : l.title === title)) || null;
}
async function deleteList(id) { return apiDelete('/list/delete', { id }); }

// Expand a list login into one proxy spec per port (1000 distinct sticky exits).
function entriesForList(list) {
    const out = [];
    for (let port = PORT_MIN; port <= PORT_MAX; port++) out.push({ host: HOST, port, user: list.login, pass: list.password });
    return out;
}

module.exports = { getPackage, getLists, createList, deleteList, entriesForList, apiKey, HOST, PORT_MIN, PORT_MAX };
