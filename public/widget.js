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
 *
 * 【発見性（初見の非エンジニアでも一目で分かる）】
 * - 休止状態は「フクロウ＋ラベル文言」の角丸pill。読めば"ご意見・改善を送るボタン"だと分かる。
 *   狭い画面(<480px)では短いラベル（「ご意見」）へ自動で縮め、画面からはみ出さない。
 * - ページ表示の約1.2秒後に、ホバー非依存で初回コールアウト（フキダシ）を自動表示。
 *   ×で閉じられ、8秒で自動的に引っ込み、localStorageで一度きり（再訪では出さない）。
 * - 初回の数秒だけボタンにやわらかいパルスリングを出して気づかせる。最初の操作で止まる。
 *   prefers-reduced-motion を尊重し、動きを嫌う環境ではパルスを出さない。
 *
 * 【重要・オリジンの実態】このウィジェットは窓口本体（kaizen.takagi.bz/?embed=1）を iframe で開くだけ。
 *   実際の起票POST（/api/submit）は、その iframe＝窓口本体（kaizen.takagi.bz）から飛ぶ。
 *   つまり起票リクエストの Origin は「埋め込み先のホスト」ではなく "常に窓口自身"＝kaizen.takagi.bz。
 *   サーバ側の KAIZEN_ALLOWED_ORIGINS（CSRF対策）を設定する場合、許可すべき値は窓口自身
 *   （例 https://kaizen.takagi.bz）であって、各埋め込み先ホストのオリジンではない。
 *   ここを取り違えて埋め込み先ホストを設定すると、実Origin（kaizen.takagi.bz）が許可されず
 *   全窓口が 403 になる。未設定なら全許可（後方互換）。
 */
(function () {
  "use strict";
  // 複数枚設置への堅牢化：このガードで「最初に評価された1枚」だけが採用される。
  // 2枚目以降のscriptは即returnするため、フローティングボタンが重複して出ることはない。
  if (window.__kaizenWidgetLoaded) return;
  window.__kaizenWidgetLoaded = true;

  // data-sys等の属性は「この widget.js を読み込んだ自分のscriptタグ」から取る。
  // document.currentScript が使える環境ではそれを最優先（複数枚あっても自分を正しく特定）。
  // 取れない古い環境では widget.js を指すscriptの先頭1枚にフォールバックする。
  var script =
    document.currentScript ||
    (function () {
      var list = document.querySelectorAll('script[src*="widget.js"]');
      return list.length ? list[0] : null;
    })();

  var DEFAULT_ORIGIN = "https://kaizen.takagi.bz";
  var origin = DEFAULT_ORIGIN;
  try {
    var override = script && script.getAttribute("data-origin");
    origin = override || (script && script.src ? new URL(script.src).origin : DEFAULT_ORIGIN);
  } catch (e) {
    origin = DEFAULT_ORIGIN;
  }

  // data-sys 取得失敗時の安全なフォールバック：
  // 対象システムが特定できなくても窓口は開ける（会話の中でどのシステムか聞く）。
  // 取れなかったことだけ警告ログに残し、設置ミスに気づけるようにする。
  var sys = (script && script.getAttribute("data-sys")) || "";
  if (!sys && window.console && typeof console.warn === "function") {
    console.warn(
      "[kaizen-widget] data-sys が取得できませんでした。対象システム未指定で窓口を開きます（会話内で確認します）。"
    );
  }
  var madoUrl = origin + "/?embed=1" + (sys ? "&sys=" + encodeURIComponent(sys) : "");
  var tabUrl = origin + "/" + (sys ? "?sys=" + encodeURIComponent(sys) : "");

  var BRAND = "#d97757";
  var Z = 2147483000; // ホストサイトのどの要素より前面（最大値近辺だが拡張等と譲り合う）

  // 初回コールアウト（フキダシ）の一度きり判定キー。
  // ホスト側 localStorage に衝突しないよう、製品固有の長い名前を使う。
  var CALLOUT_KEY = "kaizen-widget:first-visit-callout:v1";

  // 休止状態ボタンの文言。読めば"何ができるボタンか"が一読で分かること（社長の好み＝素人語・優しい）。
  var BTN_LABEL = "ご意見・改善はこちら"; // 通常画面
  var BTN_LABEL_SHORT = "ご意見"; // 狭い画面(<480px)で省略
  var CALLOUT_TEXT =
    "👋 この画面の『使いにくい』『こうしてほしい』を、ここから気軽に送れます";

  var css =
    ":host{all:initial}" +
    // pillボタン：フクロウ＋ラベルの角丸。読めば用途が分かる。
    ".kz-btn{position:fixed;right:20px;bottom:20px;z-index:" + Z + ";height:52px;max-width:calc(100vw - 40px);border-radius:26px;border:1px solid rgba(0,0,0,.08);cursor:pointer;background:#fff;padding:0 16px 0 6px;display:flex;align-items:center;gap:9px;box-shadow:0 4px 16px rgba(60,50,35,.3);transition:transform .12s ease,box-shadow .15s ease;-webkit-tap-highlight-color:transparent}" +
    ".kz-btn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(60,50,35,.38)}" +
    ".kz-btn:active{transform:scale(.97)}" +
    ".kz-btn:focus-visible{outline:3px solid rgba(217,119,87,.55);outline-offset:2px}" +
    ".kz-btn img{width:40px;height:40px;border-radius:50%;flex:none;pointer-events:none}" +
    ".kz-btn .kz-label{font:600 14px/1 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;color:#2b2924;white-space:nowrap;pointer-events:none;letter-spacing:.01em}" +
    ".kz-btn .kz-label-short{display:none}" +
    // やわらかいパルスリング（初回の数秒だけ・最初の操作で停止）。
    ".kz-btn::before{content:'';position:absolute;inset:-1px;border-radius:26px;border:2px solid " + BRAND + ";opacity:0;pointer-events:none}" +
    ".kz-btn.kz-pulse::before{animation:kz-pulse 1.8s ease-out 3}" +
    "@keyframes kz-pulse{0%{opacity:.55;transform:scale(1)}70%{opacity:0;transform:scale(1.18)}100%{opacity:0;transform:scale(1.18)}}" +
    // ホバー時の補助フキダシ（既存どおり。PCで指す位置の説明）。
    ".kz-tip{position:fixed;right:20px;bottom:80px;z-index:" + Z + ";background:#2b2924;color:#fff;font:12.5px/1 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;padding:7px 11px;border-radius:8px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s ease}" +
    ".kz-btn:hover+.kz-tip,.kz-btn:focus-visible+.kz-tip{opacity:.92}" +
    // 初回コールアウト（自動表示・ホバー非依存・×で閉じる）。
    ".kz-callout{position:fixed;right:20px;bottom:82px;z-index:" + Z + ";max-width:min(280px,calc(100vw - 40px));background:#2b2924;color:#fff;font:13px/1.55 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;padding:12px 34px 12px 13px;border-radius:12px;box-shadow:0 8px 28px rgba(60,50,35,.34);opacity:0;transform:translateY(6px);transition:opacity .25s ease,transform .25s ease;pointer-events:none}" +
    ".kz-callout.show{opacity:1;transform:translateY(0);pointer-events:auto}" +
    ".kz-callout::after{content:'';position:absolute;right:34px;bottom:-7px;width:14px;height:14px;background:#2b2924;transform:rotate(45deg)}" +
    ".kz-callout .kz-callout-x{position:absolute;top:6px;right:6px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;padding:0}" +
    ".kz-callout .kz-callout-x:hover{background:rgba(255,255,255,.3)}" +
    ".kz-callout .kz-callout-x svg{width:12px;height:12px}" +
    ".kz-panel{position:fixed;right:20px;bottom:88px;z-index:" + Z + ";width:400px;max-width:calc(100vw - 32px);height:min(620px,calc(100vh - 120px));height:min(620px,calc(100dvh - 120px));background:#faf9f5;border-radius:16px;box-shadow:0 12px 48px rgba(60,50,35,.28);display:none;flex-direction:column;overflow:hidden}" +
    ".kz-panel.open{display:flex}" +
    ".kz-bar{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;background:" + BRAND + ";color:#fff;font:600 14px/1.3 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif}" +
    ".kz-bar .kz-title{flex:1;display:flex;align-items:center;gap:7px}" +
    ".kz-bar .kz-title img{width:22px;height:22px;border-radius:50%;background:#fff;flex:none}" +
    ".kz-bar a,.kz-bar button.kz-x{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:7px;background:rgba(255,255,255,.16);color:#fff;cursor:pointer;text-decoration:none;transition:background .15s ease}" +
    ".kz-bar a:hover,.kz-bar button.kz-x:hover{background:rgba(255,255,255,.32)}" +
    ".kz-bar svg{width:15px;height:15px}" +
    ".kz-frame{flex:1;width:100%;border:none;background:#faf9f5}" +
    // 狭い画面：pillは短いラベルに縮め、はみ出さない。
    "@media (max-width:480px){.kz-btn{right:16px;bottom:16px;padding:0 14px 0 6px}.kz-btn .kz-label-full{display:none}.kz-btn .kz-label-short{display:inline}.kz-tip{display:none}.kz-callout{right:16px;left:16px;max-width:none}.kz-callout::after{right:30px}.kz-panel{right:8px;left:8px;bottom:84px;width:auto;height:min(560px,calc(100dvh - 100px))}}" +
    // 動きを嫌う環境ではパルスを無効化（アクセシビリティ）。
    "@media (prefers-reduced-motion:reduce){.kz-btn.kz-pulse::before{animation:none}.kz-callout{transition:opacity .01s linear}}";

  // カイゼンくん＝フクロウ博士（社長決定 2026-06-10・ナノバナナ生成のマスコットPNG）。
  // 画像は窓口と同じオリジンから配信（middlewareで認証除外済み）。
  var ICON = origin + "/kaizen-kun.png";
  var EXTERNAL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
  var CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  // 初回コールアウトを「もう出した」と記録する（localStorage一度きり）。
  // プライベートモード等で localStorage が使えない場合も例外で落とさない。
  function markCalloutSeen() {
    try {
      window.localStorage.setItem(CALLOUT_KEY, "1");
    } catch (e) {
      /* localStorage不可環境では何もしない（その回は出るが致命的でない） */
    }
  }
  // 初回コールアウトを「まだ出していないので出してよい」か判定する純粋寄り関数。
  function shouldShowCallout() {
    try {
      return window.localStorage.getItem(CALLOUT_KEY) !== "1";
    } catch (e) {
      return true; // 取得不可なら一応出す（出ない事故より、説明が出る方を選ぶ）
    }
  }

  function build() {
    var host = document.createElement("div");
    host.id = "kaizen-widget-host";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);

    // ラベル付きpillボタン：フクロウ（左）＋「ご意見・改善はこちら」。
    // aria-label は変えずキーボード操作・スクリーンリーダー互換を維持。
    var btn = document.createElement("button");
    btn.className = "kz-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "ご意見・改善を送る（カイゼンくんに相談する）");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      '<img src="' + ICON + '" alt="">' +
      '<span class="kz-label">' +
      '<span class="kz-label-full">' + BTN_LABEL + "</span>" +
      '<span class="kz-label-short">' + BTN_LABEL_SHORT + "</span>" +
      "</span>";
    root.appendChild(btn);

    var tip = document.createElement("div");
    tip.className = "kz-tip";
    tip.textContent = "困ったらカイゼンくん";
    root.appendChild(tip);

    // 初回コールアウト（自動・ホバー非依存・×閉じ・8秒で自動収納・一度きり）。
    var callout = document.createElement("div");
    callout.className = "kz-callout";
    callout.setAttribute("role", "status");
    callout.innerHTML =
      '<span class="kz-callout-text"></span>' +
      '<button class="kz-callout-x" type="button" aria-label="この案内を閉じる">' + CLOSE + "</button>";
    callout.querySelector(".kz-callout-text").textContent = CALLOUT_TEXT;
    root.appendChild(callout);

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
    var calloutTimer = null;
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

    // 初回コールアウトを閉じる（自動収納・×・パネルオープン共通の経路）。
    function hideCallout() {
      if (calloutTimer) {
        clearTimeout(calloutTimer);
        calloutTimer = null;
      }
      callout.className = "kz-callout";
    }

    // 最初の操作（クリック/フォーカス）でパルスを止める。気づかせる役目は果たし終えたら静かにする。
    function stopPulse() {
      btn.className = "kz-btn";
    }

    function setOpen(open) {
      if (open) {
        ensureFrame();
        hideCallout(); // パネルを開いたら案内は即消す（用が済んだ）
        markCalloutSeen(); // 一度開いた人には次回もコールアウトを出さない
        stopPulse();
      }
      panel.className = open ? "kz-panel open" : "kz-panel";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    function isOpen() {
      return panel.className.indexOf("open") >= 0;
    }

    btn.addEventListener("click", function () {
      setOpen(!isOpen());
    });
    // クリック前のフォーカス（Tab移動・指のタップ前）でもパルスは役目を終える。
    btn.addEventListener("focus", stopPulse);
    callout.querySelector(".kz-callout-x").addEventListener("click", function (e) {
      e.stopPropagation();
      hideCallout();
      markCalloutSeen(); // ×で閉じたら次回は出さない（一度きり）
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

    // ── 気づかせる演出（初回のみ・reduced-motion尊重・一度きり）──
    var reduceMotion = false;
    try {
      reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      reduceMotion = false;
    }

    // パルスリング：初回の数秒だけ。動きを嫌う環境では出さない。
    if (!reduceMotion) {
      btn.className = "kz-btn kz-pulse";
    }

    // 初回コールアウト：表示の約1.2秒後に自動表示。8秒で自動収納。localStorageで一度きり。
    if (shouldShowCallout()) {
      setTimeout(function () {
        if (isOpen()) return; // すでに開いていれば不要
        callout.className = "kz-callout show";
        markCalloutSeen(); // 出した時点で「見た」扱い（次回は出さない）
        calloutTimer = setTimeout(hideCallout, 8000); // 8秒で自動的に引っ込む
      }, 1200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
