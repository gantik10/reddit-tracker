"""
Web dashboard for JAP Sync tool.
Shows current mappings, pending changes, and change history.
"""
from flask import Flask, render_template_string, jsonify
from database import get_all_mappings, get_pending_changes, get_change_history, get_recent_orders
from config import DASHBOARD_PORT

app = Flask(__name__)

TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JAP Service Sync</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f1923;
            color: #e0e6ed;
            min-height: 100vh;
        }
        .header {
            background: linear-gradient(135deg, #1a2a3a 0%, #0f1923 100%);
            border-bottom: 1px solid #2a3a4a;
            padding: 20px 30px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .header h1 { font-size: 22px; color: #fff; }
        .header .status {
            display: flex;
            gap: 20px;
            align-items: center;
        }
        .stat {
            background: #1a2a3a;
            border: 1px solid #2a3a4a;
            border-radius: 8px;
            padding: 8px 16px;
            text-align: center;
        }
        .stat .num { font-size: 24px; font-weight: 700; color: #4fc3f7; }
        .stat .label { font-size: 11px; color: #8899aa; text-transform: uppercase; }
        .container { padding: 20px 30px; }
        .tabs {
            display: flex;
            gap: 2px;
            margin-bottom: 20px;
            background: #1a2a3a;
            border-radius: 8px;
            overflow: hidden;
            width: fit-content;
        }
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            background: transparent;
            border: none;
            color: #8899aa;
            font-size: 14px;
            transition: all 0.2s;
        }
        .tab.active { background: #2a4a6a; color: #fff; }
        .tab:hover { color: #fff; }
        .panel { display: none; }
        .panel.active { display: block; }
        table {
            width: 100%;
            border-collapse: collapse;
            background: #1a2a3a;
            border-radius: 8px;
            overflow: hidden;
        }
        th {
            background: #0f1923;
            padding: 12px 16px;
            text-align: left;
            font-size: 12px;
            text-transform: uppercase;
            color: #6688aa;
            border-bottom: 1px solid #2a3a4a;
        }
        td {
            padding: 10px 16px;
            border-bottom: 1px solid #1f2f3f;
            font-size: 13px;
        }
        tr:hover { background: #1f2f3f; }
        .badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
        }
        .badge-green { background: #1b5e20; color: #81c784; }
        .badge-yellow { background: #f57f17; color: #fff; }
        .badge-red { background: #b71c1c; color: #ef9a9a; }
        .badge-blue { background: #0d47a1; color: #90caf9; }
        .change-arrow { color: #ff9800; font-weight: bold; }
        .refresh-btn {
            background: #2a4a6a;
            border: 1px solid #3a5a7a;
            color: #fff;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
        }
        .refresh-btn:hover { background: #3a5a7a; }
        .empty { text-align: center; padding: 40px; color: #6688aa; }
        .link-cell {
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .link-cell a { color: #4fc3f7; text-decoration: none; }
        .link-cell a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <h1>JAP Service Sync</h1>
        <div class="status">
            <div class="stat">
                <div class="num" id="mappings-count">--</div>
                <div class="label">Tracked Services</div>
            </div>
            <div class="stat">
                <div class="num" id="pending-count">--</div>
                <div class="label">Pending Changes</div>
            </div>
            <div class="stat">
                <div class="num" id="history-count">--</div>
                <div class="label">Total Changes</div>
            </div>
            <button class="refresh-btn" onclick="loadAll()">Refresh</button>
        </div>
    </div>

    <div class="container">
        <div class="tabs">
            <button class="tab active" onclick="showTab('mappings')">Current Mappings</button>
            <button class="tab" onclick="showTab('pending')">Pending Changes</button>
            <button class="tab" onclick="showTab('history')">Change History</button>
            <button class="tab" onclick="showTab('orders-pg')">PanelGram Orders</button>
            <button class="tab" onclick="showTab('orders-jap')">JAP Orders</button>
        </div>

        <div class="panel active" id="panel-mappings">
            <table>
                <thead>
                    <tr>
                        <th>PG Service</th>
                        <th>PG ID</th>
                        <th>JAP Service ID</th>
                        <th>JAP Service Name</th>
                        <th>CrushLikes ID</th>
                        <th>Last Updated</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody id="mappings-body"></tbody>
            </table>
        </div>

        <div class="panel" id="panel-pending">
            <table>
                <thead>
                    <tr>
                        <th>PG Service</th>
                        <th>Current JAP ID</th>
                        <th></th>
                        <th>New JAP ID</th>
                        <th>New JAP Name</th>
                        <th>Orders</th>
                        <th>First Seen</th>
                        <th>Last Seen</th>
                    </tr>
                </thead>
                <tbody id="pending-body"></tbody>
            </table>
        </div>

        <div class="panel" id="panel-history">
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>PG Service</th>
                        <th>Old JAP ID</th>
                        <th></th>
                        <th>New JAP ID</th>
                        <th>New JAP Name</th>
                        <th>CrushLikes Updated</th>
                    </tr>
                </thead>
                <tbody id="history-body"></tbody>
            </table>
        </div>

        <div class="panel" id="panel-orders-pg">
            <table>
                <thead>
                    <tr>
                        <th>Order ID</th>
                        <th>Date</th>
                        <th>Service</th>
                        <th>Link</th>
                        <th>Qty</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody id="orders-pg-body"></tbody>
            </table>
        </div>

        <div class="panel" id="panel-orders-jap">
            <table>
                <thead>
                    <tr>
                        <th>Order ID</th>
                        <th>Date</th>
                        <th>JAP Service ID</th>
                        <th>JAP Service Name</th>
                        <th>Link</th>
                        <th>Qty</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody id="orders-jap-body"></tbody>
            </table>
        </div>
    </div>

    <script>
        function showTab(name) {
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.getElementById('panel-' + name).classList.add('active');
            event.target.classList.add('active');
        }

        async function loadAll() {
            try {
                const [mappings, pending, history, pgOrders, japOrders] = await Promise.all([
                    fetch('/api/mappings').then(r => r.json()),
                    fetch('/api/pending').then(r => r.json()),
                    fetch('/api/history').then(r => r.json()),
                    fetch('/api/orders/pg').then(r => r.json()),
                    fetch('/api/orders/jap').then(r => r.json())
                ]);

                document.getElementById('mappings-count').textContent = mappings.length;
                document.getElementById('pending-count').textContent = pending.length;
                document.getElementById('history-count').textContent = history.length;

                renderMappings(mappings);
                renderPending(pending);
                renderHistory(history);
                renderOrders('pg', pgOrders);
                renderOrdersJAP(japOrders);
            } catch (e) {
                console.error('Load error:', e);
            }
        }

        function renderMappings(data) {
            const tbody = document.getElementById('mappings-body');
            if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No mappings yet. Run the first scan to discover mappings.</td></tr>'; return; }
            tbody.innerHTML = data.map(m => `
                <tr>
                    <td>${m.pg_service_name || ''}</td>
                    <td>#${m.pg_service_id}</td>
                    <td><strong>#${m.current_jap_id || '?'}</strong></td>
                    <td>${m.jap_name || ''}</td>
                    <td>${m.crushlikes_service_id ? '#' + m.crushlikes_service_id : '<span style="color:#ff9800">Not mapped</span>'}</td>
                    <td>${m.confirmed_at || ''}</td>
                    <td>${m.crushlikes_updated ? '<span class="badge badge-green">Synced</span>' : '<span class="badge badge-yellow">Needs Update</span>'}</td>
                </tr>
            `).join('');
        }

        function renderPending(data) {
            const tbody = document.getElementById('pending-body');
            if (!data.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No pending changes detected.</td></tr>'; return; }
            tbody.innerHTML = data.map(p => `
                <tr>
                    <td>${p.pg_service_name} (PG#${p.pg_service_id})</td>
                    <td>#${p.old_jap_id || '?'}</td>
                    <td class="change-arrow">&rarr;</td>
                    <td><strong>#${p.new_jap_id}</strong></td>
                    <td>${p.new_jap_name || ''}</td>
                    <td><span class="badge badge-blue">${p.order_count}/5</span></td>
                    <td>${p.first_seen}</td>
                    <td>${p.last_seen}</td>
                </tr>
            `).join('');
        }

        function renderHistory(data) {
            const tbody = document.getElementById('history-body');
            if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No changes recorded yet.</td></tr>'; return; }
            tbody.innerHTML = data.map(h => `
                <tr>
                    <td>${h.confirmed_at}</td>
                    <td>${h.pg_service_name} (PG#${h.pg_service_id})</td>
                    <td>#${h.old_jap_id || '?'}</td>
                    <td class="change-arrow">&rarr;</td>
                    <td><strong>#${h.new_jap_id}</strong></td>
                    <td>${h.new_jap_name || ''}</td>
                    <td>${h.crushlikes_updated ? '<span class="badge badge-green">Yes</span>' : '<span class="badge badge-red">No</span>'}</td>
                </tr>
            `).join('');
        }

        function renderOrders(type, data) {
            const tbody = document.getElementById('orders-pg-body');
            if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No orders found.</td></tr>'; return; }
            tbody.innerHTML = data.map(o => `
                <tr>
                    <td>#${o.order_id}</td>
                    <td>${o.date}</td>
                    <td>${o.service_name}</td>
                    <td class="link-cell"><a href="${o.link}" target="_blank">${o.link}</a></td>
                    <td>${o.quantity}</td>
                    <td>${o.status}</td>
                </tr>
            `).join('');
        }

        function renderOrdersJAP(data) {
            const tbody = document.getElementById('orders-jap-body');
            if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No JAP orders found.</td></tr>'; return; }
            tbody.innerHTML = data.map(o => `
                <tr>
                    <td>#${o.order_id}</td>
                    <td>${o.date}</td>
                    <td><strong>#${o.jap_service_id}</strong></td>
                    <td>${o.jap_service_name || ''}</td>
                    <td class="link-cell"><a href="${o.link}" target="_blank">${o.link}</a></td>
                    <td>${o.quantity}</td>
                    <td>${o.status}</td>
                </tr>
            `).join('');
        }

        loadAll();
        setInterval(loadAll, 30000);
    </script>
</body>
</html>
"""


@app.route("/")
def index():
    return render_template_string(TEMPLATE)


@app.route("/api/mappings")
def api_mappings():
    return jsonify(get_all_mappings())


@app.route("/api/pending")
def api_pending():
    return jsonify(get_pending_changes())


@app.route("/api/history")
def api_history():
    return jsonify(get_change_history())


@app.route("/api/orders/<panel>")
def api_orders(panel):
    if panel not in ("pg", "jap"):
        return jsonify({"error": "Invalid panel"}), 400
    return jsonify(get_recent_orders(panel))


def run_dashboard():
    app.run(host="0.0.0.0", port=DASHBOARD_PORT, debug=False)


if __name__ == "__main__":
    from database import init_db
    init_db()
    run_dashboard()
