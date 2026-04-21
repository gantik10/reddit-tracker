"""
Scraper for justanotherpanel.com orders page.
Uses Playwright (headless browser) since JAP has reCAPTCHA on login.
Session cookies are persisted to avoid re-solving captcha on each run.
"""
import os
import re
import json
import time
import logging
import requests
from config import (
    JAP_URL, JAP_USERNAME, JAP_PASSWORD,
    TWOCAPTCHA_API_KEY, SESSION_DIR, JAP_COOKIES_FILE
)

logger = logging.getLogger("jap_sync.jap")

# Playwright is imported lazily to avoid issues when not installed
_playwright = None
_browser = None


def _ensure_session_dir():
    os.makedirs(SESSION_DIR, exist_ok=True)


def _save_cookies(cookies):
    _ensure_session_dir()
    with open(JAP_COOKIES_FILE, "w") as f:
        json.dump(cookies, f)
    logger.info(f"Saved {len(cookies)} cookies to {JAP_COOKIES_FILE}")


def _load_cookies():
    if os.path.exists(JAP_COOKIES_FILE):
        with open(JAP_COOKIES_FILE) as f:
            cookies = json.load(f)
        logger.info(f"Loaded {len(cookies)} cookies from file")
        return cookies
    return None


def _solve_recaptcha(page):
    """Solve reCAPTCHA using 2captcha service."""
    if not TWOCAPTCHA_API_KEY:
        logger.error("TWOCAPTCHA_API_KEY not set - cannot solve captcha")
        return None

    # Find the reCAPTCHA site key
    sitekey_match = re.search(r'data-sitekey="([^"]+)"', page.content())
    if not sitekey_match:
        # Try looking in script tags
        sitekey_match = re.search(r"sitekey['\"]?\s*[:=]\s*['\"]([^'\"]+)", page.content())
    if not sitekey_match:
        logger.error("Could not find reCAPTCHA site key")
        return None

    sitekey = sitekey_match.group(1)
    page_url = page.url
    logger.info(f"Solving reCAPTCHA: sitekey={sitekey[:20]}... url={page_url}")

    # Submit to 2captcha
    r = requests.post("http://2captcha.com/in.php", data={
        "key": TWOCAPTCHA_API_KEY,
        "method": "userrecaptcha",
        "googlekey": sitekey,
        "pageurl": page_url,
        "json": 1
    })
    resp = r.json()
    if resp.get("status") != 1:
        logger.error(f"2captcha submit failed: {resp}")
        return None

    captcha_id = resp["request"]
    logger.info(f"2captcha task submitted: {captcha_id}")

    # Poll for solution (typically 20-60 seconds)
    for attempt in range(30):
        time.sleep(5)
        r = requests.get("http://2captcha.com/res.php", params={
            "key": TWOCAPTCHA_API_KEY,
            "action": "get",
            "id": captcha_id,
            "json": 1
        })
        resp = r.json()
        if resp.get("status") == 1:
            logger.info("reCAPTCHA solved successfully")
            return resp["request"]
        elif resp.get("request") != "CAPCHA_NOT_READY":
            logger.error(f"2captcha error: {resp}")
            return None

    logger.error("2captcha timeout - captcha not solved in 150s")
    return None


class JAPScraper:
    def __init__(self):
        self.browser = None
        self.context = None
        self.page = None
        self.logged_in = False

    def _start_browser(self):
        """Initialize Playwright browser."""
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"]
        )

        # Try loading saved cookies
        cookies = _load_cookies()
        self.context = self.browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        if cookies:
            self.context.add_cookies(cookies)

        self.page = self.context.new_page()

    def _check_logged_in(self):
        """Check if we're logged in by visiting the orders page."""
        self.page.goto(f"{JAP_URL}/orders", wait_until="networkidle", timeout=30000)
        time.sleep(2)

        # If redirected to /?redirect= then not logged in
        url = self.page.url
        if "redirect=" in url:
            return False

        # Check for order table content on the page
        if "/orders" in url:
            self.logged_in = True
            logger.info("JAP session still valid (cookies worked)")
            return True
        return False

    def login(self):
        """Login to JAP with captcha solving if needed."""
        if self.browser is None:
            self._start_browser()

        # First try existing cookies
        if _load_cookies():
            if self._check_logged_in():
                return True

        logger.info("Need to login to JAP (solving captcha)...")
        self.page.goto(f"{JAP_URL}/", wait_until="networkidle", timeout=30000)
        time.sleep(2)

        content = self.page.content()

        # Check if reCAPTCHA is present
        has_captcha = "recaptcha" in content.lower()

        if has_captcha:
            token = _solve_recaptcha(self.page)
            if not token:
                logger.error("Failed to solve reCAPTCHA")
                return False

            # Inject the captcha response
            self.page.evaluate(f"""
                document.getElementById('g-recaptcha-response').value = '{token}';
                if (typeof grecaptcha !== 'undefined') {{
                    // Try to find the callback
                    var widgets = document.querySelectorAll('.g-recaptcha');
                    if (widgets.length > 0) {{
                        var callback = widgets[0].getAttribute('data-callback');
                        if (callback && window[callback]) {{
                            window[callback]('{token}');
                        }}
                    }}
                }}
            """)

        # Fill in credentials
        self.page.fill("#username", JAP_USERNAME)
        self.page.fill("#password", JAP_PASSWORD)

        # Check "Remember me"
        remember = self.page.query_selector("#remember")
        if remember and not remember.is_checked():
            remember.check()

        # Submit
        self.page.click('input[type="submit"]')
        time.sleep(5)
        try:
            self.page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass

        # Check if login succeeded by navigating to orders
        self.page.goto(f"{JAP_URL}/orders", wait_until="networkidle", timeout=30000)
        time.sleep(2)

        url = self.page.url
        if "redirect=" not in url and "/orders" in url:
            self.logged_in = True
            cookies = self.context.cookies()
            _save_cookies(cookies)
            logger.info("JAP login successful, cookies saved")
            return True
        else:
            # Check for error message
            content = self.page.content()
            if "Incorrect" in content:
                logger.error("JAP login failed: incorrect username or password")
            else:
                logger.error("JAP login failed (unknown reason)")
            return False

    def get_orders(self, page_num=1):
        """Scrape orders from JAP orders page."""
        if not self.logged_in:
            if not self.login():
                return []

        try:
            url = f"{JAP_URL}/orders"
            if page_num > 1:
                url += f"?page={page_num}"

            self.page.goto(url, wait_until="networkidle", timeout=30000)
            time.sleep(2)

            # Check if session expired (redirected to login)
            if "redirect=" in self.page.url:
                logger.warning("JAP session expired, re-logging in...")
                self.logged_in = False
                if not self.login():
                    return []
                self.page.goto(url, wait_until="networkidle", timeout=30000)
                time.sleep(2)

            return self._parse_orders(self.page.content())
        except Exception as e:
            logger.error(f"Error fetching JAP orders: {e}")
            return []

    def _parse_orders(self, html):
        """Parse JAP orders table.
        Columns: ID, Date, Link, Charge, Start count, Quantity, Service, Remains, Status
        Service format: "8415 - Twitter Tweet Views [Refill: No Drop]..."
        """
        orders = []
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
                date_text = " ".join(date_text.split())

                link = re.sub(r"<[^>]+>", "", cells[2]).strip()

                charge_text = re.sub(r"<[^>]+>", "", cells[3]).strip()

                quantity_text = re.sub(r"<[^>]+>", "", cells[5]).strip()

                service_raw = re.sub(r"<[^>]+>", "", cells[6]).strip()
                service_raw = " ".join(service_raw.split())

                # Parse service: "⊕ 8415 - Twitter Tweet Views..."
                # or "8415 - Twitter Tweet Views..."
                svc_match = re.search(r"(\d+)\s*[-–]\s*(.+)", service_raw)
                if svc_match:
                    jap_service_id = int(svc_match.group(1))
                    jap_service_name = svc_match.group(2).strip()
                else:
                    logger.debug(f"Could not parse service: {service_raw}")
                    continue

                status = re.sub(r"<[^>]+>", "", cells[-1]).strip()
                if not status:
                    status = re.sub(r"<[^>]+>", "", cells[8]).strip() if len(cells) > 8 else "Unknown"

                orders.append({
                    "order_id": int(order_id_text),
                    "date": date_text,
                    "link": link,
                    "jap_service_id": jap_service_id,
                    "jap_service_name": jap_service_name,
                    "quantity": int(quantity_text) if quantity_text.isdigit() else 0,
                    "charge": float(charge_text) if charge_text else 0,
                    "status": status
                })
            except (ValueError, IndexError) as e:
                logger.debug(f"Skipping malformed JAP row: {e}")
                continue

        logger.info(f"Parsed {len(orders)} orders from JAP")
        return orders

    def close(self):
        """Clean up browser resources."""
        try:
            if self.context:
                cookies = self.context.cookies()
                _save_cookies(cookies)
            if self.browser:
                self.browser.close()
            if hasattr(self, "_pw"):
                self._pw.stop()
        except Exception:
            pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    scraper = JAPScraper()
    try:
        orders = scraper.get_orders()
        print(f"\nGot {len(orders)} orders:")
        for o in orders[:5]:
            print(f"  #{o['order_id']} | JAP#{o['jap_service_id']} {o['jap_service_name'][:40]} | {o['link'][:50]} | {o['status']}")
    finally:
        scraper.close()
