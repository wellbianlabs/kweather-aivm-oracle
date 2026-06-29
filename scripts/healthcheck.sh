#!/usr/bin/env bash
# kweather-agent 헬스체크 — 응답 없으면(행/먹통) 서비스 재기동.
# systemd Restart=always는 프로세스 크래시만 잡으므로, 살아있지만 응답 못 하는 상태를 보완.
# cron에서 5분마다 실행 (setup-server.sh가 등록). 로그: /var/log/kweather-agent-health.log
URL="http://127.0.0.1:${PORT:-8080}/api/quote"
LOG="/var/log/kweather-agent-health.log"
ok(){ curl -fsS -m 8 "$URL" >/dev/null 2>&1; }
if ok; then exit 0; fi
sleep 5
if ok; then exit 0; fi   # 일시적 지연이면 통과(플래핑 방지)
echo "$(date -Is) HEALTH FAIL → systemctl restart kweather-agent" >> "$LOG"
systemctl restart kweather-agent
sleep 8
if ok; then echo "$(date -Is) recovered" >> "$LOG"; else echo "$(date -Is) STILL DOWN after restart" >> "$LOG"; fi
