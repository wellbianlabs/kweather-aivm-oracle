/* KWeather × AIVM on-chain dApp (BNB Smart Chain Testnet). Requires ethers UMD + dapp-config.js + abi.js.
   Two markets: 세계(World) oracle (GeoNames id) and 국내 동단위(Korea) oracle (10-digit 법정동코드).
   The selected region's code length routes contracts to the right oracle + SubscriptionManager. */
"use strict";

const CFG = window.DAPP_CONFIG;
const WORLD = (window.CITIES || []).map(([id, name, cc, lat, lon]) => ({ id, name, cc, lat, lon }));
const KOREA = (window.KOREA_CITIES || []).map(([id, name, cc, lat, lon]) => ({ id, name, cc, lat, lon }));
const CITIES = [...WORLD, ...KOREA];
const CITY_BY_ID = new Map(CITIES.map((c) => [c.id, c]));
const FEATURED = (window.FEATURED || []).map((f) => ({ id: f.id, name: f.name, cc: f.country, lat: f.lat, lon: f.lon }));

const isDong = (code) => String(code).length === 10; // 10-digit = 법정동(국내)
function cityName(code) {
  const c = CITY_BY_ID.get(Number(code));
  if (c) return isDong(c.id) ? `${c.name} (KR)` : `${c.name}, ${c.cc}`;
  return `region #${code}`;
}

let provider, signer, account;
let roToken, token; // KWT token shared across both markets
let roWorldOracle;   // for the 세계 status panel

const $ = (id) => document.getElementById(id);
const fmt = (wei) => Number(ethers.formatUnits(wei, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

// ---- time: always render in the visitor's local time zone (auto-detected from browser/OS by country) ----
const VISITOR_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })();
const VISITOR_LOCALE = (typeof navigator !== "undefined" && navigator.language) || "en";
const fmtFull = (u) => new Intl.DateTimeFormat(VISITOR_LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(new Date(u * 1000));
const fmtShort = (u) => new Intl.DateTimeFormat(VISITOR_LOCALE, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(u * 1000));
const tzAbbr = (u) => { try { const p = new Intl.DateTimeFormat(VISITOR_LOCALE, { timeZoneName: "short" }).formatToParts(new Date(u * 1000)); return (p.find((x) => x.type === "timeZoneName") || {}).value || ""; } catch { return ""; } };
const txLink = (h) => `${CFG.explorer}/tx/${h}`;
const addrLink = (a) => `${CFG.explorer}/address/${a}`;
const curCode = () => Number($("regionSel").value);
const t = (ko, en) => (window.KW ? window.KW.t(ko, en) : ko); // i18n helper for dynamic strings

// route contracts to the right market for a given region code
function ctx(code) {
  const kr = isDong(code);
  return {
    kr,
    oracleAddr: kr ? CFG.koreaOracle : CFG.oracle,
    smAddr: kr ? CFG.koreaSubscriptionManager : CFG.subscriptionManager,
    oabi: kr ? window.ABI.oracleKorea : window.ABI.oracle,
    unscale: kr ? unscaleKorea : unscale,
  };
}
const roOracleOf = (code) => new ethers.Contract(ctx(code).oracleAddr, ctx(code).oabi, provider);
const oracleSignerOf = (code) => new ethers.Contract(ctx(code).oracleAddr, ctx(code).oabi, signer);
const roSmOf = (code) => new ethers.Contract(ctx(code).smAddr, window.ABI.sm, provider);
const smSignerOf = (code) => new ethers.Contract(ctx(code).smAddr, window.ABI.sm, signer);

function unscale(d) {
  return {
    timestamp: Number(d.timestamp), temperature: Number(d.temperature) / 100, senseTemp: Number(d.senseTemp) / 100,
    humidity: Number(d.humidity), precipitation: Number(d.precipitation) / 100, windSpeed: Number(d.windSpeed) / 100,
    windDirection: Number(d.windDirection), pressure: Number(d.pressure) / 100, visibility: Number(d.visibility),
    snowfall: Number(d.snowfall) / 100, discomfortIndex: Number(d.discomfortIndex) / 10,
  };
}
function unscaleKorea(d) {
  return {
    timestamp: Number(d.timestamp), temperature: Number(d.temperature) / 100, senseTemp: Number(d.senseTemp) / 100,
    humidity: Number(d.humidity), precipitation: Number(d.precipitation) / 100, windSpeed: Number(d.windSpeed) / 100,
    windDirection: Number(d.windDirection), pm10: Number(d.pm10) / 10, pm25: Number(d.pm25) / 10,
    discomfortIndex: Number(d.discomfortIndex) / 10,
  };
}

function notDeployed() {
  $("statusBody").innerHTML = `<span class="warn">${t("아직 온체인에 배포되지 않았습니다.", "Not deployed on-chain yet.")}</span>`;
}

function initReadOnly() {
  provider = new ethers.JsonRpcProvider(CFG.rpc);
  roToken = new ethers.Contract(CFG.token, window.ABI.token, provider);
  roWorldOracle = new ethers.Contract(CFG.oracle, window.ABI.oracle, provider);
  $("oracleLink").href = addrLink(CFG.oracle);
  $("explorerFoot").href = CFG.explorer;
}

async function refreshStatus() {
  try {
    const regions = await roWorldOracle.getRegions();
    const rows = await Promise.all(
      regions.slice(0, 60).map(async (code) => {
        const cnt = await roWorldOracle.observationCount(code);
        let temp = "—", ts = 0;
        if (cnt > 0n) { const d = unscale(await roWorldOracle.peekLatest(code)); temp = d.temperature.toFixed(1) + "℃"; ts = d.timestamp; }
        const when = ts ? fmtShort(ts) : t("데이터 없음", "no data");
        return `<div class="kv"><span class="k">${cityName(code)} <span class="addr">#${cnt}</span></span><span class="v">${temp} <span class="addr">${when}</span></span></div>`;
      })
    );
    $("statusBody").innerHTML =
      `<div class="kv"><span class="k">${t("세계 오라클", "World oracle")}</span><span class="v"><a class="ext" href="${addrLink(CFG.oracle)}" target="_blank">${short(CFG.oracle)} ↗</a></span></div>` +
      `<div class="kv"><span class="k">${t("국내 동단위 오라클", "Korea 동 oracle")}</span><span class="v"><a class="ext" href="${addrLink(CFG.koreaOracle)}" target="_blank">${short(CFG.koreaOracle)} ↗</a></span></div>` +
      `<div class="kv"><span class="k">${t("KWT 토큰", "KWT token")}</span><span class="v"><a class="ext" href="${addrLink(CFG.token)}" target="_blank">${short(CFG.token)} ↗</a></span></div>` +
      `<hr style="border-color:var(--line);margin:10px 0">` +
      `<div class="hint" style="margin-bottom:6px">${t(`세계 오라클 최신 ${regions.length}개 지역 (국내 동은 검색→조회) · 🕐 모든 시각은 접속 지역 시간대(${VISITOR_TZ})로 표시`, `Latest ${regions.length} world-oracle regions (search to query a Korea 동) · 🕐 all times shown in your local time zone (${VISITOR_TZ})`)}</div>` +
      (rows.length ? rows.join("") : `<div class="kv"><span class="k">${t("온체인 데이터", "On-chain data")}</span><span class="v warn">${t("릴레이어 대기 중", "awaiting relayer")}</span></div>`);
  } catch (e) {
    $("statusBody").innerHTML = `<span class="bad">${t("상태 조회 실패:", "Status query failed:")}</span> ${e.message}`;
  }
}

async function connect() {
  if (!window.ethereum) { alert(t("MetaMask 등 EVM 지갑이 필요합니다.", "An EVM wallet (e.g. MetaMask) is required.")); return; }
  const bp = new ethers.BrowserProvider(window.ethereum);
  await bp.send("eth_requestAccounts", []);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.chainHex }] });
  } catch (e) {
    if (e.code === 4902) {
      const sym = CFG.currency || "ETH";
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: CFG.chainHex, chainName: CFG.chainName, nativeCurrency: { name: sym, symbol: sym, decimals: 18 }, rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer] }] });
    }
  }
  signer = await bp.getSigner();
  account = await signer.getAddress();
  token = new ethers.Contract(CFG.token, window.ABI.token, signer);
  $("connectBtn").textContent = short(account);
  ["faucetBtn", "subBtn", "prepayBtn", "queryBtn"].forEach((id) => ($(id).disabled = false));
  await refreshWallet();
}

async function refreshWallet() {
  if (!account) return;
  const code = curCode();
  const roSm = roSmOf(code);
  const [eth, kwt, sub, prepaid] = await Promise.all([
    provider.getBalance(account), roToken.balanceOf(account), roSm.quotaOf(account), roSm.prepaidBalance(account),
  ]);
  $("walletBody").innerHTML =
    `<div class="kv"><span class="k">${t("주소", "Address")}</span><span class="v"><a class="ext" href="${addrLink(account)}" target="_blank">${short(account)} ↗</a></span></div>` +
    `<div class="kv"><span class="k">${CFG.currency || "ETH"} (${t("가스", "gas")})</span><span class="v">${Number(ethers.formatEther(eth)).toFixed(4)}</span></div>` +
    `<div class="kv"><span class="k">${t("KWT 잔액", "KWT balance")}</span><span class="v">${fmt(kwt)}</span></div>`;
  const active = BigInt(sub[0]) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(sub[1]) > 0n;
  const market = ctx(code).kr ? t("국내 동단위", "Korea 동") : t("세계", "World");
  $("accessBody").innerHTML =
    `<div class="kv"><span class="k">${t("구독 시장", "Market")}</span><span class="v">${market}</span></div>` +
    `<div class="kv"><span class="k">${t("구독 상태", "Subscription")}</span><span class="v ${active ? "ok" : "warn"}">${active ? t("활성", "active") : t("없음", "none")}</span></div>` +
    `<div class="kv"><span class="k">${t("남은 쿼리 한도", "Queries left")}</span><span class="v">${sub[1]}</span></div>` +
    `<div class="kv"><span class="k">${t("종량제 선불 잔액", "Prepaid balance")}</span><span class="v">${fmt(prepaid)} KWT</span></div>`;
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (e) { alert((e && (e.shortMessage || e.message)) || e); }
  btn.disabled = false; btn.textContent = old;
}

async function faucet() {
  await withBusy($("faucetBtn"), t("민팅 중…", "Minting…"), async () => { await (await token.mint(account, ethers.parseUnits("1000", 18))).wait(); await refreshWallet(); });
}

async function subscribe() {
  await withBusy($("subBtn"), t("구독 처리 중…", "Subscribing…"), async () => {
    const code = curCode(); const smAddr = ctx(code).smAddr; const sm = smSignerOf(code); const roSm = roSmOf(code);
    const price = await roSm.monthlyPrice();
    if ((await roToken.allowance(account, smAddr)) < price) await (await token.approve(smAddr, price)).wait();
    await (await sm.subscribe(1)).wait(); await refreshWallet();
  });
}

async function prepay() {
  await withBusy($("prepayBtn"), t("예치 중…", "Depositing…"), async () => {
    const code = curCode(); const smAddr = ctx(code).smAddr; const sm = smSignerOf(code);
    const amt = ethers.parseUnits("10", 18);
    if ((await roToken.allowance(account, smAddr)) < amt) await (await token.approve(smAddr, amt)).wait();
    await (await sm.depositPrepaid(amt)).wait(); await refreshWallet();
  });
}

function renderWeather(code, d, extra) {
  const head = `[${cityName(code)}] @ ${fmtFull(d.timestamp)} ${tzAbbr(d.timestamp)}\n` +
    t(`기온 ${d.temperature.toFixed(1)}℃ (체감 ${d.senseTemp.toFixed(1)}℃) · 습도 ${d.humidity}%\n풍속 ${d.windSpeed}m/s · 풍향 ${d.windDirection}° · 강수 ${d.precipitation}mm\n`,
      `Temp ${d.temperature.toFixed(1)}℃ (feels ${d.senseTemp.toFixed(1)}℃) · Humidity ${d.humidity}%\nWind ${d.windSpeed}m/s · Dir ${d.windDirection}° · Precip ${d.precipitation}mm\n`);
  const extraLine = isDong(code)
    ? t(`미세먼지 PM10 ${d.pm10} · PM2.5 ${d.pm25} · 불쾌지수 ${d.discomfortIndex}\n`, `PM10 ${d.pm10} · PM2.5 ${d.pm25} · Discomfort ${d.discomfortIndex}\n`)
    : t(`기압 ${d.pressure}hPa · 가시거리 ${d.visibility}m · 적설 ${d.snowfall}cm · 불쾌지수 ${d.discomfortIndex}\n`, `Pressure ${d.pressure}hPa · Visibility ${d.visibility}m · Snow ${d.snowfall}cm · Discomfort ${d.discomfortIndex}\n`);
  return head + extraLine + (extra || "");
}

async function query() {
  const code = curCode();
  await withBusy($("queryBtn"), t("처리 중…", "Processing…"), async () => {
    const roOracle = roOracleOf(code), oracle = oracleSignerOf(code);
    const cnt = await roOracle.observationCount(code);
    if (cnt === 0n) {
      const c = CITY_BY_ID.get(code);
      if (!c) throw new Error(t("카탈로그에 없는 지역이라 발행할 수 없습니다.", "Region not in catalog — cannot publish."));
      $("queryResult").textContent = t(`온체인에 없음 → 릴레이어가 ${c.name} 발행 중…`, `Not on-chain → relayer publishing ${c.name}…`);
      const rj = await (await fetch(`/api/relay?id=${code}&lat=${c.lat}&lon=${c.lon}`)).json();
      if (rj.error) throw new Error(t("발행 실패: ", "Publish failed: ") + rj.error);
    }
    const data = ctx(code).unscale(await oracle.queryLatest.staticCall(code));
    const tx = await oracle.queryLatest(code);
    $("queryResult").textContent = renderWeather(code, data, t(`tx 전송됨: ${tx.hash}\n확정 대기 중…`, `tx sent: ${tx.hash}\nawaiting confirmation…`));
    const receipt = await tx.wait();
    $("queryResult").innerHTML = renderWeather(code, data).replace(/\n/g, "<br>") +
      `<br><span class="ok">${t("✓ 결제·조회 완료", "✓ Paid & read")}</span> · <a class="ext" href="${txLink(tx.hash)}" target="_blank">tx ↗</a> (block ${receipt.blockNumber})`;
    await refreshWallet(); refreshStatus();
  });
}

async function peek() {
  const code = curCode();
  await withBusy($("peekBtn"), t("조회 중…", "Reading…"), async () => {
    const roOracle = roOracleOf(code);
    const cnt = await roOracle.observationCount(code);
    if (cnt === 0n) {
      // domestic 동 not yet on-chain → publish on demand then peek
      const c = CITY_BY_ID.get(code);
      if (isDong(code) && c) { const rj = await (await fetch(`/api/relay?id=${code}&lat=${c.lat}&lon=${c.lon}`)).json(); if (rj.error) { $("queryResult").textContent = t("데이터 없음: ", "No data: ") + rj.error; return; } }
      else { $("queryResult").textContent = t("이 지역은 아직 온체인 데이터가 없습니다 (릴레이어 대기).", "No on-chain data for this region yet (awaiting relayer)."); return; }
    }
    const data = ctx(code).unscale(await roOracle.peekLatest(code));
    $("queryResult").innerHTML = renderWeather(code, data, t("(무료 미리보기 — 결제·미터링 없음)", "(free preview — no payment / metering)")).replace(/\n/g, "<br>");
  });
}

async function runAgent() {
  await withBusy($("agentBtn"), t("에이전트 실행 중…", "Running agent…"), async () => {
    $("agentResult").textContent = t("에이전트 봇이 구독·결제 후 온체인 쿼리를 실행 중…", "Agent bot subscribing, paying and running an on-chain query…");
    const j = await (await fetch("/api/agent")).json();
    if (j.error) { $("agentResult").textContent = t("에러: ", "Error: ") + j.error; return; }
    const dd = j.decisionDetail || {};
    let html = t(`에이전트 ${short(j.agent)} (${j.region})\n상품: ${dd.name || j.product} · 표본 ${j.samples}h\n→ 신호 ${dd.signal || "-"} (${Math.round((dd.score || 0) * 100)}%) · ${j.decision}\n${dd.rationale || ""}\n남은 구독 한도: ${j.quotaRemaining}`,
      `Agent ${short(j.agent)} (${j.region})\nProduct: ${dd.name || j.product} · samples ${j.samples}h\n→ Signal ${dd.signal || "-"} (${Math.round((dd.score || 0) * 100)}%) · ${j.decision}\n${dd.rationale || ""}\nQueries left: ${j.quotaRemaining}`);
    html = html.replace(/\n/g, "<br>");
    if (j.paidThisRun) html += `<br><span class="ok">${t("결제: 구독 1개월", "Paid: 1-month subscription")}</span> · <a class="ext" href="${txLink(j.paidThisRun.txHash)}" target="_blank">tx ↗</a>`;
    if (j.queryTxHash) html += `<br><span class="ok">${t("온체인 쿼리", "On-chain query")}</span> · <a class="ext" href="${txLink(j.queryTxHash)}" target="_blank">tx ↗</a>`;
    $("agentResult").innerHTML = html; refreshStatus();
  });
}

async function relayNow() {
  await withBusy($("relayBtn"), t("릴레이 중…", "Relaying…"), async () => {
    $("agentResult").textContent = t("릴레이어가 실제 날씨를 온체인에 발행 중…", "Relayer publishing real weather on-chain…");
    const j = await (await fetch("/api/relay")).json();
    if (j.error) { $("agentResult").textContent = t("릴레이 에러: ", "Relay error: ") + j.error; return; }
    $("agentResult").innerHTML = `${t(`${j.regions}개 지역 온체인 발행 완료`, `Published ${j.regions} regions on-chain`)} · <a class="ext" href="${txLink(j.txHash)}" target="_blank">tx ↗</a> (block ${j.block})`;
    refreshStatus();
  });
}

function selectCityOption(c) {
  const sel = $("regionSel");
  const label = isDong(c.id) ? `${c.name} (${t("KR 동", "KR 동")})` : `${c.name}, ${c.cc}`;
  if (!Array.from(sel.options).some((o) => Number(o.value) === c.id)) sel.add(new Option(label, String(c.id)));
  sel.value = String(c.id);
  if (account) refreshWallet();
}
function wireDappSearch() {
  const box = $("citySearch2"), list = $("searchResults2");
  if (!box) return;
  const render = (q) => {
    q = q.trim().toLowerCase();
    if (!q) { list.style.display = "none"; return; }
    const hits = [];
    for (const c of CITIES) {
      if (c.name.toLowerCase().startsWith(q) || `${c.name}, ${c.cc}`.toLowerCase().includes(q)) { hits.push(c); if (hits.length >= 12) break; }
    }
    list.innerHTML = hits.map((c) => `<div class="sres" data-id="${c.id}">${c.name} <span class="cc">${isDong(c.id) ? t("KR 동", "KR 동") : c.cc}</span></div>`).join("");
    list.style.display = hits.length ? "block" : "none";
    list.querySelectorAll(".sres").forEach((el) => el.addEventListener("click", () => { selectCityOption(CITY_BY_ID.get(Number(el.dataset.id))); box.value = ""; list.style.display = "none"; }));
  };
  box.addEventListener("input", () => render(box.value));
  box.addEventListener("blur", () => setTimeout(() => (list.style.display = "none"), 200));
}

async function loadDecisionProducts() {
  try { const j = await (await fetch("/api/decision")).json(); const sel = $("decProduct"); if (sel) (j.products || []).forEach((p) => sel.add(new Option(`${p.emoji} ${p.name}`, p.id))); } catch { /* non-fatal */ }
}
let decSelectedCode = null; // exact region code chosen from autocomplete (world id or 10-digit 동코드)
function wireDecisionSearch() {
  const box = $("decCity"), list = $("decResults");
  if (!box || !list) return;
  const render = (q) => {
    q = q.trim().toLowerCase();
    if (!q) { list.style.display = "none"; return; }
    const hits = [];
    for (const c of CITIES) {
      if (c.name.toLowerCase().includes(q) || `${c.name}, ${c.cc}`.toLowerCase().includes(q)) { hits.push(c); if (hits.length >= 8) break; }
    }
    list.innerHTML = hits.map((c) => `<div class="sres" data-id="${c.id}">${c.name} <span class="cc">${isDong(c.id) ? t("KR 동", "KR 동") : c.cc}</span></div>`).join("");
    list.style.display = hits.length ? "block" : "none";
    if (hits.length) { // open upward when there isn't room below (panel sits near page bottom)
      const rect = box.getBoundingClientRect();
      const up = window.innerHeight - rect.bottom < list.scrollHeight + 24;
      list.style.top = up ? "auto" : (box.offsetHeight + 4) + "px";
      list.style.bottom = up ? (box.offsetHeight + 4) + "px" : "auto";
    }
    list.querySelectorAll(".sres").forEach((el) => el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const c = CITY_BY_ID.get(Number(el.dataset.id));
      box.value = isDong(c.id) ? c.name : `${c.name}, ${c.cc}`;
      decSelectedCode = String(c.id);
      list.style.display = "none";
    }));
  };
  box.addEventListener("input", () => { decSelectedCode = null; render(box.value); }); // typing clears the exact pick
  box.addEventListener("focus", () => box.value && render(box.value));
  box.addEventListener("blur", () => setTimeout(() => (list.style.display = "none"), 150));
}
async function runDecision() {
  const city = (decSelectedCode || $("decCity").value || "Jakarta").toString().trim();
  const product = $("decProduct").value;
  await withBusy($("decBtn"), t("결정 중…", "Deciding…"), async () => {
    const u = `/api/decision?city=${encodeURIComponent(city)}` + (product ? `&product=${encodeURIComponent(product)}` : "");
    const j = await (await fetch(u)).json();
    if (j.error) { $("decResult").textContent = t("에러: ", "Error: ") + j.error; return; }
    const src = j.onchain ? t(`온체인 #${j.regionCode}`, `on-chain #${j.regionCode}`) : t(`${j.source} (폴백)`, `${j.source} (fallback)`);
    const o = j.observation || {};
    const air = o.pm25 != null ? ` · PM2.5 ${o.pm25}` : "";
    const head = t(`${j.city} · ${src} · ${j.samples}개 표본\n기온 ${o.temperature}℃ · 습도 ${o.humidity}%${air}\n`, `${j.city} · ${src} · ${j.samples} samples\nTemp ${o.temperature}℃ · Humidity ${o.humidity}%${air}\n`);
    const body = (j.decisions || []).map((d) => `${d.emoji} ${d.name} [${d.sector}]\n   → ${d.signal} (${Math.round(d.score * 100)}%) · ${d.action}\n   ${d.rationale}`).join("\n\n");
    $("decResult").innerHTML = (head + "\n" + body).replace(/\n/g, "<br>");
  });
}

function main() {
  $("regionSel").innerHTML = FEATURED.map((c) => `<option value="${c.id}">${c.name}, ${c.cc}</option>`).join("");
  wireDappSearch();
  wireDecisionSearch();
  loadDecisionProducts();
  $("decBtn")?.addEventListener("click", runDecision);
  if (!CFG) { notDeployed(); return; }
  const applyChrome = () => {
    $("netBadge").textContent = `${CFG.chainName} · ${t("실제 온체인", "live on-chain")}`;
    $("walletHint").textContent = t(`${CFG.chainName} 지갑(MetaMask 등)을 연결하세요. 가스비는 테스트넷 ${CFG.currency || "tBNB"}입니다.`, `Connect a ${CFG.chainName} wallet (e.g. MetaMask). Gas is testnet ${CFG.currency || "tBNB"}.`);
  };
  applyChrome();
  if ($("footChain")) $("footChain").textContent = CFG.chainName;
  if ($("footCurrency")) $("footCurrency").textContent = CFG.currency || "tBNB";
  if (window.KW) window.KW.onLang(() => { applyChrome(); refreshStatus(); if (account) refreshWallet(); });
  initReadOnly();
  $("connectBtn").addEventListener("click", connect);
  $("faucetBtn").addEventListener("click", faucet);
  $("subBtn").addEventListener("click", subscribe);
  $("prepayBtn").addEventListener("click", prepay);
  $("queryBtn").addEventListener("click", query);
  $("peekBtn").addEventListener("click", peek);
  $("regionSel").addEventListener("change", () => { if (account) refreshWallet(); });
  $("agentBtn").addEventListener("click", runAgent);
  $("relayBtn").addEventListener("click", relayNow);
  refreshStatus();
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
}
document.addEventListener("DOMContentLoaded", main);
