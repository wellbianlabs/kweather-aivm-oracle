# K-Weather AIVM 온체인 기상 데이터 오라클 인프라

**🛰️ 라이브 데모: https://kweather-aivm-oracle-wellbianlabs.vercel.app**

케이웨더(K-Weather) 프리미엄 API의 고정밀 국지성 기상 데이터를 AIVM/EVM 호환 네트워크에
**온체인 오라클**로 공급하고, 자율형 AI 에이전트가 구독/종량제로 안전하게 소비하도록 하는
참조 구현(reference implementation)입니다. (PRD 기반)

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
struct KWeatherPremiumData {
    uint256 timestamp;       // 관측 유닉스 타임스탬프
    int256  temperature;     // 기온  (℃ * 100)
    uint256 humidity;        // 습도  (%)
    uint256 precipitation;   // 강수량 (mm * 100)
    uint256 windSpeed;       // 풍속  (m/s * 100)
    uint256 windDirection;   // 풍향  (0-360)
    uint256 pm10;            // 미세먼지   (㎍/㎥)
    uint256 pm25;            // 초미세먼지 (㎍/㎥)
    uint256 solarRadiation;  // 일사량 (MJ/m² * 100)
    uint256 uvIndex;         // 자외선 지수 (* 10)
    uint256 discomfortIndex; // 불쾌지수    (* 10)
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

## 보안 노트

- **API Key 신뢰경계:** 키는 오라클 노드(프로덕션은 TEE/엔클레이브) 내부에만 존재하며 온체인에 노출되지 않습니다. (PRD §5.1)
- **인게스천 접근제어:** `pushWeather`/`pushBatch`는 owner가 승인한 릴레이어만 호출 가능.
- **미터링 무결성:** `SubscriptionManager.consume`은 오라클 컨트랙트만 호출 가능(직접 호출 차단). 테스트로 검증됨.
- `MockERC20.mint`는 데모 편의용으로 공개되어 있습니다. 실제 배포 전 접근제어를 추가하세요.
- 본 구현은 참조용 MVP입니다. 메인넷 배포 전 보안 감사와 다중 릴레이어/집계(median) 등 탈중앙화 강화가 필요합니다.
