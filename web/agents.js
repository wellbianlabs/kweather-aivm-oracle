/* AI-agent activity dashboard — renders /api/agents (public WeatherQueried events, 24h). Auto-refreshes. */
"use strict";
const CFG = window.DAPP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const aLink = (a) => `${CFG.explorer || "https://testnet.bscscan.com"}/address/${a}`;
const txLink = (h) => `${CFG.explorer || "https://testnet.bscscan.com"}/tx/${h}`;
const ago = (u) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - u)); if (s < 90) return `${s}s 전`; if (s < 5400) return `${Math.round(s / 60)}m 전`; return `${Math.round(s / 3600)}h 전`; };

async function load() {
  try {
    const j = await (await fetch("/api/agents")).json();
    if (j.error) { $("meta").innerHTML = `<span class="bad">조회 실패: ${j.error}</span>`; return; }

    $("sAgents").textContent = (j.uniqueAgents || 0).toLocaleString();
    $("sQueries").textContent = (j.totalQueries || 0).toLocaleString();
    const m = j.modes || {};
    $("sModes").innerHTML = `<span class="ok">${m.subscription || 0}</span> <span class="sub" style="font-size:18px">/</span> <span class="warn">${m.prepaid || 0}</span>`;

    // 24h hourly bars (index 0 = most recent hour → show oldest→newest left→right)
    const h = (j.hourly || []).slice().reverse();
    const max = Math.max(1, ...h);
    $("bars").innerHTML = h.map((v) => `<span style="height:${Math.round((v / max) * 100)}%" title="${v}"></span>`).join("");
    $("barsNote").textContent = `왼쪽=24시간 전 → 오른쪽=현재 · 시간당 구매 건수 (최대 ${max})`;

    $("topAgents").innerHTML = (j.topAgents || []).length
      ? j.topAgents.map((a, i) => `<div class="kv"><span class="k">#${i + 1} <a class="ext" href="${aLink(a.agent)}" target="_blank">${short(a.agent)} ↗</a></span><span class="v">${a.count.toLocaleString()} 건</span></div>`).join("")
      : `<div class="hint">아직 24시간 내 활동이 없습니다. 에이전트가 구매하면 즉시 표시됩니다.</div>`;

    $("topRegions").innerHTML = (j.topRegions || []).length
      ? j.topRegions.map((r) => `<div class="kv"><span class="k">${r.name} <span class="addr">${r.market === "korea" ? "KR" : "W"}</span></span><span class="v">${r.count.toLocaleString()} 건</span></div>`).join("")
      : `<div class="hint">—</div>`;

    $("feed").innerHTML = (j.recent || []).length
      ? j.recent.map((e) => `<div class="row"><span><a class="ext" href="${aLink(e.agent)}" target="_blank">${short(e.agent)}</a> → ${e.name} <span class="pill ${e.mode === "subscription" ? "sub" : "pre"}">${e.mode === "subscription" ? "구독" : e.mode === "prepaid" ? "종량제" : e.mode}</span></span><span class="addr"><a class="ext" href="${txLink(e.tx)}" target="_blank">${ago(e.at)} ↗</a></span></div>`).join("")
      : `<div class="hint">아직 거래가 없습니다 — 에이전트 봇/마켓에서 구매가 일어나면 실시간으로 채워집니다.</div>`;

    const src = j.source === "explorer" ? "블록탐색기(공개 컨트랙트 이벤트)" : j.source === "rpc" ? "RPC 이벤트 로그" : "데이터 소스 미설정";
    $("meta").innerHTML = (j.note ? `<span class="warn">⚠ ${j.note}</span><br>` : "") +
      `소스: ${src} · 갱신 ${new Date(j.generatedAt).toLocaleString(navigator.language || "en")} · 30초마다 자동 새로고침 · ` +
      `<a class="ext" href="${aLink(CFG.oracle)}" target="_blank">세계 오라클 ↗</a> · <a class="ext" href="${aLink(CFG.koreaOracle)}" target="_blank">국내 오라클 ↗</a>`;
  } catch (e) { $("meta").innerHTML = `<span class="bad">${String(e.message || e)}</span>`; }
}

document.addEventListener("DOMContentLoaded", () => {
  $("refreshBtn").addEventListener("click", load);
  load();
  setInterval(load, 30000);
});
