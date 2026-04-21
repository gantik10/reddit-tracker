"""
Interactive Telegram bot for JAP Service Sync.
Provides real-time alerts and commands for the manager team.
"""
import json
import logging
import threading
import time
import requests
from datetime import datetime
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from database import (
    get_all_mappings, get_pending_changes, get_change_history,
    get_recent_orders, get_db
)

logger = logging.getLogger("jap_sync.telegram")

# Hypesy.io services — only what's on the website
# Each PG ID (primary + backup) maps to the clean Hypesy display name
HYPESY_SERVICES = {
    # IG
    3: "Instagram Followers",
    4: "Instagram Followers",
    24: "Instagram Likes",
    25: "Instagram Likes",
    32: "Instagram Views",
    33: "Instagram Views",
    198: "Instagram VIP Likes",
    199: "Instagram VIP Likes",
    200: "Instagram VIP Followers",
    201: "Instagram VIP Followers",

    # TikTok
    40: "TikTok Followers",
    19: "TikTok Followers",
    45: "TikTok Likes",
    46: "TikTok Likes",
    53: "TikTok Views",
    56: "TikTok Views",
    416: "TikTok Story Views",
    417: "TikTok Story Views",
    120: "TikTok Shares",
    121: "TikTok Shares",
    339: "VIP TikTok Followers",
    340: "VIP TikTok Followers",
    380: "VIP TikTok Likes",
    381: "VIP TikTok Likes",

    # Twitter
    65: "Twitter (X) Followers",
    66: "Twitter (X) Followers",
    234: "Twitter (X) Followers",
    235: "Twitter (X) Followers",
    73: "Twitter (X) Likes",
    74: "Twitter (X) Likes",
    236: "Twitter (X) Likes",
    237: "Twitter (X) Likes",
    81: "Twitter (X) Views",
    82: "Twitter (X) Views",
    238: "Twitter (X) Views",
    239: "Twitter (X) Views",
    432: "Non Drop Twitter (X) Followers",
}


def send_message(text, chat_id=None, parse_mode="HTML", reply_markup=None):
    """Send a Telegram message."""
    if not TELEGRAM_BOT_TOKEN:
        return False
    cid = chat_id or TELEGRAM_CHAT_ID
    if not cid:
        return False
    try:
        payload = {
            "chat_id": cid,
            "text": text,
            "parse_mode": parse_mode,
        }
        if reply_markup:
            payload["reply_markup"] = json.dumps(reply_markup)
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        return r.status_code == 200 and r.json().get("ok")
    except Exception as e:
        logger.error(f"Telegram send error: {e}")
        return False


def _get_hypesy_name(pg_id):
    """Get the Hypesy service name for a PanelGram ID."""
    return HYPESY_SERVICES.get(pg_id)


def _is_hypesy_service(pg_id):
    """Check if this PanelGram service is used by Hypesy."""
    return pg_id in HYPESY_SERVICES


# ── Alert Messages ──────────────────────────────────────────

def alert_confirmed_change(change):
    """Send a prominent alert for a confirmed service ID change."""
    pg_id = change["pg_service_id"]
    hypesy_name = _get_hypesy_name(pg_id)
    is_hypesy = hypesy_name is not None

    service_name = hypesy_name or change['pg_service_name']

    msg = (
        f"\U0001F6A8 <b>SERVICE CHANGED</b>\n\n"
        f"<b>{service_name}</b>\n"
        f"Previous: <code>{change['old_jap_id']}</code>\n"
        f"Current: <code>{change['new_jap_id']}</code>"
    )
    return send_message(msg)


def alert_pending_change(change):
    """Notify about a potential change being tracked."""
    pg_id = change["pg_service_id"]
    hypesy_name = _get_hypesy_name(pg_id)

    if not _is_hypesy_service(pg_id):
        return True  # skip non-Hypesy services for pending alerts

    msg = (
        "\U0001F50D <b>Possible Change Detected</b>\n\n"
        f"<b>{hypesy_name}</b>\n\n"
        f"Current JAP: <code>#{change['old_jap_id']}</code>\n"
        f"New JAP seen: <code>#{change['new_jap_id']}</code>\n\n"
        f"Orders: {change['order_count']}/5 for confirmation\n"
        "Monitoring..."
    )
    return send_message(msg)


def alert_error(error_msg):
    """Send error alert."""
    msg = f"\u26A0\uFE0F <b>JAP Sync Error</b>\n\n<code>{error_msg[:500]}</code>"
    return send_message(msg)


def alert_session_expired():
    """Alert that JAP session needs renewal."""
    msg = (
        "\U0001F510 <b>JAP Session Expired</b>\n\n"
        "The tool will attempt to re-login automatically.\n"
        "If it fails, you may need to check the credentials."
    )
    return send_message(msg)


# ── Command Handlers ────────────────────────────────────────

def cmd_status(chat_id):
    """Show overall system status."""
    conn = get_db()
    total_mappings = conn.execute("SELECT COUNT(*) as c FROM service_mapping").fetchone()["c"]
    pending = conn.execute("SELECT COUNT(*) as c FROM pending_changes WHERE confirmed=0").fetchone()["c"]
    total_changes = conn.execute("SELECT COUNT(*) as c FROM change_history").fetchone()["c"]
    pg_orders = conn.execute("SELECT COUNT(*) as c FROM pg_orders").fetchone()["c"]
    jap_orders = conn.execute("SELECT COUNT(*) as c FROM jap_orders").fetchone()["c"]
    last_pg = conn.execute("SELECT MAX(created_at) as t FROM pg_orders").fetchone()["t"] or "Never"
    last_jap = conn.execute("SELECT MAX(created_at) as t FROM jap_orders").fetchone()["t"] or "Never"

    # Count Hypesy-tracked services
    hypesy_tracked = conn.execute(
        f"SELECT COUNT(*) as c FROM service_mapping WHERE pg_service_id IN ({','.join(str(x) for x in HYPESY_SERVICES.keys())})"
    ).fetchone()["c"]
    conn.close()

    msg = (
        "\U0001F4CA <b>JAP Sync Status</b>\n"
        f"{'=' * 28}\n\n"
        f"\U0001F5C2 Total mappings: <b>{total_mappings}</b>\n"
        f"\U0001F3AF Hypesy services tracked: <b>{hypesy_tracked}/{len(HYPESY_SERVICES)}</b>\n"
        f"\u23F3 Pending changes: <b>{pending}</b>\n"
        f"\U0001F504 Total confirmed changes: <b>{total_changes}</b>\n\n"
        f"\U0001F4E6 PG orders scraped: {pg_orders}\n"
        f"\U0001F4E6 JAP orders scraped: {jap_orders}\n\n"
        f"\U0001F552 Last PG scan: {last_pg}\n"
        f"\U0001F552 Last JAP scan: {last_jap}\n\n"
        f"\U0001F310 Dashboard: http://72.62.164.47:8085"
    )
    send_message(msg, chat_id)


def cmd_mappings(chat_id):
    """Show current Hypesy service mappings."""
    mappings = get_all_mappings()
    hypesy_mappings = [m for m in mappings if m["pg_service_id"] in HYPESY_SERVICES]

    if not hypesy_mappings:
        send_message("\u274C No Hypesy service mappings discovered yet. Wait for more orders to be processed.", chat_id)
        return

    # Group by category
    categories = {}
    for m in hypesy_mappings:
        pg_id = m["pg_service_id"]
        name = HYPESY_SERVICES.get(pg_id, m["pg_service_name"])
        if "instagram" in name.lower() or name.startswith("IG"):
            categories.setdefault("IG", []).append((pg_id, name, m["current_jap_id"]))
        elif "tiktok" in name.lower():
            categories.setdefault("TikTok", []).append((pg_id, name, m["current_jap_id"]))
        elif "twitter" in name.lower() or "drop" in name.lower():
            categories.setdefault("Twitter", []).append((pg_id, name, m["current_jap_id"]))
        else:
            categories.setdefault("Other", []).append((pg_id, name, m["current_jap_id"]))

    msg = "\U0001F5FA <b>Hypesy Service Mappings</b>\n\n"
    for cat in ["IG", "TikTok", "Twitter", "Other"]:
        items = categories.get(cat, [])
        if not items:
            continue
        msg += f"<b>{cat}</b>\n"
        for pg_id, name, jap_id in items:
            msg += f"  \u2022 {name} \u2192 JAP#<code>{jap_id}</code>\n"
        msg += "\n"

    # Telegram has a 4096 char limit, split if needed
    if len(msg) > 4000:
        parts = []
        current = ""
        for line in msg.split("\n"):
            if len(current) + len(line) + 1 > 3900:
                parts.append(current)
                current = ""
            current += line + "\n"
        if current:
            parts.append(current)
        for part in parts:
            send_message(part, chat_id)
    else:
        send_message(msg, chat_id)


def cmd_pending(chat_id):
    """Show pending (unconfirmed) changes."""
    pending = get_pending_changes()
    # Filter to Hypesy services
    pending = [p for p in pending if p["pg_service_id"] in HYPESY_SERVICES]

    if not pending:
        send_message("\u2705 No pending changes for Hypesy services. Everything looks stable.", chat_id)
        return

    msg = "\u23F3 <b>Pending Changes</b>\n\n"
    for p in pending:
        name = HYPESY_SERVICES.get(p["pg_service_id"], p["pg_service_name"])
        msg += (
            f"\U0001F538 <b>{name}</b>\n"
            f"  JAP#<code>{p['old_jap_id']}</code> \u2192 JAP#<code>{p['new_jap_id']}</code>\n"
            f"  Orders: {p['order_count']}/5\n\n"
        )
    send_message(msg, chat_id)


def cmd_changes(chat_id):
    """Show recent confirmed changes."""
    history = get_change_history(limit=10)

    if not history:
        send_message("\U0001F4ED No changes recorded yet.", chat_id)
        return

    msg = "\U0001F4DC <b>Recent Changes</b>\n\n"
    for h in history:
        pg_id = h["pg_service_id"]
        name = HYPESY_SERVICES.get(pg_id, h["pg_service_name"])
        msg += (
            f"\u2022 <b>{name}</b>\n"
            f"  JAP#<code>{h['old_jap_id']}</code> \u2192 JAP#<code>{h['new_jap_id']}</code>\n"
            f"  {h['confirmed_at']}\n\n"
        )
    send_message(msg, chat_id)


def cmd_services(chat_id):
    """Show all Hypesy services with their current JAP IDs."""
    # Get current mappings to show JAP IDs
    mappings = get_all_mappings()
    jap_map = {m["pg_service_id"]: m["current_jap_id"] for m in mappings}

    # Deduplicate — multiple PG IDs map to the same service name
    # Pick the one that has a JAP mapping, or first seen
    seen = {}
    for pg_id, name in HYPESY_SERVICES.items():
        if name not in seen or (jap_map.get(pg_id) and not jap_map.get(seen[name])):
            seen[name] = pg_id

    categories = {}
    for name, pg_id in seen.items():
        if "instagram" in name.lower() or name.startswith("IG"):
            categories.setdefault("IG", []).append((pg_id, name))
        elif "tiktok" in name.lower():
            categories.setdefault("TikTok", []).append((pg_id, name))
        elif "twitter" in name.lower() or "drop" in name.lower():
            categories.setdefault("Twitter", []).append((pg_id, name))
        else:
            categories.setdefault("Other", []).append((pg_id, name))

    unique_count = len(seen)
    msg = f"\U0001F4CB <b>Hypesy Services ({unique_count})</b>\n\n"
    for cat in ["IG", "TikTok", "Twitter", "Other"]:
        items = categories.get(cat, [])
        if not items:
            continue
        msg += f"<b>{cat}</b>\n"
        for pg_id, name in sorted(items, key=lambda x: x[1]):
            jap_id = jap_map.get(pg_id)
            if jap_id:
                msg += f"  \u2022 {name} \u2192 JAP#<code>{jap_id}</code>\n"
            else:
                msg += f"  \u2022 {name} \u2014 <i>awaiting orders</i>\n"
        msg += "\n"

    if len(msg) > 4000:
        parts = msg.split("\n\n")
        current = ""
        for part in parts:
            if len(current) + len(part) > 3900:
                send_message(current, chat_id)
                current = ""
            current += part + "\n\n"
        if current:
            send_message(current, chat_id)
    else:
        send_message(msg, chat_id)


def cmd_help(chat_id):
    """Show available commands."""
    msg = (
        "\U0001F916 <b>JAP Sync Bot</b>\n"
        f"{'=' * 25}\n\n"
        "<b>Commands:</b>\n\n"
        "/status \u2014 System overview & stats\n"
        "/mappings \u2014 Current PG \u2192 JAP ID mappings\n"
        "/pending \u2014 Changes being tracked (not yet confirmed)\n"
        "/changes \u2014 Recent confirmed changes\n"
        "/services \u2014 All Hypesy services being monitored\n"
        "/help \u2014 This message\n\n"
        "<b>How it works:</b>\n"
        "Every 5 min, the bot scrapes orders from PanelGram "
        "and JAP, matches them by link, and detects when the "
        "JAP admin changes a service ID. After 5 orders confirm "
        "the change, you get an alert.\n\n"
        "\U0001F3AF = Hypesy service\n"
        "\U0001F6A8 = Action needed (update CrushLikes)"
    )
    send_message(msg, chat_id)


COMMANDS = {
    "/status": cmd_status,
    "/mappings": cmd_mappings,
    "/pending": cmd_pending,
    "/changes": cmd_changes,
    "/services": cmd_services,
    "/help": cmd_help,
    "/start": cmd_help,
}


# ── Bot Polling Loop ────────────────────────────────────────

def _poll_updates():
    """Long-poll for Telegram bot updates and handle commands."""
    if not TELEGRAM_BOT_TOKEN:
        logger.warning("Telegram bot token not set, bot polling disabled")
        return

    offset = 0
    logger.info("Telegram bot polling started")

    while True:
        try:
            r = requests.get(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
                params={"offset": offset, "timeout": 30},
                timeout=35
            )
            if r.status_code != 200:
                time.sleep(5)
                continue

            data = r.json()
            if not data.get("ok"):
                time.sleep(5)
                continue

            for update in data.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message", {})
                text = msg.get("text", "").strip()
                chat_id = msg.get("chat", {}).get("id")

                if not chat_id or not text:
                    continue

                # Extract command (handle @botname suffix)
                cmd = text.split()[0].split("@")[0].lower()

                if cmd in COMMANDS:
                    logger.info(f"Bot command: {cmd} from chat {chat_id}")
                    try:
                        COMMANDS[cmd](chat_id)
                    except Exception as e:
                        logger.error(f"Command error: {e}")
                        send_message(f"\u274C Error: {str(e)[:200]}", chat_id)

        except requests.exceptions.Timeout:
            continue
        except Exception as e:
            logger.error(f"Bot polling error: {e}")
            time.sleep(10)


def start_bot():
    """Start the Telegram bot in a background thread."""
    thread = threading.Thread(target=_poll_updates, daemon=True)
    thread.start()
    logger.info("Telegram bot thread started")
    return thread


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(f"Bot token: {TELEGRAM_BOT_TOKEN[:20]}...")
    print("Starting bot polling... Send /help to the bot.")
    _poll_updates()
