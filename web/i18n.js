/* Minimal KO/EN i18n. Korean is the default (authored in markup); data-en holds English.
   - [data-en]        : swaps textContent
   - [data-en-html]   : swaps innerHTML (for text with inline markup)
   - [data-en-ph]     : swaps the placeholder attribute
   A single #langBtn toggles; the choice is persisted to localStorage. */
(function () {
  const KEY = "kw_lang";
  // shared helper for JS-rendered (dynamic) strings: KW.t(ko, en); KW.onLang(fn) re-renders on toggle.
  window.KW = window.KW || { lang: "ko", _cbs: [] };
  window.KW.t = (ko, en) => (window.KW.lang === "en" ? en : ko);
  window.KW.onLang = (fn) => { window.KW._cbs.push(fn); };
  function apply(lang) {
    document.documentElement.lang = lang;
    window.KW.lang = lang;
    document.querySelectorAll("[data-en]").forEach((el) => {
      if (el.dataset.ko === undefined) el.dataset.ko = el.textContent;
      el.textContent = lang === "en" ? el.dataset.en : el.dataset.ko;
    });
    document.querySelectorAll("[data-en-html]").forEach((el) => {
      if (el.dataset.koHtml === undefined) el.dataset.koHtml = el.innerHTML;
      el.innerHTML = lang === "en" ? el.dataset.enHtml : el.dataset.koHtml;
    });
    document.querySelectorAll("[data-en-ph]").forEach((el) => {
      if (el.dataset.koPh === undefined) el.dataset.koPh = el.getAttribute("placeholder") || "";
      el.setAttribute("placeholder", lang === "en" ? el.dataset.enPh : el.dataset.koPh);
    });
    const btn = document.getElementById("langBtn");
    if (btn) btn.textContent = lang === "en" ? "한국어" : "EN";
    try { localStorage.setItem(KEY, lang); } catch (e) { /* ignore */ }
    (window.KW._cbs || []).forEach((fn) => { try { fn(lang); } catch (e) { /* ignore */ } });
  }
  function init() {
    let lang = "ko";
    try { lang = localStorage.getItem(KEY) || "ko"; } catch (e) { /* ignore */ }
    apply(lang);
    const btn = document.getElementById("langBtn");
    if (btn) btn.addEventListener("click", () => apply(document.documentElement.lang === "en" ? "ko" : "en"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.kwSetLang = apply;
})();
