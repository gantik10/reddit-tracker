#!/bin/bash
# Deploy JAP Sync to VPS
set -e

VPS="root@72.62.164.47"
REMOTE_DIR="/root/jap-sync"

echo "=== Deploying JAP Sync to VPS ==="

# Create remote directory
ssh $VPS "mkdir -p $REMOTE_DIR/sessions"

# Copy files
echo "[1/3] Uploading files..."
scp -r \
    config.py \
    database.py \
    scraper_panelgraming.py \
    scraper_jap.py \
    matcher.py \
    notifier.py \
    dashboard.py \
    main.py \
    requirements.txt \
    setup.sh \
    jap-sync.service \
    nginx-jap-sync.conf \
    $VPS:$REMOTE_DIR/

# Run setup on VPS
echo "[2/3] Running setup on VPS..."
ssh $VPS "chmod +x $REMOTE_DIR/setup.sh && cd $REMOTE_DIR && bash setup.sh"

echo "[3/3] Done!"
echo ""
echo "Next steps on VPS:"
echo "  1. Set env vars in /etc/systemd/system/jap-sync.service"
echo "  2. sudo systemctl daemon-reload"
echo "  3. sudo systemctl enable --now jap-sync"
echo "  4. Check: sudo systemctl status jap-sync"
echo "  5. Dashboard: http://77.37.49.32:8085"
