/* KWeather × AIVM on-chain dApp (Base Sepolia). Requires ethers UMD + dapp-config.js + abi.js. */
"use strict";

const CFG = window.DAPP_CONFIG;
const REGIONS = [
  { code: 1168000000, name: "서울 강남구" },
  { code: 2611000000, name: "부산 중구" },
  { code: 4617000000, name: "전남 나주시" },
  { code: 4380000000, name: "충북 영동군" },
  { code: 5011000000, name: "제주 제주시" },
];

let provider, signer, account;
let token, sm, oracle; // signer-connected
let roToken, roSm, roOracle; // read-only

const $ = (id) => document.getElementById(id);
const fmt = (wei) => Number(ethers.formatUnits(wei, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const txLink = (h) => `${CFG.explorer}/tx/${h}`;
const addrLink = (a) => `${CFG.explorer}/address/${a}`;

function unscale(d) {
  return {
    timestamp: Number(d.timestamp),
    temperature: Number(d.temperature) / 100,
    humidity: Number(d.humidity),
    precipitation: Number(d.precipitation) / 100,
    windSpeed: Number(d.windSpeed) / 100,
    windDirection: Number(d.windDirection),
    pm10: Number(d.pm10),
    pm25: Number(d.pm25),
    solarRadiation: Number(d.solarRadiation) / 100,
    uvIndex: Number(d.uvIndex) / 10,
    discomfortIndex: Number(d.discomfortIndex) / 10,
  };
}

function notDeployed() {
  $("statusBody").innerHTML = `<span class="warn">아직 온체인에 배포되지 않았습니다.</span> 곧 컨트랙트 주소가 채워집니다.`;
}

function initReadOnly() {
  provider = new ethers.JsonRpcProvider(CFG.rpc);
  roToken = new ethers.Contract(CFG.token, window.ABI.token, provider);
  roSm = new ethers.Contract(CFG.subscriptionManager, window.ABI.sm, provider);
  roOracle = new ethers.Contract(CFG.oracle, window.ABI.oracle, provider);
  $("oracleLink").href = addrLink(CFG.oracle);
  $("explorerFoot").href = CFG.explorer;
}

async function refreshStatus() {
  try {
    const regions = await roOracle.getRegions();
    const rows = await Promise.all(
      regions.map(async (code) => {
        const cnt = await roOracle.observationCount(code);
        let temp = "—", ts = 0;
        if (cnt > 0n) {
          const d = unscale(await roOracle.peekLatest(code));
          temp = d.temperature.toFixed(1) + "℃";
          ts = d.timestamp;
        }
        const name = REGIONS.find((r) => r.code === Number(code))?.name || code;
        const when = ts ? new Date(ts * 1000).toLocaleString("ko-KR", { hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" }) : "데이터 없음";
        return `<div class="kv"><span class="k">${name} <span class="addr">#${cnt}</span></span><span class="v">${temp} <span class="addr">${when}</span></span></div>`;
      })
    );
    $("statusBody").innerHTML =
      `<div class="kv"><span class="k">오라클</span><span class="v"><a class="ext" href="${addrLink(CFG.oracle)}" target="_blank">${short(CFG.oracle)} ↗</a></span></div>` +
      `<div class="kv"><span class="k">KWT 토큰</span><span class="v"><a class="ext" href="${addrLink(CFG.token)}" target="_blank">${short(CFG.token)} ↗</a></span></div>` +
      `<div class="kv"><span class="k">구독 매니저</span><span class="v"><a class="ext" href="${addrLink(CFG.subscriptionManager)}" target="_blank">${short(CFG.subscriptionManager)} ↗</a></span></div>` +
      `<hr style="border-color:var(--line);margin:10px 0">` +
      (rows.length ? rows.join("") : `<div class="kv"><span class="k">온체인 데이터</span><span class="v warn">릴레이어 대기 중</span></div>`);
  } catch (e) {
    $("statusBody").innerHTML = `<span class="bad">상태 조회 실패:</span> ${e.message}`;
  }
}

async function connect() {
  if (!window.ethereum) { alert("MetaMask 등 EVM 지갑이 필요합니다."); return; }
  const bp = new ethers.BrowserProvider(window.ethereum);
  await bp.send("eth_requestAccounts", []);
  // ensure Base Sepolia
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.chainHex }] });
  } catch (e) {
    if (e.code === 4902) {
      const sym = CFG.currency || "ETH";
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: CFG.chainHex, chainName: CFG.chainName, nativeCurrency: { name: sym, symbol: sym, decimals: 18 }, rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer] }],
      });
    }
  }
  signer = await bp.getSigner();
  account = await signer.getAddress();
  token = new ethers.Contract(CFG.token, window.ABI.token, signer);
  sm = new ethers.Contract(CFG.subscriptionManager, window.ABI.sm, signer);
  oracle = new ethers.Contract(CFG.oracle, window.ABI.oracle, signer);
  $("connectBtn").textContent = short(account);
  ["faucetBtn", "subBtn", "prepayBtn", "queryBtn"].forEach((id) => ($(id).disabled = false));
  await refreshWallet();
}

async function refreshWallet() {
  if (!account) return;
  const [eth, kwt, sub, prepaid] = await Promise.all([
    provider.getBalance(account),
    roToken.balanceOf(account),
    roSm.quotaOf(account),
    roSm.prepaidBalance(account),
  ]);
  $("walletBody").innerHTML =
    `<div class="kv"><span class="k">주소</span><span class="v"><a class="ext" href="${addrLink(account)}" target="_blank">${short(account)} ↗</a></span></div>` +
    `<div class="kv"><span class="k">${CFG.currency || "ETH"} (가스)</span><span class="v">${Number(ethers.formatEther(eth)).toFixed(4)}</span></div>` +
    `<div class="kv"><span class="k">KWT 잔액</span><span class="v">${fmt(kwt)}</span></div>`;
  const active = BigInt(sub[0]) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(sub[1]) > 0n;
  $("accessBody").innerHTML =
    `<div class="kv"><span class="k">구독 상태</span><span class="v ${active ? "ok" : "warn"}">${active ? "활성" : "없음"}</span></div>` +
    `<div class="kv"><span class="k">남은 쿼리 한도</span><span class="v">${sub[1]}</span></div>` +
    `<div class="kv"><span class="k">종량제 선불 잔액</span><span class="v">${fmt(prepaid)} KWT</span></div>`;
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (e) { alert((e && (e.shortMessage || e.message)) || e); }
  btn.disabled = false; btn.textContent = old;
}

async function faucet() {
  await withBusy($("faucetBtn"), "민팅 중…", async () => {
    await (await token.mint(account, ethers.parseUnits("1000", 18))).wait();
    await refreshWallet();
  });
}

async function subscribe() {
  await withBusy($("subBtn"), "구독 처리 중…", async () => {
    const price = await roSm.monthlyPrice();
    const allowance = await roToken.allowance(account, CFG.subscriptionManager);
    if (allowance < price) await (await token.approve(CFG.subscriptionManager, price)).wait();
    await (await sm.subscribe(1)).wait();
    await refreshWallet();
  });
}

async function prepay() {
  await withBusy($("prepayBtn"), "예치 중…", async () => {
    const amt = ethers.parseUnits("10", 18);
    const allowance = await roToken.allowance(account, CFG.subscriptionManager);
    if (allowance < amt) await (await token.approve(CFG.subscriptionManager, amt)).wait();
    await (await sm.depositPrepaid(amt)).wait();
    await refreshWallet();
  });
}

function renderWeather(code, d, extra) {
  const name = REGIONS.find((r) => r.code === Number(code))?.name || code;
  return (
    `[${name}] @ ${new Date(d.timestamp * 1000).toLocaleString("ko-KR")}\n` +
    `기온 ${d.temperature.toFixed(1)}℃ · 습도 ${d.humidity}% · 강수 ${d.precipitation}mm\n` +
    `풍속 ${d.windSpeed}m/s · PM10 ${d.pm10} · PM2.5 ${d.pm25}\n` +
    `일사량 ${d.solarRadiation}MJ/m² · UV ${d.uvIndex} · 불쾌지수 ${d.discomfortIndex}\n` +
    (extra || "")
  );
}

async function query() {
  const code = $("regionSel").value;
  await withBusy($("queryBtn"), "온체인 결제·조회 중…", async () => {
    const data = unscale(await oracle.queryLatest.staticCall(code)); // read decoded result
    const tx = await oracle.queryLatest(code); // metered tx (consume quota / pay)
    $("queryResult").textContent = renderWeather(code, data, `tx 전송됨: ${tx.hash}\n확정 대기 중…`);
    const receipt = await tx.wait();
    $("queryResult").innerHTML =
      renderWeather(code, data).replace(/\n/g, "<br>") +
      `<br><span class="ok">✓ 결제·조회 완료</span> · <a class="ext" href="${txLink(tx.hash)}" target="_blank">tx ↗</a> (block ${receipt.blockNumber})`;
    await refreshWallet();
  });
}

async function peek() {
  const code = $("regionSel").value;
  await withBusy($("peekBtn"), "조회 중…", async () => {
    const cnt = await roOracle.observationCount(code);
    if (cnt === 0n) { $("queryResult").textContent = "이 지역은 아직 온체인 데이터가 없습니다 (릴레이어 대기)."; return; }
    const data = unscale(await roOracle.peekLatest(code));
    $("queryResult").innerHTML = renderWeather(code, data, "(무료 미리보기 — 결제·미터링 없음)").replace(/\n/g, "<br>");
  });
}

async function runAgent() {
  await withBusy($("agentBtn"), "에이전트 실행 중…", async () => {
    $("agentResult").textContent = "에이전트 봇이 구독·결제 후 온체인 쿼리를 실행 중…";
    const r = await fetch("/api/agent");
    const j = await r.json();
    if (j.error) { $("agentResult").textContent = "에러: " + j.error; return; }
    const f = j.forecast || {};
    let html =
      `🤖 에이전트 ${short(j.agent)} (${j.region})\n` +
      `표본 ${j.samples}h · 평균 일사량 ${f.avgSolar} MJ/m² · 가동률 ${(f.util * 100).toFixed(0)}%\n` +
      `예측 발전량 ${f.kwh?.toLocaleString()} kWh/6h\n` +
      `→ 자율 결정: ${j.decision}\n` +
      `남은 구독 한도: ${j.quotaRemaining}`;
    html = html.replace(/\n/g, "<br>");
    if (j.paidThisRun) html += `<br><span class="ok">결제: 구독 1개월</span> · <a class="ext" href="${txLink(j.paidThisRun.txHash)}" target="_blank">tx ↗</a>`;
    if (j.queryTxHash) html += `<br><span class="ok">온체인 쿼리</span> · <a class="ext" href="${txLink(j.queryTxHash)}" target="_blank">tx ↗</a>`;
    $("agentResult").innerHTML = html;
    refreshStatus();
  });
}

async function relayNow() {
  await withBusy($("relayBtn"), "릴레이 중…", async () => {
    $("agentResult").textContent = "릴레이어가 실제 날씨를 온체인에 발행 중…";
    const r = await fetch("/api/relay");
    const j = await r.json();
    if (j.error) { $("agentResult").textContent = "릴레이 에러: " + j.error; return; }
    $("agentResult").innerHTML =
      `📡 ${j.regions}개 지역 온체인 발행 완료 · <a class="ext" href="${txLink(j.txHash)}" target="_blank">tx ↗</a> (block ${j.block}, gas ${j.gasUsed})`;
    refreshStatus();
  });
}

function main() {
  $("regionSel").innerHTML = REGIONS.map((r) => `<option value="${r.code}">${r.name}</option>`).join("");
  if (!CFG) { notDeployed(); return; }
  $("netBadge").textContent = `${CFG.chainName} · 실제 온체인`;
  $("walletHint").textContent = `${CFG.chainName} 지갑(MetaMask 등)을 연결하세요. 가스비는 테스트넷 ${CFG.currency || "ETH"}입니다.`;
  initReadOnly();
  $("connectBtn").addEventListener("click", connect);
  $("faucetBtn").addEventListener("click", faucet);
  $("subBtn").addEventListener("click", subscribe);
  $("prepayBtn").addEventListener("click", prepay);
  $("queryBtn").addEventListener("click", query);
  $("peekBtn").addEventListener("click", peek);
  $("agentBtn").addEventListener("click", runAgent);
  $("relayBtn").addEventListener("click", relayNow);
  refreshStatus();
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
}
document.addEventListener("DOMContentLoaded", main);
