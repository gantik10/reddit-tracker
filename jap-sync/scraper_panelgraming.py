"""
Scraper for panelgraming.com orders page.
Uses requests (no browser needed) since there's no captcha.
"""
import re
import requests
import logging
from config import (
    PANELGRAMING_URL, PANELGRAMING_API_URL, PANELGRAMING_API_KEY,
    PANELGRAMING_USERNAME, PANELGRAMING_PASSWORD
)

logger = logging.getLogger("jap_sync.panelgraming")


class PanelgramingScraper:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })
        self.logged_in = False

    def login(self):
        """Login to panelgraming.com web interface."""
        try:
            r = self.session.get(f"{PANELGRAMING_URL}/")
            csrf_match = re.search(r'name="_csrf"\s+value="([^"]+)"', r.text)
            if not csrf_match:
                logger.error("Could not find CSRF token on panelgraming login page")
                return False

            csrf = csrf_match.group(1)
            r2 = self.session.post(f"{PANELGRAMING_URL}/", data={
                "_csrf": csrf,
                "LoginForm[username]": PANELGRAMING_USERNAME,
                "LoginForm[password]": PANELGRAMING_PASSWORD,
                "LoginForm[remember]": "1"
            }, headers={"Referer": f"{PANELGRAMING_URL}/"}, allow_redirects=True)

            if "logout" in r2.text.lower() or "orders" in r2.text.lower():
                self.logged_in = True
                logger.info("Logged into panelgraming.com successfully")
                return True
            else:
                logger.error("Panelgraming login failed - no dashboard detected")
                return False
        except Exception as e:
            logger.error(f"Panelgraming login error: {e}")
            return False

    def get_orders(self, page=1):
        """Scrape orders from the orders page."""
        if not self.logged_in:
            if not self.login():
                return []

        try:
            url = f"{PANELGRAMING_URL}/orders"
            if page > 1:
                url += f"?page={page}"
            r = self.session.get(url)

            if r.status_code != 200:
                logger.error(f"Orders page returned {r.status_code}")
                return []

            # Check if session expired
            if "LoginForm" in r.text and "logout" not in r.text.lower():
                logger.warning("Session expired, re-logging in...")
                self.logged_in = False
                if not self.login():
                    return []
                r = self.session.get(url)

            return self._parse_orders(r.text)
        except Exception as e:
            logger.error(f"Error fetching orders: {e}")
            return []

    def _parse_orders(self, html):
        """Parse the orders table HTML."""
        orders = []

        # Find all table rows (skip header)
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.DOTALL)

        for row in rows:
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
            if len(cells) < 8:
                continue

            try:
                order_id_text = re.sub(r"<[^>]+>", "", cells[0]).strip()
                if not order_id_text.isdigit():
                    continue

                date_text = re.sub(r"<[^>]+>", "", cells[1]).strip()
                date_text = " ".join(date_text.split())  # normalize whitespace

                link = re.sub(r"<[^>]+>", "", cells[2]).strip()

                charge_text = re.sub(r"<[^>]+>", "", cells[3]).strip()

                quantity_text = re.sub(r"<[^>]+>", "", cells[5]).strip()

                service_name = re.sub(r"<[^>]+>", "", cells[6]).strip()

                status = re.sub(r"<[^>]+>", "", cells[7]).strip()

                # Extract pg_service_id from the service filter attribute if available
                service_id_match = re.search(
                    r'data-filter-table-service-id="(\d+)"', row
                )
                pg_service_id = int(service_id_match.group(1)) if service_id_match else None

                # If no data attribute, try to match service name to known services
                if pg_service_id is None:
                    pg_service_id = self._resolve_service_id(service_name)

                orders.append({
                    "order_id": int(order_id_text),
                    "date": date_text,
                    "link": link,
                    "charge": float(charge_text) if charge_text else 0,
                    "quantity": int(quantity_text) if quantity_text.isdigit() else 0,
                    "service_name": service_name,
                    "pg_service_id": pg_service_id,
                    "status": status
                })
            except (ValueError, IndexError) as e:
                logger.debug(f"Skipping malformed row: {e}")
                continue

        logger.info(f"Parsed {len(orders)} orders from panelgraming")
        return orders

    def _resolve_service_id(self, service_name):
        """Try to resolve service name to ID using the API."""
        try:
            r = self.session.post(PANELGRAMING_API_URL, data={
                "key": PANELGRAMING_API_KEY,
                "action": "services"
            })
            services = r.json()
            for s in services:
                if s["name"].strip().lower() == service_name.strip().lower():
                    return s["service"]
        except Exception:
            pass
        return None

    def get_services_api(self):
        """Get full service list from API."""
        try:
            r = requests.post(PANELGRAMING_API_URL, data={
                "key": PANELGRAMING_API_KEY,
                "action": "services"
            })
            return r.json()
        except Exception as e:
            logger.error(f"Error fetching services: {e}")
            return []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    scraper = PanelgramingScraper()
    orders = scraper.get_orders()
    print(f"\nGot {len(orders)} orders:")
    for o in orders[:5]:
        print(f"  #{o['order_id']} | {o['service_name']} | {o['link'][:50]} | {o['status']}")
