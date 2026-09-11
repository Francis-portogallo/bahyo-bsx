#!/bin/bash
# sync-from-o2.sh — rapatrie l'état actuel de ~/bsx/ sur O2 vers ce repo local
# Usage : ./sync-from-o2.sh
#
# Prerequis : cle SSH configuree pour qiyo9734@jonc.o2switch.net (ou ftp.bahyo.net)
# A executer une fois pour recuperer l'etat initial avant de commencer a pousser.

set -e

REMOTE_USER="qiyo9734"
REMOTE_HOST="jonc.o2switch.net"     # ou l'adresse SSH fournie par O2
REMOTE_BSX="/home2/qiyo9734/bsx"
LOCAL_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "→ Sync depuis $REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX vers $LOCAL_ROOT"

# Backend
rsync -avz --progress \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX/src/server.js"       "$LOCAL_ROOT/src/"
rsync -avz --progress \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX/src/routes/"         "$LOCAL_ROOT/src/routes/"
rsync -avz --progress \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX/src/middleware/"     "$LOCAL_ROOT/src/middleware/"
rsync -avz --progress \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX/src/db/"             "$LOCAL_ROOT/src/db/"

# Frontend (juste index.html, pas les fichiers cPanel .htaccess ni les .bak)
rsync -avz --progress \
  --exclude='.htaccess' --exclude='*.bak' --exclude='.well-known' \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX/public/"             "$LOCAL_ROOT/public/"

# package.json
rsync -avz \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_BSX/package.json"        "$LOCAL_ROOT/"

echo "✓ Sync terminee. Verifiez avec 'git status' puis commit + push."
