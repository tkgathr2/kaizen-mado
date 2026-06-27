/* ── カイゼンくん 埋め込みウィジェット v2 ──
 * 各システムに1行入れるだけで、右下にフローティングボタンが常駐する：
 *   <script src="https://kaizen.takagi.bz/widget.js" data-sys="prorepo" defer></script>
 *
 * - data-sys     : 対象システムのslug（prorepo/sterepo/houko/... lib/systems.ts と同じ）。省略可（会話で特定）。
 * - data-origin  : 窓口のオリジンを上書きしたいとき用（通常不要。script.src から自動判定）。
 *
 * 設計メモ（堅牢性の約束ごと・v1から不変）：
 * - ホスト側CSSと衝突しないよう Shadow DOM 内で完結（非対応ブラウザは通常DOM+インラインstyleで退行）。
 * - iframe は初回オープン時に遅延生成（埋め込み先の初期ロードを汚さない）。
 * - パネル上部のバーはウィジェット側（親ページ）にあるので、認証リダイレクト等で iframe 内が
 *   表示できない環境でも「新しいタブで開く」から必ず窓口に到達できる。
 * - iframe からの postMessage {type:"kaizen:close"} で閉じる（オリジン検査あり）。
 * - 例外が出てもホスト画面を絶対に壊さない（build全体を try/catch で degrade-safe に包む）。
 *
 * 【発見性（初見の非エンジニアでも一目で分かる）】
 * - 休止状態は「フクロウ博士マスコット＋名前＋機能ラベル」の角丸pill。
 *   ・主役＝マスコット（円形・やわらかいリング）。"顔の見える相談相手"として認知が育つ。
 *   ・上段に小さく名前「カイゼンくん」、下段に機能ラベル＝何ができるボタンか一読で分かる。
 *   ・どんな背景（白／濃紺ヘッダ等）でも輪郭が出るよう、白pill＋ヘアライン＋やわらかい多層シャドウ。
 *   狭い画面(<480px)では機能ラベルを短く縮め、画面からはみ出さない。
 * - ページ表示の少しあとに、ホバー非依存で初回コールアウト（フキダシ）を自動表示。
 *   ×で閉じられ、数秒で自動的に引っ込み、localStorageで一度きり（再訪では出さない）。
 *
 * 【モーション設計（上品に・transform/opacityのみでカクつき/レイアウトシフトなし）】
 * - 登場：ロード後にふわっとフェード＋ライズ。
 * - アイドル：ごく控えめな"呼吸"（常時注意を引きすぎない・登場後しばらくしてから始まる）。
 * - ホバー／プレス：丁寧なステート（浮き上がり／沈み込み）。
 * - 初回コールアウト：なめらかなイージング＋ボタンを指す小さな"しっぽ"。
 * - すべて prefers-reduced-motion で減らす（呼吸・登場アニメ・しっぽの動きを止める）。
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

  var BRAND = "#d97757"; // ブランドのテラコッタ。アクセントに"効かせる"（使い過ぎない）。
  var INK = "#2b2924"; // ダークブラウン（文字・濃色面）。
  var CREAM = "#faf9f5"; // 温かいベージュ（パネル地）。
  var Z = 2147483000; // ホストサイトのどの要素より前面（最大値近辺だが拡張等と譲り合う）

  // 初回コールアウト（フキダシ）の一度きり判定キー。
  // ホスト側 localStorage に衝突しないよう、製品固有の長い名前を使う。
  var CALLOUT_KEY = "kaizen-widget:first-visit-callout:v1";

  // 顔の見える相談相手＝名前を小さく添える。機能ラベルは「何ができるか」が最優先。
  var BTN_NAME = "カイゼンくん"; // マスコットの名前（小さく・認知を育てる）
  var BTN_LABEL = "ご意見・改善はこちら"; // 通常画面の機能ラベル
  var BTN_LABEL_SHORT = "ご意見・改善"; // 狭い画面(<480px)で省略（短縮でも機能が伝わる長さ）
  var CALLOUT_TEXT =
    "この画面の「使いにくい」「こうしてほしい」、どんな小さなことでも気軽に送れます";

  var css =
    ":host{all:initial}" +
    // 配置レイヤー：safe-area を尊重した右下アンカー。pill本体は内側で transform 演出する
    // （位置(fixed)とアニメ(transform)を別レイヤーに分け、登場/呼吸でレイアウトシフトを出さない）。
    ".kz-anchor{position:fixed;right:calc(20px + env(safe-area-inset-right,0px));bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:" + Z + ";pointer-events:none}" +
    // pillボタン：白地＋ヘアライン＋多層シャドウ＝どんな背景でも輪郭が立つ。
    // 最小タップ56px（44px以上を確保）。マスコット主役＋名前/機能の2段組。
    ".kz-btn{pointer-events:auto;position:relative;display:flex;align-items:center;gap:11px;min-height:56px;max-width:calc(100vw - 40px);padding:7px 18px 7px 7px;border:0;border-radius:30px;cursor:pointer;background:#fff;box-shadow:0 0 0 1px rgba(43,41,36,.07),0 1px 2px rgba(43,41,36,.10),0 10px 28px rgba(43,41,36,.20);transition:transform .22s cubic-bezier(.2,.8,.25,1),box-shadow .22s cubic-bezier(.2,.8,.25,1);-webkit-tap-highlight-color:transparent;transform:translateZ(0)}" +
    ".kz-btn:hover{transform:translateY(-2px);box-shadow:0 0 0 1px rgba(43,41,36,.08),0 2px 4px rgba(43,41,36,.10),0 16px 38px rgba(43,41,36,.26)}" +
    ".kz-btn:active{transform:translateY(0) scale(.985)}" +
    ".kz-btn:focus-visible{outline:none;box-shadow:0 0 0 1px rgba(43,41,36,.07),0 10px 28px rgba(43,41,36,.20),0 0 0 3px #fff,0 0 0 6px rgba(217,119,87,.85)}" +
    // マスコット：円形マスク＋やわらかいクリーム地のリング（余白を持たせて主役感）。
    ".kz-avatar{position:relative;flex:none;width:44px;height:44px;border-radius:50%;background:" + CREAM + ";box-shadow:inset 0 0 0 1px rgba(43,41,36,.06)}" +
    ".kz-avatar img{position:absolute;inset:3px;width:38px;height:38px;border-radius:50%;object-fit:cover;pointer-events:none;display:block}" +
    // テラコッタの"効かせる"アクセント点（オンライン感＝話しかけられる相手）。1点だけ。
    ".kz-avatar::after{content:'';position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;background:" + BRAND + ";box-shadow:0 0 0 2.5px #fff}" +
    // テキスト2段：名前（小・控えめ）／機能ラベル（主・読ませる）。
    ".kz-text{display:flex;flex-direction:column;align-items:flex-start;gap:1px;pointer-events:none;min-width:0}" +
    ".kz-name{font:600 10.5px/1.2 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;color:" + BRAND + ";letter-spacing:.04em;white-space:nowrap}" +
    ".kz-label{font:700 14px/1.25 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;color:" + INK + ";white-space:nowrap;letter-spacing:.005em}" +
    ".kz-label-short{display:none}" +
    // 登場：フェード＋ライズ。アイドル：登場後しばらくしてから始まる控えめな呼吸。
    // どちらも .kz-avatar に当て、pillの外形（位置・影）は動かさずレイアウトシフトを防ぐ。
    ".kz-anchor.kz-enter .kz-btn{animation:kz-rise .5s cubic-bezier(.2,.85,.3,1) both}" +
    ".kz-anchor.kz-enter .kz-avatar{animation:kz-breathe 4.8s ease-in-out 1.4s infinite}" +
    "@keyframes kz-rise{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}" +
    "@keyframes kz-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}" +
    // ホバー時の補助フキダシ（PCで指す位置の説明）。
    ".kz-tip{position:absolute;right:4px;bottom:calc(100% + 12px);background:" + INK + ";color:#fff;font:12.5px/1 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;padding:7px 11px;border-radius:9px;white-space:nowrap;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}" +
    ".kz-btn:hover+.kz-tip,.kz-btn:focus-visible+.kz-tip{opacity:.96;transform:translateY(0)}" +
    // 初回コールアウト（自動表示・ホバー非依存・×で閉じる・しっぽ付き）。
    ".kz-callout{position:absolute;right:0;bottom:calc(100% + 14px);width:max-content;max-width:min(290px,calc(100vw - 40px));background:" + INK + ";color:#fff;font:13px/1.6 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;padding:13px 38px 13px 15px;border-radius:14px;box-shadow:0 12px 34px rgba(43,41,36,.34);opacity:0;transform:translateY(8px) scale(.98);transform-origin:bottom right;transition:opacity .32s cubic-bezier(.2,.8,.25,1),transform .32s cubic-bezier(.2,.8,.25,1);pointer-events:none;text-align:left}" +
    ".kz-callout.show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}" +
    // しっぽ：ボタンの中心あたりを指す。show時にふわっと出る（reduced-motionで動きを抑制）。
    ".kz-callout::after{content:'';position:absolute;right:30px;bottom:-6px;width:13px;height:13px;background:" + INK + ";border-radius:0 0 3px 0;transform:rotate(45deg);box-shadow:3px 3px 6px rgba(43,41,36,.10)}" +
    ".kz-callout .kz-callout-x{position:absolute;top:7px;right:7px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;padding:0;transition:background .15s ease}" +
    ".kz-callout .kz-callout-x:hover{background:rgba(255,255,255,.3)}" +
    ".kz-callout .kz-callout-x:focus-visible{outline:2px solid rgba(255,255,255,.85);outline-offset:1px}" +
    ".kz-callout .kz-callout-x svg{width:12px;height:12px}" +
    // パネル（窓口チャットの器）。
    ".kz-panel{position:absolute;right:0;bottom:calc(100% + 16px);width:400px;max-width:calc(100vw - 32px);height:min(620px,calc(100vh - 140px));height:min(620px,calc(100dvh - 140px));background:" + CREAM + ";border-radius:18px;box-shadow:0 0 0 1px rgba(43,41,36,.06),0 18px 56px rgba(43,41,36,.30);display:none;flex-direction:column;overflow:hidden;pointer-events:auto}" +
    ".kz-panel.open{display:flex;animation:kz-panel-in .26s cubic-bezier(.2,.8,.25,1) both}" +
    "@keyframes kz-panel-in{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}" +
    ".kz-bar{flex:none;display:flex;align-items:center;gap:9px;padding:11px 12px;background:" + BRAND + ";color:#fff;font:700 14px/1.3 ui-sans-serif,-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif}" +
    ".kz-bar .kz-title{flex:1;display:flex;align-items:center;gap:8px;min-width:0}" +
    ".kz-bar .kz-title img{width:24px;height:24px;border-radius:50%;background:#fff;flex:none;padding:1px;box-sizing:border-box}" +
    ".kz-bar a,.kz-bar button.kz-x{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:8px;background:rgba(255,255,255,.16);color:#fff;cursor:pointer;text-decoration:none;transition:background .15s ease}" +
    ".kz-bar a:hover,.kz-bar button.kz-x:hover{background:rgba(255,255,255,.32)}" +
    ".kz-bar a:focus-visible,.kz-bar button.kz-x:focus-visible{outline:2px solid #fff;outline-offset:1px}" +
    ".kz-bar svg{width:15px;height:15px}" +
    ".kz-frame{flex:1;width:100%;border:none;background:" + CREAM + "}" +
    // 狭い画面：機能ラベルを短縮し、はみ出さない。pillは右下に寄せ、パネルは左右に広がる。
    "@media (max-width:480px){.kz-anchor{right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px))}.kz-btn{padding:7px 16px 7px 7px}.kz-label-full{display:none}.kz-label-short{display:inline}.kz-tip{display:none}.kz-callout{right:0;max-width:calc(100vw - 32px)}.kz-panel{position:fixed;right:8px;left:8px;bottom:calc(84px + env(safe-area-inset-bottom,0px));width:auto;height:min(560px,calc(100dvh - 110px))}}" +
    // 動きを嫌う環境：登場・呼吸・しっぽ等の動きを止め、表示の切替だけ残す（情報は失わない）。
    "@media (prefers-reduced-motion:reduce){.kz-anchor.kz-enter .kz-btn,.kz-anchor.kz-enter .kz-avatar,.kz-panel.open{animation:none}.kz-btn{transition:box-shadow .2s ease}.kz-btn:hover{transform:none}.kz-callout{transition:opacity .12s linear}.kz-callout.show{transform:none}.kz-tip{transition:opacity .12s linear}}";

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

  // prefers-reduced-motion の判定（例外時は false＝動かす側に倒さず安全な既定へ）。
  // 1か所に集約し、登場アニメ・呼吸・コールアウトの演出すべてで同じ結果を使う。
  function prefersReducedMotion() {
    try {
      return (
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (e) {
      return false;
    }
  }

  function build() {
    // 冪等化：前回の部分失敗等で残った古いhostがあれば取り除いてから作る（二重生成防止）。
    var stale = document.getElementById("kaizen-widget-host");
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    var host = document.createElement("div");
    host.id = "kaizen-widget-host";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);

    // 位置レイヤー（fixed・safe-area尊重）。中の pill だけを transform で動かす。
    var anchor = document.createElement("div");
    anchor.className = "kz-anchor";

    // ラベル付きpillボタン：マスコット主役＋名前（小）＋機能ラベル（主）。
    // aria-label は用途が明確に伝わる一文を維持（スクリーンリーダー互換）。
    var btn = document.createElement("button");
    btn.className = "kz-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "ご意見・改善を送る（カイゼンくんに相談する）");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      '<span class="kz-avatar"><img src="' + ICON + '" alt="" onerror="this.style.display=\'none\'"></span>' +
      '<span class="kz-text">' +
      '<span class="kz-name">' + BTN_NAME + "</span>" +
      '<span class="kz-label">' +
      '<span class="kz-label-full">' + BTN_LABEL + "</span>" +
      '<span class="kz-label-short">' + BTN_LABEL_SHORT + "</span>" +
      "</span>" +
      "</span>";
    anchor.appendChild(btn);

    var tip = document.createElement("div");
    tip.className = "kz-tip";
    tip.textContent = "困ったらカイゼンくん";
    anchor.appendChild(tip);

    // 初回コールアウト（自動・ホバー非依存・×閉じ・自動収納・一度きり）。
    var callout = document.createElement("div");
    callout.className = "kz-callout";
    callout.setAttribute("role", "status");
    callout.innerHTML =
      '<span class="kz-callout-text"></span>' +
      '<button class="kz-callout-x" type="button" aria-label="この案内を閉じる">' + CLOSE + "</button>";
    callout.querySelector(".kz-callout-text").textContent = CALLOUT_TEXT;
    anchor.appendChild(callout);

    var panel = document.createElement("div");
    panel.className = "kz-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", "カイゼン窓口");
    panel.innerHTML =
      '<div class="kz-bar">' +
      '<span class="kz-title"><img src="' + ICON + '" alt="" onerror="this.style.display=\'none\'">カイゼンくん</span>' +
      '<a href="' + tabUrl + '" target="_blank" rel="noopener noreferrer" title="新しいタブで開く" aria-label="新しいタブで開く">' + EXTERNAL + "</a>" +
      '<button class="kz-x" type="button" title="閉じる" aria-label="閉じる">' + CLOSE + "</button>" +
      "</div>";
    anchor.appendChild(panel);

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
      frame.setAttribute("allow", "clipboard-write; clipboard-read");
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

    function setOpen(open) {
      if (open) {
        ensureFrame();
        hideCallout(); // パネルを開いたら案内は即消す（用が済んだ）
        markCalloutSeen(); // 一度開いた人には次回もコールアウトを出さない
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
    callout.querySelector(".kz-callout-x").addEventListener("click", function (e) {
      e.stopPropagation();
      hideCallout();
      markCalloutSeen(); // ×で閉じたら次回は出さない（一度きり）
    });
    panel.querySelector(".kz-x").addEventListener("click", function () {
      setOpen(false);
      try {
        btn.focus(); // 閉じたらトリガーへフォーカスを戻す（キーボード操作者の迷子防止）
      } catch (e) {
        /* focus不可環境は無視 */
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) {
        setOpen(false);
        try {
          btn.focus();
        } catch (err) {
          /* focus不可環境は無視 */
        }
      }
    });
    window.addEventListener("message", function (e) {
      if (e.origin !== origin) return; // 窓口オリジン以外からの close は無視
      if (e.data && e.data.type === "kaizen:close") setOpen(false);
    });

    // アンカー（pill・tip・コールアウト・パネルを内包）を Shadow root に載せる。
    root.appendChild(anchor);
    document.body.appendChild(host);

    // ── 登場・アイドルの演出（reduced-motion尊重）──
    // .kz-enter を付けると登場フェード＋ライズ→そのまま控えめな呼吸へ。
    // 動きを嫌う環境では付けない（CSS側でも二重に無効化済み）。
    if (!prefersReducedMotion()) {
      anchor.className = "kz-anchor kz-enter";
    }

    // 初回コールアウト：少しあとに自動表示。数秒で自動収納。localStorageで一度きり。
    if (shouldShowCallout()) {
      setTimeout(function () {
        if (isOpen()) return; // すでに開いていれば不要
        callout.className = "kz-callout show";
        markCalloutSeen(); // 出した時点で「見た」扱い（次回は出さない）
        calloutTimer = setTimeout(hideCallout, 9000); // 数秒で自動的に引っ込む
      }, 1400);
    }
  }

  // build を degrade-safe に包む：万一の例外でもホスト画面を絶対に壊さない。
  function safeBuild() {
    try {
      build();
    } catch (e) {
      // 初期化に失敗してもホスト画面は壊さない（degrade-safe）。さらにロードガードを解除し、
      // 別の<script>枚やDOMContentLoadedでの再試行を可能にする（フラグが立ったまま宙づり防止）。
      window.__kaizenWidgetLoaded = false;
      if (window.console && typeof console.error === "function") {
        console.error("[kaizen-widget] 初期化に失敗しました（ホスト画面には影響しません）", e);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeBuild);
  } else {
    safeBuild();
  }
})();
