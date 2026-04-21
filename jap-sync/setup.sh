#!/bin/bash
# JAP Service Sync - VPS Setup Script
# Run on the VPS (77.37.49.32)

set -e

echo "=== JAP Service Sync Setup ==="

# Install system dependencies
echo "[1/5] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-pip python3-venv

# Create virtual environment
echo "[2/5] Setting up Python virtual environment..."
cd /root/jap-sync
python3 -m venv venv
source venv/bin/activate

# Install Python packages
echo "[3/5] Installing Python packages..."
pip install -q requests flask playwright

# Install Playwright browsers (Chromium only)
echo "[4/5] Installing Playwright Chromium..."
playwright install chromium
playwright install-deps chromium

# Create sessions directory
mkdir -p sessions

# Initialize database
echo "[5/5] Initializing database..."
python3 database.py

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Before starting, set these environment variables:"
echo "  export TWOCAPTCHA_API_KEY='your_2captcha_key'"
echo "  export TELEGRAM_BOT_TOKEN='your_bot_token'"
echo "  export TELEGRAM_CHAT_ID='your_chat_id'"
echo ""
echo "To start:"
echo "  source venv/bin/activate"
echo "  python3 main.py"
echo ""
echo "Or use the systemd service:"
echo "  sudo cp jap-sync.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable jap-sync"
echo "  sudo systemctl start jap-sync"
