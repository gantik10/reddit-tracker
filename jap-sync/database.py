import sqlite3
import json
import threading
from datetime import datetime
from config import DB_PATH

_lock = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    return conn


def _execute_write(fn):
    """Execute a write operation with thread lock."""
    with _lock:
        return fn()


def init_db():
    conn = get_db()
    c = conn.cursor()

    # Service mapping: panelgraming service -> current JAP service ID
    c.execute("""
        CREATE TABLE IF NOT EXISTS service_mapping (
            pg_service_id INTEGER PRIMARY KEY,
            pg_service_name TEXT NOT NULL,
            pg_category TEXT DEFAULT '',
            current_jap_id INTEGER,
            confirmed_at TEXT,
            crushlikes_service_id INTEGER,
            crushlikes_updated INTEGER DEFAULT 0
        )
    """)

    # Orders seen on panelgraming
    c.execute("""
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
        )
    """)

    # Orders seen on JAP (matched by link)
    c.execute("""
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
        )
    """)

    # Tracks pending ID changes (before confirmation threshold)
    c.execute("""
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
        )
    """)

    # History of confirmed changes
    c.execute("""
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
        )
    """)

    conn.commit()
    conn.close()


def upsert_pg_order(order):
    with _lock:
        conn = get_db()
        conn.execute("""
            INSERT OR IGNORE INTO pg_orders
                (order_id, date, link, service_name, pg_service_id, quantity, charge, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            order["order_id"], order["date"], order["link"],
            order["service_name"], order.get("pg_service_id"),
            order.get("quantity"), order.get("charge"), order.get("status")
        ))
        conn.commit()
        conn.close()


def upsert_jap_order(order):
    with _lock:
        conn = get_db()
        conn.execute("""
            INSERT OR IGNORE INTO jap_orders
                (order_id, date, link, jap_service_id, jap_service_name, quantity, charge, status, matched_pg_order_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            order["order_id"], order["date"], order["link"],
            order["jap_service_id"], order.get("jap_service_name"),
            order.get("quantity"), order.get("charge"), order.get("status"),
            order.get("matched_pg_order_id")
        ))
        conn.commit()
        conn.close()


def get_current_mapping(pg_service_id):
    conn = get_db()
    row = conn.execute(
        "SELECT current_jap_id FROM service_mapping WHERE pg_service_id = ?",
        (pg_service_id,)
    ).fetchone()
    conn.close()
    return row["current_jap_id"] if row else None


def update_mapping(pg_service_id, pg_service_name, new_jap_id):
    with _lock:
        conn = get_db()
        conn.execute("""
            INSERT INTO service_mapping (pg_service_id, pg_service_name, current_jap_id, confirmed_at, crushlikes_updated)
            VALUES (?, ?, ?, datetime('now'), 0)
            ON CONFLICT(pg_service_id) DO UPDATE SET
                current_jap_id = excluded.current_jap_id,
                confirmed_at = datetime('now'),
                crushlikes_updated = 0
        """, (pg_service_id, pg_service_name, new_jap_id))
        conn.commit()
        conn.close()


def track_pending_change(pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name):
    with _lock:
        conn = get_db()
        c = conn.cursor()
        c.execute("""
            INSERT INTO pending_changes (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name, order_count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(pg_service_id, new_jap_id) DO UPDATE SET
                order_count = pending_changes.order_count + 1,
                last_seen = datetime('now')
        """, (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name))
        conn.commit()

        row = c.execute(
            "SELECT order_count FROM pending_changes WHERE pg_service_id = ? AND new_jap_id = ?",
            (pg_service_id, new_jap_id)
        ).fetchone()
        conn.close()
        return row["order_count"] if row else 0


def confirm_change(pg_service_id, new_jap_id, new_jap_name):
    with _lock:
        _confirm_change_inner(pg_service_id, new_jap_id, new_jap_name)


def _confirm_change_inner(pg_service_id, new_jap_id, new_jap_name):
    conn = get_db()
    # Get old mapping
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

    # Mark as confirmed
    conn.execute("""
        UPDATE pending_changes SET confirmed = 1
        WHERE pg_service_id = ? AND new_jap_id = ?
    """, (pg_service_id, new_jap_id))

    # Add to history
    conn.execute("""
        INSERT INTO change_history (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name)
        VALUES (?, ?, ?, ?, ?)
    """, (pg_service_id, pg_service_name, old_jap_id, new_jap_id, new_jap_name))

    # Update current mapping
    update_mapping(pg_service_id, pg_service_name, new_jap_id)

    # Clean up other pending changes for this service
    conn.execute("""
        DELETE FROM pending_changes WHERE pg_service_id = ? AND new_jap_id != ?
    """, (pg_service_id, new_jap_id))

    conn.commit()
    conn.close()


def get_all_mappings():
    conn = get_db()
    rows = conn.execute("""
        SELECT sm.*, ch.new_jap_name as jap_name
        FROM service_mapping sm
        LEFT JOIN change_history ch ON sm.pg_service_id = ch.pg_service_id
            AND sm.current_jap_id = ch.new_jap_id
        ORDER BY sm.pg_service_name
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_pending_changes():
    conn = get_db()
    rows = conn.execute("""
        SELECT * FROM pending_changes WHERE confirmed = 0
        ORDER BY last_seen DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_change_history(limit=50):
    conn = get_db()
    rows = conn.execute("""
        SELECT * FROM change_history ORDER BY confirmed_at DESC LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_recent_orders(panel="pg", limit=50):
    conn = get_db()
    table = "pg_orders" if panel == "pg" else "jap_orders"
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY date DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
