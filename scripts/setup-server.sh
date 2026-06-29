#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# agent.kweather.co.kr — 자체 서버 원클릭 설치 (Ubuntu + nginx 환경)
#
#   서버(220.95.232.202)에서 sudo 권한으로 실행:
#     curl -fsSL https://raw.githubusercontent.com/wellbianlabs/kweather-aivm-oracle/main/scripts/setup-server.sh | sudo bash
#   또는 저장소를 받은 뒤:  sudo bash scripts/setup-server.sh
#
# 멱등(idempotent)합니다. .env가 비어 있으면 1단계(설치+스캐폴드)에서 멈추고,
# .env를 채운 뒤 다시 실행하면 2단계(서비스+nginx+TLS)를 진행합니다.
# 기존 nginx의 다른 사이트는 건드리지 않습니다(agent.kweather.co.kr 전용 블록만 추가).
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="agent.kweather.co.kr"
APP_DIR="/opt/kweather-aivm-oracle"
REPO="https://github.com/wellbianlabs/kweather-aivm-oracle.git"
PORT="8080"
SVC="kweather-agent"
RUN_USER="${SUDO_USER:-root}"

say(){ echo -e "\n\033[1;36m▶ $*\033[0m"; }
ok(){ echo -e "\033[1;32m✔ $*\033[0m"; }
warn(){ echo -e "\033[1;33m⚠ $*\033[0m"; }

[ "$(id -u)" -eq 0 ] || { echo "sudo로 실행하세요: sudo bash scripts/setup-server.sh"; exit 1; }

# ── 1) Node 20 ──
say "Node.js 확인"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  say "Node 20 설치 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "node $(node -v)"

# ── 2) 소스 ──
say "소스 받기 → $APP_DIR"
apt-get install -y git >/dev/null 2>&1 || true
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"
say "런타임 의존성 설치"
npm ci --omit=dev

# ── 3) .env 스캐폴드/검증 ──
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"; chown "$RUN_USER":"$RUN_USER" "$APP_DIR/.env" 2>/dev/null || true
  warn ".env 를 생성했습니다. 아래 값을 채운 뒤 이 스크립트를 다시 실행하세요:"
  echo "    nano $APP_DIR/.env"
  echo "    필수: KWEATHER_API_KEY, RELAYER_PRIVATE_KEY, AGENT_PRIVATE_KEY"
  exit 0
fi
if grep -q "__your_kweather_api_key__\|__relayer_private_key__\|__agent_private_key__" "$APP_DIR/.env"; then
  warn ".env 에 미입력 값이 있습니다. 채운 뒤 다시 실행하세요:  nano $APP_DIR/.env"
  exit 0
fi
ok ".env 확인됨"

# ── 4) systemd 서비스 ──
say "systemd 서비스 등록 ($SVC)"
cat >/etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=KWeather x AIVM Oracle (agent.kweather.co.kr)
After=network.target
[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PORT=$PORT
ExecStart=$(command -v node) server.js
Restart=always
User=$RUN_USER
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SVC
sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/quote" >/dev/null && ok "앱 구동 OK (127.0.0.1:$PORT)" || { warn "앱 응답 없음 — 로그: journalctl -u $SVC -n 50"; exit 1; }

# ── 5) nginx 리버스프록시 (agent.kweather.co.kr 전용) ──
say "nginx 블록 추가 ($DOMAIN)"
apt-get install -y nginx >/dev/null 2>&1 || true
cat >/etc/nginx/sites-available/$DOMAIN <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
nginx -t && systemctl reload nginx
ok "nginx 반영 (http://$DOMAIN)"

# ── 6) TLS (Let's Encrypt) ──
say "TLS 인증서 발급 (certbot)"
if ! command -v certbot >/dev/null 2>&1; then apt-get install -y certbot python3-certbot-nginx; fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@wellbianlabs.io" --redirect || \
  warn "certbot 자동발급 실패 — 수동 실행: certbot --nginx -d $DOMAIN"

# ── 7) 크론 (시간당 갱신) ──
say "크론 등록 (시간당 relay + agent)"
CRON="0 * * * * curl -fsS https://$DOMAIN/api/relay >/dev/null 2>&1
30 * * * * curl -fsS https://$DOMAIN/api/agent >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -v "$DOMAIN/api/relay\|$DOMAIN/api/agent"; echo "$CRON" ) | crontab -
ok "크론 등록 완료"

say "완료!  확인:"
echo "    https://$DOMAIN/            (대시보드)"
echo "    https://$DOMAIN/dapp        (온체인 dApp)"
echo "    https://$DOMAIN/api/quote   (가격/컨트랙트)"
echo "    서비스 상태:  systemctl status $SVC   |   로그: journalctl -u $SVC -f"
