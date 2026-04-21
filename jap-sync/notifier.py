"""
Telegram notification for JAP service ID changes.
"""
import logging
import requests
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

logger = logging.getLogger("jap_sync.notifier")


def send_telegram(message, parse_mode="HTML"):
    """Send a message via Telegram bot."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        logger.warning("Telegram not configured (missing BOT_TOKEN or CHAT_ID)")
        return False

    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": message,
                "parse_mode": parse_mode
            }
        )
        if r.status_code == 200 and r.json().get("ok"):
            logger.info("Telegram notification sent")
            return True
        else:
            logger.error(f"Telegram send failed: {r.text}")
            return False
    except Exception as e:
        logger.error(f"Telegram error: {e}")
        return False


def notify_confirmed_change(change):
    """Send alert for a confirmed service ID change."""
    msg = (
        "<b>JAP SERVICE ID CHANGED</b>\n\n"
        f"<b>Service:</b> {change['pg_service_name']}\n"
        f"<b>PanelGram ID:</b> #{change['pg_service_id']}\n\n"
        f"<b>Old JAP ID:</b> #{change['old_jap_id']}\n"
        f"<b>New JAP ID:</b> #{change['new_jap_id']}\n"
        f"<b>New JAP Name:</b> {change.get('new_jap_name', 'N/A')}\n\n"
        f"<b>Confirmed by:</b> {change['order_count']} orders\n\n"
        "<b>ACTION REQUIRED:</b> Update CrushLikes.com service mapping to JAP ID "
        f"#{change['new_jap_id']}"
    )
    return send_telegram(msg)


def notify_pending_change(change):
    """Send info about a potential change (not yet confirmed)."""
    msg = (
        "Possible JAP ID Change Detected\n\n"
        f"Service: {change['pg_service_name']} (PG#{change['pg_service_id']})\n"
        f"Current JAP ID: #{change['old_jap_id']}\n"
        f"New JAP ID seen: #{change['new_jap_id']}\n"
        f"Orders so far: {change['order_count']}/{5} needed for confirmation\n\n"
        "Monitoring..."
    )
    return send_telegram(msg)


def notify_session_expired():
    """Alert that JAP session expired and needs manual captcha."""
    msg = (
        "<b>JAP Session Expired</b>\n\n"
        "The JAP browser session has expired and reCAPTCHA needs to be solved.\n"
        "The tool will attempt to solve it automatically via 2captcha.\n"
        "If auto-solve fails, manual login may be required."
    )
    return send_telegram(msg)


def notify_error(error_msg):
    """Send error notification."""
    msg = f"<b>JAP Sync Error</b>\n\n{error_msg}"
    return send_telegram(msg)


def notify_status(mappings_count, pending_count, last_check):
    """Send a status summary."""
    msg = (
        "<b>JAP Sync Status</b>\n\n"
        f"Tracked services: {mappings_count}\n"
        f"Pending changes: {pending_count}\n"
        f"Last check: {last_check}"
    )
    return send_telegram(msg)
