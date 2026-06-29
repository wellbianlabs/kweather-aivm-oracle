#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# agent.kweather.co.kr — 자체 서버 원클릭 설치 (Ubuntu + nginx)
#
#   서버(220.95.232.202)에서 명령 한 줄:
#     sudo bash <(curl -fsSL https://raw.githubusercontent.com/wellbianlabs/kweather-aivm-oracle/main/scripts/setup-server.sh)
#
#   → 실행 중 키 3개(케이웨더 API 키 / 릴레이어·에이전트 개인키)만 입력하면
#     설치 → .env 작성 → 서비스 기동 → nginx → TLS → 크론까지 한 번에 끝납니다.
#
#   (선택) 무인 설치: 키를 환경변수로 넘기면 입력 프롬프트 없이 진행
#     sudo KWEATHER_API_KEY=... RELAYER_PRIVATE_KEY=0x... AGENT_PRIVATE_KEY=0x... \
#       bash <(curl -fsSL https://raw.githubusercontent.com/wellbianlabs/kweather-aivm-oracle/main/scripts/setup-server.sh)
#
# 멱등(여러 번 실행해도 안전). 기존 nginx의 다른 사이트는 건드리지 않습니다.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="agent.kweather.co.kr"
APP_DIR="/opt/kweather-aivm-oracle"
REPO="https://github.com/wellbianlabs/kweather-aivm-oracle.git"
PORT="8080"
SVC="kweather-agent"
EMAIL="${CERTBOT_EMAIL:-admin@wellbianlabs.io}"
RUN_USER="${SUDO_USER:-root}"

say(){ echo -e "\n\033[1;36m▶ $*\033[0m"; }
ok(){  echo -e "\033[1;32m✔ $*\033[0m"; }
warn(){ echo -e "\033[1;33m⚠ $*\033[0m"; }

[ "$(id -u)" -eq 0 ] || { echo "sudo로 실행하세요."; exit 1; }

# ── 1) Node 20 ──
say "Node.js 확인/설치"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - ; apt-get install -y nodejs
fi
ok "node $(node -v)"

# ── 2) 소스 ──
say "소스 받기 → $APP_DIR"
command -v git >/dev/null 2>&1 || apt-get install -y git
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"
say "런타임 의존성 설치"; npm ci --omit=dev

# ── 3) 키 입력 + .env 자동 작성 ──
# 이미 완성된 .env가 있으면 재사용. 없으면 env 변수 → 없으면 대화형 입력.
need_keys=1
if [ -f "$APP_DIR/.env" ] && ! grep -q "__your_kweather_api_key__\|__relayer_private_key__\|__agent_private_key__" "$APP_DIR/.env"; then
  ok ".env 이미 구성됨 — 키 입력 건너뜀"; need_keys=0
fi
if [ "$need_keys" -eq 1 ]; then
  if [ -z "${KWEATHER_API_KEY:-}" ] || [ -z "${RELAYER_PRIVATE_KEY:-}" ] || [ -z "${AGENT_PRIVATE_KEY:-}" ]; then
    if [ -t 0 ]; then
      say "키 3개를 입력하세요 (화면에 표시되지 않습니다)"
      [ -z "${KWEATHER_API_KEY:-}" ]   && { read -rsp "  1/3 케이웨더 API 키: " KWEATHER_API_KEY; echo; }
      [ -z "${RELAYER_PRIVATE_KEY:-}" ] && { read -rsp "  2/3 릴레이어 개인키(0x…): " RELAYER_PRIVATE_KEY; echo; }
      [ -z "${AGENT_PRIVATE_KEY:-}" ]   && { read -rsp "  3/3 에이전트 개인키(0x…): " AGENT_PRIVATE_KEY; echo; }
    else
      warn "비대화형 실행입니다. 키를 환경변수로 넘기거나, 터미널에서 다음으로 실행하세요:"
      echo "  sudo bash <(curl -fsSL $REPO/raw/main/scripts/setup-server.sh)"
      exit 1
    fi
  fi
  # 간단 검증
  case "$RELAYER_PRIVATE_KEY" in 0x*) ;; *) warn "릴레이어 키가 0x로 시작하지 않습니다 (계속 진행)";; esac
  case "$AGENT_PRIVATE_KEY"   in 0x*) ;; *) warn "에이전트 키가 0x로 시작하지 않습니다 (계속 진행)";; esac

  # 기본값(.env.example)에서 키 3줄만 제거하고 실제 값을 깨끗하게 추가 (escape 이슈 없음)
  # systemd EnvironmentFile은 인라인 주석을 값으로 취급하므로 ' #...' 꼬리주석을 방어적으로 제거
  grep -vE '^(KWEATHER_API_KEY|RELAYER_PRIVATE_KEY|AGENT_PRIVATE_KEY)=' "$APP_DIR/.env.example" \
    | sed -E 's/[[:space:]]+#.*$//' > "$APP_DIR/.env"
  {
    echo "KWEATHER_API_KEY=$KWEATHER_API_KEY"
    echo "RELAYER_PRIVATE_KEY=$RELAYER_PRIVATE_KEY"
    echo "AGENT_PRIVATE_KEY=$AGENT_PRIVATE_KEY"
  } >> "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"; chown "$RUN_USER":"$RUN_USER" "$APP_DIR/.env" 2>/dev/null || true
  ok ".env 작성 완료"
fi

# ── 4) systemd 서비스 ──
say "systemd 서비스 등록/기동 ($SVC)"
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
systemctl daemon-reload; systemctl enable --now $SVC; sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/quote" >/dev/null && ok "앱 구동 OK (127.0.0.1:$PORT)" \
  || { warn "앱 응답 없음 — 로그: journalctl -u $SVC -n 50"; exit 1; }

# ── 5) nginx (agent.kweather.co.kr 전용 블록) ──
say "nginx 리버스프록시 추가 ($DOMAIN)"
command -v nginx >/dev/null 2>&1 || apt-get install -y nginx
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
nginx -t && systemctl reload nginx && ok "nginx 반영"

# ── 6) TLS ──
say "TLS 인증서 발급 (Let's Encrypt)"
command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
  && ok "HTTPS 적용" || warn "certbot 실패 — 수동: certbot --nginx -d $DOMAIN"

# ── 7) 헬스체크 워치독 ──
say "헬스체크 설치 (먹통 시 자동 재기동, 5분 주기)"
install -m 755 "$APP_DIR/scripts/healthcheck.sh" /usr/local/bin/kweather-healthcheck.sh

# ── 8) 크론 (시간당 갱신 + 5분 헬스체크) ──
say "크론 등록 (시간당 relay + agent, 5분 헬스체크)"
( crontab -l 2>/dev/null | grep -v "$DOMAIN/api/relay\|$DOMAIN/api/agent\|kweather-healthcheck"; \
  echo "0 * * * * curl -fsS https://$DOMAIN/api/relay >/dev/null 2>&1"; \
  echo "30 * * * * curl -fsS https://$DOMAIN/api/agent >/dev/null 2>&1"; \
  echo "*/5 * * * * PORT=$PORT /usr/local/bin/kweather-healthcheck.sh" ) | crontab -
ok "크론 등록"

echo -e "\n\033[1;32m════════ 설치 완료 ════════\033[0m"
echo "  대시보드 : https://$DOMAIN/"
echo "  dApp     : https://$DOMAIN/dapp"
echo "  상태확인 : https://$DOMAIN/api/quote"
echo "  서비스   : systemctl status $SVC   |   로그: journalctl -u $SVC -f"
