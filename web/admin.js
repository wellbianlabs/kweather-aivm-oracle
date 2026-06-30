/* KWeather × AIVM — read-only admin/ops dashboard. Public on-chain data via RPC; no wallet. */
"use strict";

const CFG = window.DAPP_CONFIG;
const $ = (id) => document.getElementById(id);

// public ops wallets (testnet)
const WALLETS = {
  "트레저리 · Treasury": "0x77AC0aa9bE15b6272D54Df10Dc24EECAAc77f9db",
  "릴레이어 · Relayer": "0xd3C3c6E228f6137D53f6eE0E70681C6bC5D196a9",
  "에이전트 · Agent": "0x7654dbB95565eb569e4a2aEBa822402338aaB67E",
};
const TREASURY = WALLETS["트레저리 · Treasury"];

const TOKEN_ABI = window.ABI.token.concat(["function totalSupply() view returns (uint256)"]);
const SM_ABI = window.ABI.sm;

let provider;
const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const fmtKwt = (wei) => Number(ethers.formatUnits(wei, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtTime = (u) => (u ? new Intl.DateTimeFormat(navigator.language || "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(u * 1000)) : "—");
const aLink = (a) => `${CFG.explorer}/address/${a}`;
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const fail = (id, e) => { const el = $(id); if (el) el.innerHTML = `<span class="bad">조회 실패 · failed:</span> ${String(e.message || e).slice(0, 80)}`; };

async function coverage() {
  try {
    const w = new ethers.Contract(CFG.oracle, window.ABI.oracle, provider);
    const k = new ethers.Contract(CFG.koreaOracle, window.ABI.oracleKorea, provider);
    const [wr, kr] = await Promise.all([w.getRegions(), k.getRegions()]);
    // latest observation time across a small sample of world regions (relayer freshness)
    const sample = wr.slice(0, 8);
    const peeks = await Promise.allSettled(sample.map((c) => w.peekLatest(c)));
    const latest = peeks.reduce((m, p) => (p.status === "fulfilled" ? Math.max(m, Number(p.value.timestamp)) : m), 0);
    $("coverage").innerHTML =
      `<div class="big">${(wr.length + kr.length).toLocaleString()}</div><div class="sub" style="margin-bottom:10px">온체인 등록 지역 합계 · regions on-chain</div>` +
      kv("🌏 세계 오라클 · World", wr.length.toLocaleString()) +
      kv("🇰🇷 국내 동단위 · Korea 동", kr.length.toLocaleString()) +
      kv("🕐 최근 관측(세계 표본) · latest obs", fmtTime(latest)) +
      kv("판매 카탈로그 · catalog", "4,255 세계 + 3,561 국내");
  } catch (e) { fail("coverage", e); }
}

async function settlement() {
  try {
    const token = new ethers.Contract(CFG.token, TOKEN_ABI, provider);
    const [supply, treas] = await Promise.all([token.totalSupply(), token.balanceOf(TREASURY)]);
    $("settlement").innerHTML =
      `<div class="big">${fmtKwt(treas)} <span class="sub">KWT</span></div><div class="sub" style="margin-bottom:10px">트레저리 누적 정산 · treasury accrued</div>` +
      kv("KWT 총발행 · total supply", fmtKwt(supply)) +
      kv("트레저리 주소 · treasury", `<a class="ext" href="${aLink(TREASURY)}" target="_blank">${short(TREASURY)} ↗</a>`) +
      kv("결제 토큰 · token", "KWT (ERC-20)");
  } catch (e) { fail("settlement", e); }
}

async function wallets() {
  try {
    const token = new ethers.Contract(CFG.token, TOKEN_ABI, provider);
    const rows = await Promise.all(Object.entries(WALLETS).map(async ([label, addr]) => {
      const [bal, kwt] = await Promise.all([provider.getBalance(addr), token.balanceOf(addr)]);
      const gas = Number(ethers.formatEther(bal));
      const low = gas < 0.005 ? ' class="warn"' : ' class="ok"';
      return kv(`${label} <span class="addr"><a class="ext" href="${aLink(addr)}" target="_blank">${short(addr)}↗</a></span>`,
        `<span${low}>${gas.toFixed(4)} ${CFG.currency || "tBNB"}</span> · ${fmtKwt(kwt)} KWT`);
    }));
    $("wallets").innerHTML = `<div class="hint" style="margin-bottom:8px">가스(테스트넷 ${CFG.currency || "tBNB"}) + KWT 잔액. 릴레이어 가스 부족 시 발행 중단됩니다.</div>` + rows.join("");
  } catch (e) { fail("wallets", e); }
}

async function pricing() {
  try {
    const w = new ethers.Contract(CFG.subscriptionManager, SM_ABI, provider);
    const k = new ethers.Contract(CFG.koreaSubscriptionManager, SM_ABI, provider);
    const [wm, wq, wpq, km, kq, kpq] = await Promise.all([
      w.monthlyPrice(), w.queriesPerMonth(), w.pricePerQuery(),
      k.monthlyPrice(), k.queriesPerMonth(), k.pricePerQuery(),
    ]);
    const block = (m, q, pq) => kv("월 구독 · monthly", `${fmtKwt(m)} KWT`) + kv("월 쿼리 한도 · allowance", `${q.toString()}`) + kv("종량제 · per query", `${fmtKwt(pq)} KWT`);
    $("pricing").innerHTML =
      `<div class="sub" style="margin:2px 0 6px">🌏 세계 · World</div>` + block(wm, wq, wpq) +
      `<div class="sub" style="margin:12px 0 6px">🇰🇷 국내 · Korea</div>` + block(km, kq, kpq);
  } catch (e) { fail("pricing", e); }
}

function contracts() {
  const link = (label, addr) => kv(label, addr ? `<a class="ext" href="${aLink(addr)}" target="_blank">${short(addr)} ↗</a>` : "—");
  $("contracts").innerHTML =
    `<div class="hint" style="margin-bottom:8px">${CFG.chainName} · chainId ${CFG.chainId} · <a class="ext" href="${CFG.explorer}" target="_blank">${CFG.explorer} ↗</a></div>` +
    link("세계 오라클 · World oracle", CFG.oracle) +
    link("국내 오라클 · Korea oracle", CFG.koreaOracle) +
    link("세계 구독 · World SM", CFG.subscriptionManager) +
    link("국내 구독 · Korea SM", CFG.koreaSubscriptionManager) +
    link("KWT 토큰 · token", CFG.token);
}

// ── admin gate: only the owner/treasury wallet may view this page ──
const ADMIN_ALLOW = [TREASURY.toLowerCase()]; // owner wallet = admin

function reveal() {
  $("adminGate").style.display = "none";
  $("adminContent").style.display = "block";
  $("refreshBtn").style.display = "";
  $("disconnectBtn").style.display = "";
  loadAll();
}
function deny(addr) {
  $("gateMsg").innerHTML = `<span class="bad">접근 권한 없음 · access denied</span><br>연결된 지갑 <span class="addr">${addr.slice(0, 6)}…${addr.slice(-4)}</span> 은 관리자가 아닙니다. 관리자(소유자) 지갑으로 연결하세요.`;
}
async function connectAdmin() {
  if (!window.ethereum) { $("gateMsg").innerHTML = '<span class="warn">MetaMask 등 EVM 지갑이 필요합니다 · an EVM wallet is required.</span>'; return; }
  $("gateMsg").textContent = "연결 중… · connecting…";
  try {
    const bp = new ethers.BrowserProvider(window.ethereum);
    await bp.send("eth_requestAccounts", []);
    const addr = await (await bp.getSigner()).getAddress();
    if (ADMIN_ALLOW.includes(addr.toLowerCase())) reveal(); else deny(addr);
  } catch (e) { $("gateMsg").innerHTML = `<span class="bad">${String((e && (e.shortMessage || e.message)) || e).slice(0, 90)}</span>`; }
}
function loadAll() {
  if (!CFG) { $("coverage").innerHTML = '<span class="warn">미배포 · not deployed</span>'; return; }
  provider = new ethers.JsonRpcProvider(CFG.rpc);
  ["coverage", "settlement", "wallets", "pricing"].forEach((id) => ($(id).innerHTML = "불러오는 중… · loading…"));
  coverage(); settlement(); wallets(); pricing(); contracts();
}

document.addEventListener("DOMContentLoaded", async () => {
  $("gateConnect").addEventListener("click", connectAdmin);
  $("refreshBtn").addEventListener("click", loadAll);
  $("disconnectBtn").addEventListener("click", () => location.reload());
  // silent unlock if the owner wallet is already connected
  if (window.ethereum) {
    try { const a = await window.ethereum.request({ method: "eth_accounts" }); if (a && a[0] && ADMIN_ALLOW.includes(a[0].toLowerCase())) reveal(); } catch (_) {}
    window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
  }
});
