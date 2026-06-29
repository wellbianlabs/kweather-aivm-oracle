# 배포 가이드 — `agent.kweather.co.kr`

케이웨더 자체 서버에서 이 플랫폼(웹 + API)을 **독립 구동**하는 방법입니다.
스마트컨트랙트(오라클/구독)는 BNB Smart Chain에 이미 배포되어 있어 **웹+API 레이어만 서버에서 구동**합니다.

```
[인터넷] → agent.kweather.co.kr (DNS A 레코드) → nginx(443, TLS) → Node 서버 server.js(8080)
                                                                      ├─ web/  정적 (대시보드·dApp·llms.txt·openapi.json)
                                                                      └─ api/* (weather·decision·quote·catalog·relay·agent·paid-weather)
                                                                            └─ BNB Smart Chain (오라클/구독) + K-Weather 게이트웨이
```

## 1) 사전 준비
- Node.js **20 LTS 이상** (또는 Docker)
- 서버 공인 IP, 방화벽 80/443 오픈
- K-Weather 게이트웨이 **API 키** (세계날씨 권한 포함)
- 펀딩된 테스트넷 지갑 2개 키: 릴레이어(tBNB), 에이전트(KWT+tBNB)

## 2) 소스 + 환경변수
```bash
git clone https://github.com/wellbianlabs/kweather-aivm-oracle.git
cd kweather-aivm-oracle
cp .env.example .env      # 값 채우기 (키/주소) — 아래 표 참고
npm ci --omit=dev         # 런타임 의존성만 (hardhat 등 devDeps 제외)
node server.js            # http://0.0.0.0:8080
```
주요 환경변수(전체는 `.env.example`):

| 변수 | 설명 |
|---|---|
| `KWEATHER_API_KEY` | **(필수·비밀)** 케이웨더 게이트웨이 키 |
| `RELAYER_PRIVATE_KEY` | **(비밀)** 온체인 발행 서명자 (tBNB 필요) |
| `AGENT_PRIVATE_KEY` | **(비밀)** 자율 에이전트 (KWT+tBNB) |
| `ORACLE_ADDRESS` / `KOREA_ORACLE_ADDRESS` | 세계 / 국내 동단위 오라클 |
| `SUBSCRIPTION_ADDRESS` / `TOKEN_ADDRESS` | 구독 매니저 / KWT |
| `X402_PAYTO` | x402 수취 지갑 |
| `PORT` | 서버 포트(기본 8080) |
| `ENABLE_CRON` | `true`면 내장 스케줄러(시간당 relay+agent) |

> 비밀키는 `.env`(0600 권한)나 시스템 시크릿에만 두고 절대 커밋하지 마세요. (`.gitignore`/`.dockerignore`에 `.secrets`·`.env` 제외됨)

## 3) Docker (권장)
```bash
docker build -t kweather-agent .
docker run -d --name kweather-agent --restart unless-stopped \
  --env-file .env -p 127.0.0.1:8080:8080 kweather-agent
# 헬스체크: docker inspect --format '{{.State.Health.Status}}' kweather-agent
```

## 4) systemd (Docker 대신 직접 구동)
`/etc/systemd/system/kweather-agent.service`:
```ini
[Unit]
Description=KWeather x AIVM Oracle
After=network.target
[Service]
WorkingDirectory=/opt/kweather-aivm-oracle
EnvironmentFile=/opt/kweather-aivm-oracle/.env
ExecStart=/usr/bin/node server.js
Restart=always
User=kweather
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kweather-agent
```

## 5) 도메인 `agent.kweather.co.kr` + TLS
**DNS**: `agent.kweather.co.kr` A 레코드 → 서버 공인 IP.

**nginx** `/etc/nginx/sites-available/agent.kweather.co.kr`:
```nginx
server {
  listen 80;
  server_name agent.kweather.co.kr;
  location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/agent.kweather.co.kr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d agent.kweather.co.kr     # Let's Encrypt TLS 자동 발급/갱신
```

## 6) 정기 작업 (크론)
`/api/relay`(매시 정각, 날씨 발행)·`/api/agent`(매시 30분, 자율 에이전트)를 주기 실행합니다:
- 간편: `.env`에 `ENABLE_CRON=true` (server.js 내장 스케줄러, 시간당 실행), 또는
- 표준: 시스템 crontab —
```cron
0  * * * * curl -fsS https://agent.kweather.co.kr/api/relay  > /dev/null
30 * * * * curl -fsS https://agent.kweather.co.kr/api/agent  > /dev/null
```

## 7) 확인
```bash
curl -s https://agent.kweather.co.kr/api/quote
curl -s "https://agent.kweather.co.kr/api/decision?city=서울 종로구 청운효자동"
# 대시보드: https://agent.kweather.co.kr/   ·   dApp: https://agent.kweather.co.kr/dapp
```

## 8) MCP 서버(선택)
AI 에이전트용 MCP는 같은 호스트에서 새 도메인을 가리키게 실행:
```bash
SITE_URL=https://agent.kweather.co.kr AGENT_PRIVATE_KEY=... node mcp/server.mjs
```

## 참고
- **컨트랙트는 재배포 불필요** — BNB Smart Chain의 기존 오라클/구독을 그대로 사용합니다.
- 메인넷 전환 시 `X402_ENABLE_MAINNET=true` + `RPC_URL_MAINNET` + 릴레이어 메인넷 BNB 펀딩.
- `web/dapp-config.js`의 RPC/주소는 빌드 산출물(공개값)이며, 다른 체인으로 옮기면 함께 갱신하세요.
