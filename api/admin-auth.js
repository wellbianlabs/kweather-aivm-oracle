// Admin ID login (server-verified, so the password never lives in client JS).
// Send `Authorization: Basic base64(user:pass)`; returns { ok } if it matches
// env ADMIN_USER / ADMIN_PASS. Wallet-based admin (owner address) is checked client-side
// separately. Env: ADMIN_USER, ADMIN_PASS.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { ADMIN_USER, ADMIN_PASS } = process.env;
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(503).json({ ok: false, error: "ID 로그인 미설정 — 서버에 ADMIN_USER/ADMIN_PASS 환경변수를 설정하세요. (지갑 연결은 사용 가능)" });
  }
  const h = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = /^Basic (.+)$/.exec(h);
  if (!m) return res.status(401).json({ ok: false, error: "no credentials" });
  let user = "", pass = "";
  try {
    const dec = Buffer.from(m[1], "base64").toString("utf8");
    const i = dec.indexOf(":");
    user = dec.slice(0, i);
    pass = dec.slice(i + 1);
  } catch (_) {}
  if (user === ADMIN_USER && pass === ADMIN_PASS) return res.status(200).json({ ok: true });
  return res.status(401).json({ ok: false, error: "아이디 또는 비밀번호가 올바르지 않습니다." });
};
