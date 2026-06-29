# K-Weather AIVM 온체인 기상 데이터 오라클 인프라

**🛰️ 라이브 데모: https://agent.kweather.co.kr**
**⛓️ 온체인 dApp (BNB Smart Chain Testnet): https://agent.kweather.co.kr/dapp**

> **자체 서버 배포(이관):** Vercel 없이 케이웨더 자체 서버에서 `node server.js` 한 줄로 구동합니다
> (웹 + API 단일 프로세스). Docker·nginx·TLS·도메인(`agent.kweather.co.kr`)·크론 설정은 **[DEPLOY.md](DEPLOY.md)** 참고.

### 배포된 컨트랙트 (BSC Testnet, chainId 97)
| 컨트랙트 | 주소 |
|---|---|
| KWeatherWorldOracle (세계) | [`0x2A2b4B6530ef062c80fCeEc23ae0d6167eAe9630`](https://testnet.bscscan.com/address/0x2A2b4B6530ef062c80fCeEc23ae0d6167eAe9630) |
| KWeatherKoreaOracle (국내 동단위) | [`0xb303D062e079365479513a951777a35a353b32de`](https://testnet.bscscan.com/address/0xb303D062e079365479513a951777a35a353b32de) |
| SubscriptionManager | [`0xA34D6B699f16ed574A574a3E2b18ce063da4d911`](https://testnet.bscscan.com/address/0xA34D6B699f16ed574A574a3E2b18ce063da4d911) |
| KWT 토큰 | [`0x04090599Dbaa990eabC37fFBDE223A4eD02e5b20`](https://testnet.bscscan.com/address/0x04090599Dbaa990eabC37fFBDE223A4eD02e5b20) |

릴레이어(`/api/relay`, 매시 정각 크론)가 실날씨를 온체인에 발행하고, 자율 AI 에이전트
(`/api/agent`, 매시 30분 크론)가 스스로 구독 결제 후 온체인 쿼리를 실행합니다. 누구나 지갑을
연결해 KWT를 받고 구독·종량제로 결제한 뒤 온체인 쿼리를 할 수 있습니다.

**전 세계 4,255개 도시**의 실시간 기상 데이터(케이웨더 세계날씨 실황 `kw-world-r1` + 시계열 예보 `kw-world-3d1`)를
AIVM/EVM 호환 네트워크에 **온체인 오라클**로 공급하고, 자율형 AI 에이전트가 구독/종량제로
안전하게 소비하도록 하는 참조 구현(reference implementation)입니다. (PRD 기반)

판매 카탈로그는 인구 상위 4,255개 세계 도시(GeoNames)이며, 각 도시의 `geonameid`가 온체인
지역 코드로 쓰입니다. 라이브 대시보드에서 도시명으로 검색하고, dApp에서 임의의 도시를
온체인에 즉시 발행(on-demand) 후 결제·조회할 수 있습니다.

실행 가능한 풀 파이프라인을 포함합니다:

```
케이웨더 프리미엄 API ──▶ 오라클 노드(Off-chain)  ──▶ 온체인 레지스트리  ──▶ AI 에이전트
   (Web2 JSON float)      정제·고정소수점 스케일링       O(1) 지역 조회 +        구독/종량제로
                          (TEE 내 API Key 관리)         시계열 링버퍼            시계열 쿼리·자율 결정
```

## 구성 요소

| 레이어 | 파일 | 역할 |
|---|---|---|
| 온체인 레지스트리 | [contracts/KWeatherOracle.sol](contracts/KWeatherOracle.sol) | 지역코드 인덱스 기반 O(1) 최신값 조회, 168시간(7일) 링버퍼 시계열, 배치 인게스천, 미터링된 읽기 |
| 수익화 | [contracts/SubscriptionManager.sol](contracts/SubscriptionManager.sol) | 월 구독(레이트리밋) + 종량제(pay-per-query) 결제. 오라클만 `consume` 호출 가능 |
| 결제 토큰 | [contracts/MockERC20.sol](contracts/MockERC20.sol) | KWT 모의 ERC-20 (구독료/종량제 정산) |
| 오라클 노드 | [oracle-node/kweatherClient.js](oracle-node/kweatherClient.js) | 케이웨더 프리미엄 API 호출(실데이터/모의 자동전환). API Key 신뢰경계 |
| 스케일러 | [oracle-node/scaler.js](oracle-node/scaler.js) | float → 고정소수점 정수 변환 (예: 4.25 MJ/m² → 425) |
| 릴레이어 | [oracle-node/relayer.js](oracle-node/relayer.js) | 정제·스케일링 후 `pushBatch`로 온체인 전송 |
| AI 에이전트 | [agent/energyAgent.js](agent/energyAgent.js) | 시계열 쿼리 → 발전량 예측 → 자율 결정 (PRD §4.1) |

## 빠른 시작

```bash
npm install
npm run compile     # 컨트랙트 컴파일
npm test            # 유닛 테스트 (스케일링/접근제어/미터링/시계열)
npm run demo        # 엔드투엔드 데모 (인메모리 hardhat 네트워크)
```

`npm run demo`는 컨트랙트 배포 → 24시간 시계열 인게스천(5개 지역) → 에너지 에이전트 구독·예측
→ 애그리테크 에이전트 종량제 쿼리까지 전 과정을 한 번에 실행합니다.

## 실제 케이웨더 API 연동

`.env`에 키를 설정하면 오라클 노드가 자동으로 **실데이터 모드(REAL)**로 전환됩니다.
키가 없으면 결정론적 **모의 모드(MOCK)**로 동작하므로 외부 의존성 없이 실행됩니다.

```bash
cp .env.example .env
# KWEATHER_API_KEY=발급받은_키
```

실데이터 모드는 실제 K-Weather 게이트웨이 규약을 그대로 사용합니다
(참조: [reference/kweather-frontend.reference.jsx](reference/kweather-frontend.reference.jsx)):

```
GET {BASE}/{sensor}/{법정동코드}?api_key=KEY
BASE = https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors
응답 = { error:"0", message, data: { "<법정동코드>": { data:{...} } } }
```

하나의 관측값은 여러 센서를 조합해 구성합니다:

| 항목 | 센서 | 필드 |
|---|---|---|
| 기온/습도/강수/풍속/풍향 | `kw-odam1` → `kw-odam2`(시군구 폴백) | `t1h`, `reh`, `rn1`, `wsd`, `vec` |
| 미세먼지 | `kw-dust-r1` → `kw-dust-r2` | `pm10`, `pm25` |
| 자외선 | `kw-fct-idx-uv1` | `uv[]`(시간별) |

> **일사량(solarRadiation):** 위 게이트웨이 센서셋에는 일사량이 노출되지 않습니다(REAL 모드에서 0).
> 프리미엄 일사 센서가 포함된 플랜이면 [kweatherClient.js](oracle-node/kweatherClient.js)의
> `solarRadiation` 후보 필드명을 실제 응답에 맞게 추가하세요. 스케일링 계수는
> [scaler.js](oracle-node/scaler.js)의 `SCALE`과 컨트랙트 struct 주석이 일치해야 합니다.

## 실제 네트워크 배포 + 상시 릴레이어

```bash
# 1) 로컬 노드 (별도 터미널)
npm run node

# 2) 배포 (주소가 deployments.<network>.json 에 저장됨)
npx hardhat run scripts/deploy.js --network localhost

# 3) 상시 릴레이어 (1시간 주기로 온체인 push)
#    .env: RPC_URL, RELAYER_PRIVATE_KEY, DEPLOYMENT_FILE
npm run relayer
```

임의의 EVM/AIVM 호환 네트워크는 `.env`의 `RPC_URL` + `DEPLOYER_PRIVATE_KEY`를 설정하고
`--network custom`으로 배포합니다.

## 온체인 데이터 모델 (PRD §6.1)

```solidity
struct KWeatherWorldData {        // K-Weather 세계날씨 실측 필드만
    uint256 timestamp;       // 관측 유닉스 타임스탬프
    int256  temperature;     // 기온    (℃ * 100)
    int256  senseTemp;       // 체감온도 (℃ * 100)
    uint256 humidity;        // 습도    (%)
    uint256 precipitation;   // 강수량  (mm * 100)
    uint256 windSpeed;       // 풍속    (m/s * 100)
    uint256 windDirection;   // 풍향    (0-360)
    uint256 pressure;        // 기압    (hPa * 100)
    uint256 visibility;      // 가시거리 (m)
    uint256 snowfall;        // 적설    (cm * 100)
    uint256 discomfortIndex; // 불쾌지수 (* 10)
}
```

## 에이전트가 사용하는 핵심 인터페이스

```solidity
// 최신값 (미터링: 구독 한도 또는 종량제 차감)
function queryLatest(uint256 regionCode) external returns (KWeatherPremiumData memory);

// 시계열 배열 — LSTM/Transformer 입력용 (미터링 1회)
function queryHistory(uint256 regionCode, uint256 count)
    external returns (KWeatherPremiumData[] memory);
```

```solidity
// 구독: 월 단위 토큰 예치 → 쿼리 한도(레이트리밋) 부여
function subscribe(uint256 months) external;
// 종량제: 선불 예치 후 호출당 차감
function depositPrepaid(uint256 amount) external;
```

## x402 키리스 결제 — 멀티에셋 (USDT 지원)

API 키도 계정도 없이 **요청마다 서명 한 번**으로 결제합니다. `GET /api/paid-weather?city=` 의 첫 호출은
**HTTP 402** + 결제 가능한 자산 메뉴(`accepts[]`)를 반환하고, 소비자는 자산을 골라 서명한 뒤
`X-PAYMENT` 헤더로 재요청하면 서버가 온체인 정산 후 날씨를 돌려줍니다.

| 자산(id) | 심볼 | 정산 레일 | 네트워크 | 소비자 가스 |
|---|---|---|---|---|
| `x402usd` | x402USD | EIP-3009 | BSC testnet | 없음 (서명만) |
| `usdt-testnet` | USDT | EIP-3009 | BSC testnet | 없음 (서명만) |
| `usdt-testnet-permit2` | USDT | Permit2 | BSC testnet | 최초 1회 `approve(Permit2)` |
| `usdt-mainnet` | USDT | Permit2 | BSC mainnet | 최초 1회 `approve(Permit2)` |

> **메인넷 실 USDT 활성화:** `X402_ENABLE_MAINNET=true` + `RPC_URL_MAINNET` 설정(완료) 후, **릴레이어
> 지갑에 메인넷 BNB(≥0.002) 펀딩**이 필요합니다. 402는 릴레이어가 정산 가스를 가질 때만 `usdt-mainnet`을
> 노출합니다(라이브니스 게이트) — 미펀딩 상태에서는 소비자가 헛되이 가스를 쓰지 않도록 자동 숨김. 펀딩 즉시 자동 노출.
> 소비자 측은 실 USDT 보유 + 최초 1회 `approve(Permit2)`(실 BNB 가스 1회)가 필요합니다.

**왜 USDT는 Permit2인가?** 실제 BSC USDT(`0x55d398…`)는 EIP-3009도 EIP-2612 permit도 지원하지 않아
가스리스 서명 전송이 불가능합니다. 그래서 Uniswap **Permit2**(`SignatureTransfer`)를 씁니다 — 소비자는
토큰에 **최초 1회 `approve(Permit2)`** 만 하면(가스 1번), 이후 요청은 **서명만** 으로 릴레이어가
`permitTransferFrom` 을 대납 제출해 정산합니다.

```bash
node scripts/x402-client.mjs "Tokyo"                       # x402USD (가스리스)
node scripts/x402-client.mjs "Tokyo" USDT                  # USDT EIP-3009 (가스리스)
node scripts/x402-client.mjs "London" usdt-testnet-permit2 # USDT via Permit2 (실 USDT 레일)
```

검증(테스트넷 실거래): USDT EIP-3009 [tx](https://testnet.bscscan.com/tx/0xeca64ddfbe1d7a3fe5a2b9ac82c1a43bce2168c9e2bf21e7e73724a7670a52f4) ·
USDT Permit2 [tx](https://testnet.bscscan.com/tx/0x545b26f1894f0506cb9fbb5409eb1e58ea2fd34efba1eff7cd0985e931a85a0d).
MCP 도구: `pay_x402(city, asset?)`.

## 온체인 의사결정 상품 (Decision Products)

오라클의 **온체인 날씨**를 도메인별 실행 가능한 의사결정으로 바꾸는 상품 카탈로그입니다.
`GET /api/decision?city=<도시명|id>`는 해당 도시에 대해 전 상품을, `&product=<id>`는 단일 상품을
실행합니다(파라미터 없이 호출 시 카탈로그). 각 상품은 온체인 데이터를 읽어
`{ signal, action, score(0~1), rationale, metrics }`를 반환합니다.

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
상품의 결정을 반환합니다. dApp의 “🧠 온체인 의사결정 상품” 패널, MCP `list_decision_products()` /
`decide(city, product?)`로도 사용할 수 있습니다. 결정은 온체인 데이터 기반이며, 피드 소비는 미터링
쿼리 또는 x402로 정산됩니다.

```bash
curl "https://agent.kweather.co.kr/api/decision?city=Jakarta&product=flood-watch"
```

## 보안 노트

- **API Key 신뢰경계:** 키는 오라클 노드(프로덕션은 TEE/엔클레이브) 내부에만 존재하며 온체인에 노출되지 않습니다. (PRD §5.1)
- **인게스천 접근제어:** `pushWeather`/`pushBatch`는 owner가 승인한 릴레이어만 호출 가능.
- **미터링 무결성:** `SubscriptionManager.consume`은 오라클 컨트랙트만 호출 가능(직접 호출 차단). 테스트로 검증됨.
- `MockERC20.mint`는 데모 편의용으로 공개되어 있습니다. 실제 배포 전 접근제어를 추가하세요.
- 본 구현은 참조용 MVP입니다. 메인넷 배포 전 보안 감사와 다중 릴레이어/집계(median) 등 탈중앙화 강화가 필요합니다.
