"""
Order matcher and service ID change detector.
Matches panelgraming orders to JAP orders by link URL,
then detects when JAP service IDs change for a panelgraming service.
"""
import logging
from urllib.parse import urlparse, urlunparse
from database import (
    upsert_pg_order, upsert_jap_order, get_current_mapping,
    track_pending_change, confirm_change, get_db
)
from config import CONFIRMATION_THRESHOLD
from telegram_bot import HYPESY_SERVICES

logger = logging.getLogger("jap_sync.matcher")


def normalize_link(link):
    """Normalize a URL for comparison (remove trailing slashes, lowercase domain)."""
    if not link:
        return ""
    link = link.strip()
    parsed = urlparse(link)
    # Lowercase domain, keep path as-is, remove trailing slash
    normalized = urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/"),
        parsed.params,
        parsed.query,
        ""  # remove fragment
    ))
    return normalized


def match_orders(pg_orders, jap_orders):
    """
    Match panelgraming orders to JAP orders by link URL.
    Returns list of matched pairs: (pg_order, jap_order)
    """
    # Index JAP orders by normalized link
    jap_by_link = {}
    for jo in jap_orders:
        norm = normalize_link(jo["link"])
        if norm not in jap_by_link:
            jap_by_link[norm] = []
        jap_by_link[norm].append(jo)

    matched = []
    for pg in pg_orders:
        pg_norm = normalize_link(pg["link"])
        if pg_norm in jap_by_link:
            # Find the best match: closest in time and quantity
            candidates = jap_by_link[pg_norm]
            for jap in candidates:
                # Match by similar quantity (within 20% tolerance) or exact
                qty_match = (
                    pg.get("quantity", 0) == jap.get("quantity", 0) or
                    (pg.get("quantity", 0) > 0 and jap.get("quantity", 0) > 0 and
                     abs(pg["quantity"] - jap["quantity"]) / max(pg["quantity"], 1) < 0.2)
                )
                if qty_match:
                    matched.append((pg, jap))
                    break
            else:
                # If no quantity match, take the first link match
                if candidates:
                    matched.append((pg, candidates[0]))

    logger.info(f"Matched {len(matched)} order pairs out of {len(pg_orders)} PG / {len(jap_orders)} JAP orders")
    return matched


def detect_changes(matched_pairs):
    """
    Analyze matched order pairs to detect JAP service ID changes.
    Returns list of detected changes (confirmed and pending).
    """
    changes = []

    # Group by panelgraming service
    by_pg_service = {}
    for pg, jap in matched_pairs:
        pg_sid = pg.get("pg_service_id")
        if pg_sid is None:
            continue
        if pg_sid not in by_pg_service:
            by_pg_service[pg_sid] = []
        by_pg_service[pg_sid].append((pg, jap))

    for pg_sid, pairs in by_pg_service.items():
        if pg_sid not in HYPESY_SERVICES:
            continue
        for pg, jap in pairs:
            jap_sid = jap["jap_service_id"]
            jap_name = jap.get("jap_service_name", "")
            pg_name = pg.get("service_name", "")
            current_jap_id = get_current_mapping(pg_sid)

            if current_jap_id is None:
                # First time seeing this service - record the mapping
                from database import update_mapping
                update_mapping(pg_sid, pg_name, jap_sid)
                logger.info(f"Initial mapping: PG#{pg_sid} ({pg_name}) -> JAP#{jap_sid} ({jap_name})")
                continue

            if jap_sid != current_jap_id:
                # Different JAP service ID detected!
                count = track_pending_change(
                    pg_sid, pg_name, current_jap_id, jap_sid, jap_name
                )
                logger.warning(
                    f"Change detected: PG#{pg_sid} ({pg_name}) "
                    f"JAP#{current_jap_id} -> JAP#{jap_sid} ({jap_name}) "
                    f"[{count}/{CONFIRMATION_THRESHOLD} orders]"
                )

                if count >= CONFIRMATION_THRESHOLD:
                    confirm_change(pg_sid, jap_sid, jap_name)
                    changes.append({
                        "type": "confirmed",
                        "pg_service_id": pg_sid,
                        "pg_service_name": pg_name,
                        "old_jap_id": current_jap_id,
                        "new_jap_id": jap_sid,
                        "new_jap_name": jap_name,
                        "order_count": count
                    })
                    logger.warning(
                        f"CONFIRMED CHANGE: PG#{pg_sid} ({pg_name}) "
                        f"JAP#{current_jap_id} -> JAP#{jap_sid} ({jap_name})"
                    )
                else:
                    changes.append({
                        "type": "pending",
                        "pg_service_id": pg_sid,
                        "pg_service_name": pg_name,
                        "old_jap_id": current_jap_id,
                        "new_jap_id": jap_sid,
                        "new_jap_name": jap_name,
                        "order_count": count
                    })

    return changes


def process_cycle(pg_orders, jap_orders):
    """
    Full processing cycle:
    1. Store orders in DB
    2. Match orders by link
    3. Detect changes
    Returns list of changes (confirmed and pending)
    """
    from database import _lock

    # Filter to Hypesy services only
    pg_orders = [o for o in pg_orders if o.get("pg_service_id") in HYPESY_SERVICES]
    logger.info(f"Filtered to {len(pg_orders)} Hypesy orders from PanelGram")

    # Store Hypesy orders only
    with _lock:
        conn = get_db()
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
        conn.close()

    # Match only Hypesy PG orders against JAP orders
    matched = match_orders(pg_orders, jap_orders)

    # Store matches in single transaction
    with _lock:
        conn = get_db()
        for pg, jap in matched:
            conn.execute(
                "UPDATE jap_orders SET matched_pg_order_id = ? WHERE order_id = ?",
                (pg["order_id"], jap["order_id"])
            )
        conn.commit()
        conn.close()

    # Detect changes
    changes = detect_changes(matched)

    return changes
