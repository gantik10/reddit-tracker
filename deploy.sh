#!/bin/bash
# ================================================
# LK Media Group — Reddit Tracker
# Full VPS Deployment Script (Hostinger Ubuntu)
# ================================================
#
# USAGE:
# 1. SSH into your Hostinger VPS:
#    ssh root@YOUR_VPS_IP
#
# 2. Upload project files:
#    (from your Mac, run this BEFORE ssh-ing in)
#    scp -r "/Users/kirillgontovoy/Downloads/Reddit Tracking" root@YOUR_VPS_IP:~/reddit-tracker
#
# 3. SSH in and run:
#    ssh root@YOUR_VPS_IP
#    cd ~/reddit-tracker
#    chmod +x deploy.sh
#    ./deploy.sh
#
# 4. After script finishes, install Dolphin Anty manually:
#    - Download: https://dolphin-anty.com/download (Linux version)
#    - Install it on the VPS
#    - Log in, set up your 3 USA proxy profiles
#    - The app will run in the virtual display (invisible)
#
# ================================================

set -e

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   LK Media Group — Reddit Tracker           ║"
echo "║   VPS Deployment Script                      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# --- Ask for domain ---
read -p "Enter your domain (e.g. tracker.lkmedia.com): " DOMAIN
read -p "Enter your email (for SSL certificate): " EMAIL

echo ""
echo "==> Step 1: System update"
apt update && apt upgrade -y

echo ""
echo "==> Step 2: Install Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo ""
echo "==> Step 3: Install Nginx, Certbot, and build tools"
apt install -y nginx certbot python3-certbot-nginx build-essential

echo ""
echo "==> Step 4: Install virtual display (for Dolphin Anty)"
apt install -y xvfb xauth dbus-x11 libgtk-3-0 libnotify4 libnss3 \
  libxss1 libxtst6 xdg-utils libatspi2.0-0 libdrm2 libgbm1 \
  libasound2 fonts-liberation libappindicator3-1 wget unzip

echo ""
echo "==> Step 5: Install npm dependencies"
cd ~/reddit-tracker
npm install

echo ""
echo "==> Step 6: Install PM2 (process manager)"
npm install -g pm2

echo ""
echo "==> Step 7: Create startup script with virtual display"
cat > ~/reddit-tracker/start.sh << 'STARTEOF'
#!/bin/bash
# Start virtual display for Dolphin Anty
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 &
sleep 2

# Start the Reddit Tracker server
cd ~/reddit-tracker
node server.js
STARTEOF
chmod +x ~/reddit-tracker/start.sh

echo ""
echo "==> Step 8: Configure PM2"
pm2 delete reddit-tracker 2>/dev/null || true
pm2 start ~/reddit-tracker/start.sh --name reddit-tracker
pm2 save
pm2 startup systemd -u root --hp /root

echo ""
echo "==> Step 9: Configure Nginx"
cat > /etc/nginx/sites-available/reddit-tracker << NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/reddit-tracker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo ""
echo "==> Step 10: SSL Certificate (HTTPS)"
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL}

echo ""
echo "==> Step 11: Set up auto-renewal for SSL"
systemctl enable certbot.timer

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   DEPLOYMENT COMPLETE!                       ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║   Your app is live at:                       ║"
echo "║   → https://${DOMAIN}                        ║"
echo "║                                              ║"
echo "║   NEXT STEPS:                                ║"
echo "║   1. Point your domain DNS to this VPS IP    ║"
echo "║   2. Install Dolphin Anty on this VPS:       ║"
echo "║      wget the .deb from dolphin-anty.com     ║"
echo "║      dpkg -i dolphin-anty.deb                ║"
echo "║   3. Start Dolphin in virtual display:       ║"
echo "║      DISPLAY=:99 dolphin-anty &              ║"
echo "║   4. Open the app, go to Settings,           ║"
echo "║      add your API keys                       ║"
echo "║                                              ║"
echo "║   USEFUL COMMANDS:                           ║"
echo "║   pm2 logs reddit-tracker  (view logs)       ║"
echo "║   pm2 restart reddit-tracker (restart)       ║"
echo "║   pm2 status               (check status)    ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
