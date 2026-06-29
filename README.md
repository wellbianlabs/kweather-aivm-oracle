# K-Weather × AIVM 온체인 기상 데이터 오라클

**🛰️ 라이브: https://agent.kweather.co.kr**
**⛓️ 온체인 dApp (BNB Smart Chain Testnet): https://agent.kweather.co.kr/dapp**

케이웨더 실측 기상 데이터를 **온체인 오라클**로 공급하고, 자율 AI 에이전트가 구독/종량제 또는
x402(키리스) 결제로 안전하게 소비하도록 하는 마켓플레이스입니다. 케이웨더 자체 서버에서
독립 구동되며(단일 Node 프로세스 + nginx/TLS), 스마트컨트랙트는 BNB Smart Chain에 배포되어 있습니다.

```
케이웨더 프리미엄 API ──▶ 릴레이어(Off-chain) ──▶ 온체인 오라클 ──▶ AI 에이전트
   (Web2 JSON)            정제·고정소수점 스케일링    O(1) 조회 +        구독/종량제·x402
                                                    시계열 링버퍼       결제 후 쿼리·자율결정
```

## 제공 데이터 범위 (전부 케이웨더 실측)

| 구분 | 지역 수 | 데이터 소스 | 제공 항목 |
|---|---|---|---|
| **세계** | **4,255개 도시 / 167개국** | `kw-world-r1`(실황) + `kw-world-3d1`(시간예보) | 기온·체감온도·습도·강수·풍속·풍향·기압·가시거리·적설·불쾌지수 |
| **국내** | **3,561개 법정동(읍면동) / 17개 시도** | `kw-odam1`(관측) + `kw-dust-r1`(미세먼지) | 위 항목 + **PM10·PM2.5** |

- 도시 id는 세계=GeoNames `geonameid`, 국내=10자리 법정동코드이며, 그대로 온체인 지역 코드로 쓰입니다.
- 국내 3,561개 동은 전수 온체인 등록, 세계는 주요 도시 발행 + 조회 시 즉시 발행(on-demand).
- 세계날씨 피드에는 PM/일사/자외선이 없어 PM 기반 상품은 **국내 전용**입니다.

## 배포된 컨트랙트 (BSC Testnet, chainId 97)

| 컨트랙트 | 주소 |
|---|---|
| KWeatherWorldOracle (세계) | [`0x2A2b4B6530ef062c80fCeEc23ae0d6167eAe9630`](https://testnet.bscscan.com/address/0x2A2b4B6530ef062c80fCeEc23ae0d6167eAe9630) |
| KWeatherKoreaOracle (국내 동단위) | [`0xb303D062e079365479513a951777a35a353b32de`](https://testnet.bscscan.com/address/0xb303D062e079365479513a951777a35a353b32de) |
| SubscriptionManager | [`0xA34D6B699f16ed574A574a3E2b18ce063da4d911`](https://testnet.bscscan.com/address/0xA34D6B699f16ed574A574a3E2b18ce063da4d911) |
| KWT 토큰 | [`0x04090599Dbaa990eabC37fFBDE223A4eD02e5b20`](https://testnet.bscscan.com/address/0x04090599Dbaa990eabC37fFBDE223A4eD02e5b20) |

릴레이어(`/api/relay`, 매시 정각 크론)가 실날씨를 온체인에 발행하고, 자율 AI 에이전트(`/api/agent`,
매시 30분 크론)가 스스로 결제 후 온체인 쿼리를 실행합니다. 누구나 지갑을 연결해 KWT를 받고
구독·종량제로 결제한 뒤 온체인 쿼리를 할 수 있습니다.

## 구성 요소

| 레이어 | 파일 | 역할 |
|---|---|---|
| 독립 서버 | [server.js](server.js) | 웹(`web/`) + API(`api/*`)를 단일 Node 프로세스로 서빙 |
| 세계 오라클 | [contracts/KWeatherWorldOracle.sol](contracts/KWeatherWorldOracle.sol) | O(1) 최신값 + 링버퍼 시계열 + 배치 인게스천 + 미터링 읽기 |
| 국내 오라클 | [contracts/KWeatherKoreaOracle.sol](contracts/KWeatherKoreaOracle.sol) | 동단위 스키마(PM10/PM2.5 포함) |
| 수익화 | [contracts/SubscriptionManager.sol](contracts/SubscriptionManager.sol) | 월 구독(레이트리밋) + 종량제. 오라클만 `consume` 호출 가능 |
| 결제 토큰 | [contracts/EIP3009Token.sol](contracts/EIP3009Token.sol) · [contracts/MockERC20.sol](contracts/MockERC20.sol) | x402USD(EIP-3009) / KWT(ERC-20) |
| 날씨 피드 | [api/weather.js](api/weather.js) | 케이웨더 게이트웨이 호출(세계/국내 자동 라우팅) |
| 릴레이어 | [api/relay.js](api/relay.js) | 정제·스케일링 후 `pushBatch`로 온체인 발행 |
| 의사결정 | [api/decision.js](api/decision.js) · [lib/decision-products.js](lib/decision-products.js) | 온체인 데이터 → 도메인별 의사결정 |
| x402 결제 | [api/paid-weather.js](api/paid-weather.js) · [lib/x402.js](lib/x402.js) | 키리스 멀티에셋 정산(EIP-3009/Permit2) |
| 자율 에이전트 | [api/agent.js](api/agent.js) | 결제 후 온체인 쿼리 → 자율 결정 |
| 스케일러 | [lib/world-scale.js](lib/world-scale.js) · [lib/korea-scale.js](lib/korea-scale.js) | float → 고정소수점 정수 변환 |
| MCP 서버 | [mcp/server.mjs](mcp/server.mjs) | AI 에이전트용 도구(검색·결제·조회·의사결정) |

## 실행

```bash
# 자체 호스팅 (웹 + API 단일 프로세스)
cp .env.example .env      # KWEATHER_API_KEY, RELAYER_PRIVATE_KEY, AGENT_PRIVATE_KEY 입력
npm ci --omit=dev
node server.js            # http://localhost:8080

# 컨트랙트 개발(선택)
npm install
npm run compile           # 컴파일
npm test                  # 유닛 테스트(스케일링/접근제어/미터링/시계열)
```

프로덕션(서버 배포·도메인·TLS·크론·헬스체크)은 **[DEPLOY.md](DEPLOY.md)**, 운영팀 인수인계는
**[KWEATHER-HANDOFF.md](KWEATHER-HANDOFF.md)** 참고. `.env`에 키가 없으면 결정론적 모의 모드로
동작해 외부 의존성 없이 실행됩니다.

## 온체인 데이터 모델

```solidity
struct KWeatherWorldData {     // 세계 — 케이웨더 세계날씨 실측 필드
    uint256 timestamp;       // 관측 유닉스 타임스탬프
    int256  temperature;     // 기온     (℃ * 100)
    int256  senseTemp;       // 체감온도  (℃ * 100)
    uint256 humidity;        // 습도     (%)
    uint256 precipitation;   // 강수량   (mm * 100)
    uint256 windSpeed;       // 풍속     (m/s * 100)
    uint256 windDirection;   // 풍향     (0-360)
    uint256 pressure;        // 기압     (hPa * 100)
    uint256 visibility;      // 가시거리  (m)
    uint256 snowfall;        // 적설     (cm * 100)
    uint256 discomfortIndex; // 불쾌지수  (* 10)
}
// 국내(KWeatherKoreaData)는 pressure/visibility/snowfall 대신 pm10·pm25를 포함합니다.
```

핵심 인터페이스 (세계·국내 공통):

```solidity
function peekLatest(uint256 regionCode) external view returns (...);     // 무료 읽기(투명성)
function queryLatest(uint256 regionCode) external returns (...);          // 미터링 읽기(구독 한도/종량제 차감)
function pushBatch(uint256[] regionCodes, (...)[] data) external;         // 릴레이어 인게스천

function subscribe(uint256 months) external;       // 월 구독 → 쿼리 한도 부여
function depositPrepaid(uint256 amount) external;  // 종량제 선불 예치
```

## x402 키리스 결제 — 멀티에셋 (USDT 지원)

API 키도 계정도 없이 **요청마다 서명 한 번**으로 결제합니다. `GET /api/paid-weather?city=` 의 첫 호출은
**HTTP 402** + 결제 가능 자산 메뉴(`accepts[]`)를 반환하고, 소비자는 자산을 골라 서명한 뒤
`X-PAYMENT` 헤더로 재요청하면 서버가 온체인 정산 후 날씨를 돌려줍니다.

| 자산(id) | 심볼 | 정산 레일 | 네트워크 | 소비자 가스 |
|---|---|---|---|---|
| `x402usd` | x402USD | EIP-3009 | BSC testnet | 없음 (서명만) |
| `usdt-testnet` | USDT | EIP-3009 | BSC testnet | 없음 (서명만) |
| `usdt-testnet-permit2` | USDT | Permit2 | BSC testnet | 최초 1회 `approve(Permit2)` |
| `usdt-mainnet` | USDT | Permit2 | BSC mainnet | 최초 1회 `approve(Permit2)` |

**왜 USDT는 Permit2인가?** 실제 BSC USDT(`0x55d398…`)는 EIP-3009도 EIP-2612 permit도 지원하지 않아
가스리스 서명 전송이 불가능합니다. 그래서 Uniswap **Permit2**(`SignatureTransfer`)를 씁니다 — 소비자는
토큰에 **최초 1회 `approve(Permit2)`** 만 하면(가스 1번), 이후 요청은 **서명만** 으로 릴레이어가
`permitTransferFrom` 을 대납 제출해 정산합니다. 메인넷 실 USDT는 `X402_ENABLE_MAINNET=true` +
`RPC_URL_MAINNET` + 릴레이어 메인넷 BNB 펀딩 시 자동 노출됩니다(라이브니스 게이트).

```bash
node scripts/x402-client.mjs "Tokyo"                       # x402USD (가스리스)
node scripts/x402-client.mjs "Tokyo" USDT                  # USDT EIP-3009 (가스리스)
node scripts/x402-client.mjs "London" usdt-testnet-permit2 # USDT via Permit2 (실 USDT 레일)
```

검증(테스트넷 실거래): USDT EIP-3009 [tx](https://testnet.bscscan.com/tx/0xeca64ddfbe1d7a3fe5a2b9ac82c1a43bce2168c9e2bf21e7e73724a7670a52f4) ·
USDT Permit2 [tx](https://testnet.bscscan.com/tx/0x545b26f1894f0506cb9fbb5409eb1e58ea2fd34efba1eff7cd0985e931a85a0d).
MCP 도구: `pay_x402(city, asset?)`.

## 온체인 의사결정 상품 (25종)

오라클의 **온체인 날씨**를 도메인별 실행 가능한 의사결정으로 바꾸는 상품 카탈로그입니다.
`GET /api/decision?city=<도시명|id>`는 전 상품을, `&product=<id>`는 단일 상품을 실행합니다(파라미터
없이 호출 시 카탈로그). 각 상품은 온체인 데이터를 읽어 `{ signal, action, score(0~1), rationale, metrics }`를 반환합니다.

| 상품 | 분야 | 의사결정 |
|---|---|---|
| `wind-dispatch` | 에너지 | 풍력 출력 → 송전/부분/차단 |
| `crop-irrigation` | 농업 | 수분수지 → 관개/중단/가뭄경보 |
| `flood-watch` | 보험·안전 | 강수 누적 → 정상/경계/경보 |
| `heat-demand-response` | 전력 | 냉방부하 → 정상/피크저감/긴급DR |
| `cold-chain` | 물류 | 운송온도 → 정상/모니터/경로변경 |
| `construction-safety` | 건설 | 풍속·강수·폭염 → 작업/주의/중단 |
| `heat-stress` | 보건·안전 | 체감온도 → 중단/제한/한랭경보 |
| `storm-pressure` | 보험·해상 | 기압·풍속 → 폭풍/경계/안정 |
| `visibility-ops` | 운송 | 가시거리 → 운항중단/감속/정상 |
| `snow-ops` | 물류·공공 | 적설 → 제설투입/준비/정상 |
| `air-quality-ops` | 안전(국내) | PM10/PM2.5 → 운영/제한/중단 |
| `marine-ops` | 해상 | 풍속·가시거리·기압 → 출항/주의/통제 |
| `drone-ops` | 드론·배송 | 풍속·강수·가시거리 → 비행/제한/금지 |
| `road-frost` | 교통·안전 | 기온·강수·습도 → 정상/주의/결빙 |
| `autonomous-driving` | 모빌리티·교통 | 가시거리·강수·적설·기온·풍속 → 자율주행/제한/수동전환 |
| `heating-demand` | 전력·가스 | 체감온도(난방도일) → 정상/높음/피크 |
| `crop-disease` | 농업 | 기온·습도 → 정상/예찰/방제 |
| `frost-alert` | 농업 | 저온·습도·풍속 → 정상/주의/서리경보 |
| `retail-footfall` | 리테일 | 강수·기온·불쾌 → 방문 양호/감소/축소 |
| `vector-risk` | 보건 | 기온·습도·강수 → 정상/모니터/방역 |
| `powerline-icing` | 송전 | 적설·기온·풍속 → 정상/주의/착빙경보 |
| `water-demand` | 상수도 | 기온·불쾌 → 정상/높음/급수피크 |
| `event-hedge` | 보험·행사 | 강수·풍속 → 개최/헤지/연기·지급 |
| `tourism-comfort` | 관광 | 쾌적도 → 동적 가격 |
| `wildfire-risk` | 보험·안전 | 화재기상 → 정상/주의/경보 |

자율 에이전트(`GET /api/agent?product=<id>`)는 온체인 결제(구독 + 미터링 `queryLatest`) 후 선택한
상품의 결정을 반환합니다. dApp “🧠 온체인 의사결정 상품” 패널, MCP `list_decision_products()` /
`decide(city, product?)`로도 사용할 수 있습니다.

```bash
curl "https://agent.kweather.co.kr/api/decision?city=Jakarta&product=flood-watch"
```

## AI 에이전트 연동

- **MCP** (Claude / Cursor / Gemini): `mcp/server.mjs` — `search_cities` · `get_weather` · `buy_weather` ·
  `subscribe` · `pay_x402` · `list_decision_products` · `decide` 등. 설정 가이드는 [mcp/README.md](mcp/README.md).
- **HTTP REST**: 디스커버리 [`/llms.txt`](https://agent.kweather.co.kr/llms.txt) · OpenAPI [`/openapi.json`](https://agent.kweather.co.kr/openapi.json) ·
  `GET /api/catalog?q=` · `GET /api/quote` · `GET /api/weather` · `GET /api/decision`.

## 보안 노트

- **API Key 신뢰경계:** 키는 서버(프로덕션은 TEE/엔클레이브) 내부에만 존재하며 온체인에 노출되지 않습니다.
- **인게스천 접근제어:** `pushBatch`는 owner가 승인한 릴레이어만 호출 가능.
- **미터링 무결성:** `SubscriptionManager.consume`은 오라클 컨트랙트만 호출 가능(직접 호출 차단). 테스트로 검증됨.
- 비밀키/`.env`/`.secrets`는 절대 커밋하지 않습니다(`.gitignore`/`.dockerignore`로 제외).
- 현재 테스트넷 구성입니다. 메인넷 배포 전 보안 감사와 다중 릴레이어/집계(median) 등 탈중앙화 강화가 필요합니다.
