import sqlite3
import threading
from config import DB_PATH

_lock = threading.RLock()


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


# Single shared connection for all operations
_conn = None


def _get_conn():
    global _conn
    if _conn is None:
        _conn = get_db()
    return _conn


def init_db():
    conn = _get_conn()
    with _lock:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS service_mapping (
                pg_service_id INTEGER PRIMARY KEY,
                pg_service_name TEXT NOT NULL,
                pg_category TEXT DEFAULT '',
                current_jap_id INTEGER,
                confirmed_at TEXT,
                crushlikes_service_id INTEGER,
                crushlikes_updated INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS pg_orders (
                order_id INTEGER PRIMARY KEY,
                date TEXT,
                link TEXT,
                service_name TEXT,
                pg_service_id INTEGER,
                quantity INTEGER,
                charge REAL,
                status TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS jap_orders (
                order_id INTEGER PRIMARY KEY,
                date TEXT,
                link TEXT,
                jap_service_id INTEGER,
                jap_service_name TEXT,
                quantity INTEGER,
                charge REAL,
                status TEXT,
                matched_pg_order_id INTEGER,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS pending_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pg_service_id INTEGER NOT NULL,
                pg_service_name TEXT,
                old_jap_id INTEGER,
                new_jap_id INTEGER,
                new_jap_name TEXT,
                order_count INTEGER DEFAULT 0,
                first_seen TEXT DEFAULT (datetime('now')),
                last_seen TEXT DEFAULT (datetime('now')),
                confirmed INTEGER DEFAULT 0,
                notified INTEGER DEFAULT 0,
                UNIQUE(pg_service_id, new_jap_id)
            );
            CREATE TABLE IF NOT EXISTS change_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pg_service_id INTEGER,
                pg_service_name TEXT,
                old_jap_id INTEGER,
                old_jap_name TEXT,
                new_jap_id INTEGER,
                new_jap_name TEXT,
                confirmed_at TEXT DEFAULT (datetime('now')),
                crushlikes_updated INTEGER DEFAULT 0,
                updated_at TEXT
            );
        """)


def bulk_insert_orders(pg_orders, jap_orders):
    conn = _get_conn()
    with _lock:
        for o in pg_orders:
            conn.execute("""
                INSERT OR IGNORE INTO pg_orders
                    (order_id, date, link, service_name, pg_service_id, quantity, charge, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                o["order_id"], o["date"], o["link"],
                o["service_name"], o.get("pg_service_id"),
                o.get("quantity"), o.get("charge"), o.get("status")
            ))
        for o in jap_orders:
            conn.execute("""
                INSERT OR IGNORE INTO jap_orders
                    (order_id, date, link, jap_service_id, jap_service_name, quantity, charge, status, matched_pg_order_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                o["order_id"], o["date"], o["link"],
                o["jap_service_id"], o.get("jap_service_name"),
                o.get("quantity"), o.get("charge"), o.get("status"),
                o.get("matched_pg_order_id")
            ))
        conn.commit()


def update_matched(pairs):
    conn = _get_conn()
    with _lock:
        for pg, jap in pairs:
            conn.execute(
                "UPDATE jap_orders SET matched_pg_order_id = ? WHERE order_id = ?",
                (pg["order_id"], jap["order_id"])
            )
        conn.commit()


def get_current_mapping(pg_service_id):
    conn = _get_conn()
    with _lock:
        row = conn.execute(
            "SELECT current_jap_id FROM service_mapping WHERE pg_service_id = ?",
            (pg_service_id,)
        ).fetchone()
    return row["current_jap_id"] if row else None


def update_mapping(pg_service_id, pg_service_name, new_jap_id):
    conn = _get_conn()
    with _lock:
        conn.execute("""
            INSERT INTO service_mapping (pg_service_id, pg_service_name, current_jap_id, confirmed_at, crushlikes_updated)
            VALUES (?, ?, ?, datetime('now'), 0)
            ON CONFLICT(pg_service_id) DO UPDATE SET
                current_jap_id = excluded.current_jap_id,
                confirmed_at = datetime('now'),
                crushlikes_updated = 0
        """, (pg_service_id, pg_service_name, new_jap_id))
        conn.commit()


def track_pending_change(pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name):
    conn = _get_conn()
    with _lock:
        conn.execute("""
            INSERT INTO pending_changes (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name, order_count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(pg_service_id, new_jap_id) DO UPDATE SET
                order_count = pending_changes.order_count + 1,
                last_seen = datetime('now')
        """, (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name))
        row = conn.execute(
            "SELECT order_count FROM pending_changes WHERE pg_service_id = ? AND new_jap_id = ?",
            (pg_service_id, new_jap_id)
        ).fetchone()
        conn.commit()
    return row["order_count"] if row else 0


def confirm_change(pg_service_id, new_jap_id, new_jap_name):
    conn = _get_conn()
    with _lock:
        old = conn.execute(
            "SELECT current_jap_id FROM service_mapping WHERE pg_service_id = ?",
            (pg_service_id,)
        ).fetchone()
        old_jap_id = old["current_jap_id"] if old else None

        pending = conn.execute(
            "SELECT pg_service_name FROM pending_changes WHERE pg_service_id = ? AND new_jap_id = ?",
            (pg_service_id, new_jap_id)
        ).fetchone()
        pg_service_name = pending["pg_service_name"] if pending else ""

        conn.execute("UPDATE pending_changes SET confirmed = 1 WHERE pg_service_id = ? AND new_jap_id = ?",
                     (pg_service_id, new_jap_id))

        conn.execute("""
            INSERT INTO change_history (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name)
            VALUES (?, ?, ?, ?, ?)
        """, (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name))

        conn.execute("""
            INSERT INTO service_mapping (pg_service_id, pg_service_name, current_jap_id, confirmed_at, crushlikes_updated)
            VALUES (?, ?, ?, datetime('now'), 0)
            ON CONFLICT(pg_service_id) DO UPDATE SET
                current_jap_id = excluded.current_jap_id,
                confirmed_at = datetime('now'),
                crushlikes_updated = 0
        """, (pg_service_id, pg_service_name, new_jap_id))

        conn.execute("DELETE FROM pending_changes WHERE pg_service_id = ? AND new_jap_id != ?",
                     (pg_service_id, new_jap_id))

        conn.commit()


def get_all_mappings():
    conn = _get_conn()
    with _lock:
        rows = conn.execute("""
            SELECT sm.*, ch.new_jap_name as jap_name
            FROM service_mapping sm
            LEFT JOIN change_history ch ON sm.pg_service_id = ch.pg_service_id
                AND sm.current_jap_id = ch.new_jap_id
            ORDER BY sm.pg_service_name
        """).fetchall()
    return [dict(r) for r in rows]


def get_pending_changes():
    conn = _get_conn()
    with _lock:
        rows = conn.execute("SELECT * FROM pending_changes WHERE confirmed = 0 ORDER BY last_seen DESC").fetchall()
    return [dict(r) for r in rows]


def get_change_history(limit=50):
    conn = _get_conn()
    with _lock:
        rows = conn.execute("SELECT * FROM change_history ORDER BY confirmed_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def get_recent_orders(panel="pg", limit=50):
    conn = _get_conn()
    table = "pg_orders" if panel == "pg" else "jap_orders"
    with _lock:
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY date DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
