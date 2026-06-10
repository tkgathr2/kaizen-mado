/* ── カイゼンくん 埋め込みウィジェット ──
 * 各システムに1行入れるだけで、右下にフローティングボタンが常駐する：
 *   <script src="https://kaizen.takagi.bz/widget.js" data-sys="prorepo" defer></script>
 *
 * - data-sys     : 対象システムのslug（prorepo/sterepo/houko/... lib/systems.ts と同じ）。省略可（会話で特定）。
 * - data-origin  : 窓口のオリジンを上書きしたいとき用（通常不要。script.src から自動判定）。
 *
 * 設計メモ：
 * - ホスト側CSSと衝突しないよう Shadow DOM 内で完結（非対応ブラウザは通常DOM+インラインstyleで退行）。
 * - iframe は初回オープン時に遅延生成（埋め込み先の初期ロードを汚さない）。
 * - パネル上部のバーはウィジェット側（親ページ）にあるので、認証リダイレクト等で iframe 内が
 *   表示できない環境でも「新しいタブで開く」から必ず窓口に到達できる。
 * - iframe からの postMessage {type:"kaizen:close"} で閉じる（オリジン検査あり）。
 */
(function () {
  "use strict";
  if (window.__kaizenWidgetLoaded) return;
  window.__kaizenWidgetLoaded = true;

  var script =
    document.currentScript ||
    (function () {
      var list = document.querySelectorAll('script[src*="widget.js"]');
      return list.length ? list[list.length - 1] : null;
    })();

  var DEFAULT_ORIGIN = "https://kaizen.takagi.bz";
  var origin = DEFAULT_ORIGIN;
  try {
    var override = script && script.getAttribute("data-origin");
    origin = override || (script && script.src ? new URL(script.src).origin : DEFAULT_ORIGIN);
  } catch (e) {
    origin = DEFAULT_ORIGIN;
  }

  var sys = (script && script.getAttribute("data-sys")) || "";
  var madoUrl = origin + "/?embed=1" + (sys ? "&sys=" + encodeURIComponent(sys) : "");
  var tabUrl = origin + "/" + (sys ? "?sys=" + encodeURIComponent(sys) : "");

  var BRAND = "#d97757";
  var Z = 2147483000; // ホストサイトのどの要素より前面（最大値近辺だが拡張等と譲り合う）

  var css =
    ":host{all:initial}" +
    ".kz-btn{position:fixed;right:20px;bottom:20px;z-index:" + Z + ";width:56px;height:56px;border-radius:50%;border:1px solid rgba(0,0,0,.08);cursor:pointer;background:#fff;padding:0;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(60,50,35,.3);transition:transform .12s ease,box-shadow .15s ease;-webkit-tap-highlight-color:transparent}" +
    ".kz-btn:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(60,50,35,.38)}" +
    ".kz-btn:active{transform:scale(.95)}" +
    ".kz-btn img{width:52px;height:52px;border-radius:50%;pointer-events:none}" +
    ".kz-tip{position:fixed;right:84px;bottom:34px;z-index:" + Z + ";background:#2b2924;color:#fff;font:12.5px/1 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;padding:7px 11px;border-radius:8px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s ease}" +
    ".kz-btn:hover+.kz-tip{opacity:.92}" +
    ".kz-panel{position:fixed;right:20px;bottom:88px;z-index:" + Z + ";width:400px;max-width:calc(100vw - 32px);height:min(620px,calc(100vh - 120px));height:min(620px,calc(100dvh - 120px));background:#faf9f5;border-radius:16px;box-shadow:0 12px 48px rgba(60,50,35,.28);display:none;flex-direction:column;overflow:hidden}" +
    ".kz-panel.open{display:flex}" +
    ".kz-bar{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;background:" + BRAND + ";color:#fff;font:600 14px/1.3 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif}" +
    ".kz-bar .kz-title{flex:1;display:flex;align-items:center;gap:7px}" +
    ".kz-bar .kz-title img{width:22px;height:22px;border-radius:50%;background:#fff;flex:none}" +
    ".kz-bar a,.kz-bar button.kz-x{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:7px;background:rgba(255,255,255,.16);color:#fff;cursor:pointer;text-decoration:none;transition:background .15s ease}" +
    ".kz-bar a:hover,.kz-bar button.kz-x:hover{background:rgba(255,255,255,.32)}" +
    ".kz-bar svg{width:15px;height:15px}" +
    ".kz-frame{flex:1;width:100%;border:none;background:#faf9f5}" +
    "@media (max-width:480px){.kz-panel{right:8px;left:8px;bottom:84px;width:auto;height:min(560px,calc(100dvh - 100px))}.kz-btn{right:16px;bottom:16px}}";

  // カイゼンくん＝フクロウ博士（社長決定 2026-06-10・ナノバナナ生成のマスコットPNG）。
  // 画像は窓口と同じオリジンから配信（middlewareで認証除外済み）。
  var ICON = origin + "/kaizen-kun.png";
  var EXTERNAL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
  var CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  function build() {
    var host = document.createElement("div");
    host.id = "kaizen-widget-host";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);

    var btn = document.createElement("button");
    btn.className = "kz-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "カイゼンくんに相談する");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<img src="' + ICON + '" alt="">';
    root.appendChild(btn);

    var tip = document.createElement("div");
    tip.className = "kz-tip";
    tip.textContent = "困ったらカイゼンくん";
    root.appendChild(tip);

    var panel = document.createElement("div");
    panel.className = "kz-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "カイゼン窓口");
    panel.innerHTML =
      '<div class="kz-bar">' +
      '<span class="kz-title"><img src="' + ICON + '" alt="">カイゼンくん</span>' +
      '<a href="' + tabUrl + '" target="_blank" rel="noopener noreferrer" title="新しいタブで開く" aria-label="新しいタブで開く">' + EXTERNAL + "</a>" +
      '<button class="kz-x" type="button" title="閉じる" aria-label="閉じる">' + CLOSE + "</button>" +
      "</div>";
    root.appendChild(panel);

    var frame = null;
    // 埋め込み元がログイン済みユーザー名を window.kaizenUser に入れておくと、
    // 窓口へ reporter として引き継がれ「お名前」欄の入力が不要になる（パネル初回オープン時に評価）。
    function reporterParam() {
      var u = window.kaizenUser;
      return typeof u === "string" && u.trim() ? "&reporter=" + encodeURIComponent(u.trim()) : "";
    }
    function ensureFrame() {
      if (frame) return;
      frame = document.createElement("iframe");
      frame.className = "kz-frame";
      frame.src = madoUrl + reporterParam();
      frame.title = "カイゼン窓口チャット";
      frame.setAttribute("allow", "clipboard-write");
      panel.appendChild(frame);
    }

    function setOpen(open) {
      if (open) ensureFrame();
      panel.className = open ? "kz-panel open" : "kz-panel";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    function isOpen() {
      return panel.className.indexOf("open") >= 0;
    }

    btn.addEventListener("click", function () {
      setOpen(!isOpen());
    });
    panel.querySelector(".kz-x").addEventListener("click", function () {
      setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) setOpen(false);
    });
    window.addEventListener("message", function (e) {
      if (e.origin !== origin) return; // 窓口オリジン以外からの close は無視
      if (e.data && e.data.type === "kaizen:close") setOpen(false);
    });

    document.body.appendChild(host);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
