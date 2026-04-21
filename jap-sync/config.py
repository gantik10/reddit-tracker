import os

# === Panel Credentials ===

# Panelgraming.com (child panel - user access, web scraping)
PANELGRAMING_URL = "https://panelgraming.com"
PANELGRAMING_API_URL = "https://panelgraming.com/api/v2"
PANELGRAMING_API_KEY = "a93bc8cf6a1a6ba86367e1b5001cdb8e"
PANELGRAMING_USERNAME = "graming"
PANELGRAMING_PASSWORD = "adminadmin"

# Just Another Panel (provider - web scraping via Playwright)
JAP_URL = "https://justanotherpanel.com"
JAP_API_URL = "https://justanotherpanel.com/api/v2"
JAP_API_KEY = "c152b9a152b13d0ea8b7f7f8739cfef5"
JAP_USERNAME = "gramingcom"
JAP_PASSWORD = "hfAyN4xDXTClXCR7"

# === 2Captcha (for reCAPTCHA solving on JAP login) ===
TWOCAPTCHA_API_KEY = os.environ.get("TWOCAPTCHA_API_KEY", "89f5a7fb785d8e572a1574981dbf98b8")

# === Telegram Bot ===
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8795578116:AAEtBkdtJxaQHNvfkWh42Hy9Gh0bOSJJkKk")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "-4955600147")

# === Detection Settings ===
# Number of consecutive orders with new JAP service ID before confirming a change
CONFIRMATION_THRESHOLD = 5
# Polling interval in seconds
POLL_INTERVAL = 300  # 5 minutes

# === Database ===
DB_PATH = os.path.join(os.path.dirname(__file__), "jap_sync.db")

# === Dashboard ===
DASHBOARD_PORT = int(os.environ.get("DASHBOARD_PORT", 8085))

# === Session Storage ===
SESSION_DIR = os.path.join(os.path.dirname(__file__), "sessions")
JAP_COOKIES_FILE = os.path.join(SESSION_DIR, "jap_cookies.json")
PG_COOKIES_FILE = os.path.join(SESSION_DIR, "pg_cookies.json")
