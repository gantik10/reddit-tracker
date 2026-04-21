"""
JAP Service Sync - Main scheduler.
Polls panelgraming and JAP every 5 minutes, detects service ID changes,
and sends Telegram alerts when confirmed.
"""
import time
import logging
import threading
from datetime import datetime

from config import POLL_INTERVAL
from database import init_db
from scraper_panelgraming import PanelgramingScraper
from scraper_jap import JAPScraper
from matcher import process_cycle
from telegram_bot import (
    alert_confirmed_change, alert_pending_change,
    alert_session_expired, alert_error, start_bot
)
from dashboard import run_dashboard

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("jap_sync.log")
    ]
)
logger = logging.getLogger("jap_sync.main")


def run_scan(pg_scraper, jap_scraper):
    """Run one scan cycle."""
    logger.info("=" * 60)
    logger.info(f"Starting scan cycle at {datetime.now().isoformat()}")

    # 1. Scrape panelgraming orders (multiple pages for thorough coverage)
    pg_orders = []
    for page in range(1, 4):  # First 3 pages (~300 orders)
        orders = pg_scraper.get_orders(page=page)
        if not orders:
            break
        pg_orders.extend(orders)
        if len(orders) < 100:  # Less than full page = last page
            break

    logger.info(f"Got {len(pg_orders)} orders from PanelGraming")

    if not pg_orders:
        logger.warning("No PG orders found - skipping cycle")
        return

    # 2. Scrape JAP orders (multiple pages)
    jap_orders = []
    for page in range(1, 4):
        orders = jap_scraper.get_orders(page_num=page)
        if not orders:
            if page == 1:
                logger.warning("JAP returned no orders - session may be expired")
                alert_session_expired()
            break
        jap_orders.extend(orders)
        if len(orders) < 100:
            break

    logger.info(f"Got {len(jap_orders)} orders from JAP")

    if not jap_orders:
        logger.warning("No JAP orders found - skipping matching")
        return

    # 3. Process: match orders, detect changes
    changes = process_cycle(pg_orders, jap_orders)

    # 4. Send notifications
    for change in changes:
        if change["type"] == "confirmed":
            alert_confirmed_change(change)
            logger.warning(f"ALERT SENT: {change['pg_service_name']} changed to JAP#{change['new_jap_id']}")
        elif change["type"] == "pending" and change["order_count"] == 1:
            alert_pending_change(change)

    if not changes:
        logger.info("No changes detected this cycle")

    logger.info(f"Scan cycle complete. {len(changes)} changes detected.")


def main():
    logger.info("=" * 60)
    logger.info("JAP Service Sync starting up")
    logger.info(f"Poll interval: {POLL_INTERVAL}s")
    logger.info("=" * 60)

    # Initialize database
    init_db()
    logger.info("Database initialized")

    # Start Telegram bot (command listener)
    start_bot()
    logger.info("Telegram bot started")

    # Start dashboard in background thread
    dashboard_thread = threading.Thread(target=run_dashboard, daemon=True)
    dashboard_thread.start()
    logger.info("Dashboard started on port 8085")

    # Initialize scrapers
    pg_scraper = PanelgramingScraper()
    jap_scraper = JAPScraper()

    # Main loop
    consecutive_errors = 0
    while True:
        try:
            run_scan(pg_scraper, jap_scraper)
            consecutive_errors = 0
        except Exception as e:
            consecutive_errors += 1
            logger.error(f"Scan cycle error: {e}", exc_info=True)
            if consecutive_errors >= 3:
                alert_error(f"3 consecutive scan failures. Last error: {str(e)[:200]}")
                consecutive_errors = 0

        logger.info(f"Sleeping {POLL_INTERVAL}s until next scan...")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
