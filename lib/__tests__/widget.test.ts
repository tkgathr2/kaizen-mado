// public/widget.js（埋め込みウィジェット）の検証。
// 2層で守る：
//  (A) 静的検証 … 「構文が正しい」「壊れやすい約束事（Shadow DOM/二重ロード/オリジン検査等）が
//                 守られている」を、ソース文字列の機械チェックで足切りする。
//  (B) ランタイム検証 … 軽量DOMスタブ上で build() を実走し、pill描画・初回コールアウトの
//                 自動表示/×/自動収納/一度きり・パネル開閉・reduced-motion分岐を裏取りする。
//                 （jsdom等の新規依存を足さず、node環境のまま決定的・オフラインで通す）
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const src = readFileSync(path.resolve(__dirname, "../../public/widget.js"), "utf-8");

describe("widget.js（静的検証）", () => {
  it("構文エラーなく関数として評価できる", () => {
    // 実行はしない（DOM不要）。構文チェックのみ。
    expect(() => new Function(src)).not.toThrow();
  });

  it("二重ロードガードがある（同じscriptを2回貼っても1個しか出ない）", () => {
    expect(src).toContain("__kaizenWidgetLoaded");
  });

  it("data-sys を読み、URLエンコードして窓口URLに渡す", () => {
    expect(src).toContain('getAttribute("data-sys")');
    expect(src).toContain("encodeURIComponent(sys)");
    expect(src).toContain("embed=1");
  });

  it("Shadow DOM を使いホストCSSと隔離する（:host{all:initial}）", () => {
    expect(src).toContain("attachShadow");
    expect(src).toContain(":host{all:initial}");
  });

  it("postMessage の close はオリジン検査つき", () => {
    expect(src).toContain("e.origin !== origin");
    expect(src).toContain("kaizen:close");
  });

  it("既定オリジンは kaizen.takagi.bz", () => {
    expect(src).toContain("https://kaizen.takagi.bz");
  });

  it("埋め込み元の window.kaizenUser を reporter として窓口へ引き継ぐ", () => {
    expect(src).toContain("window.kaizenUser");
    expect(src).toContain('"&reporter=" + encodeURIComponent');
  });

  it("マスコット画像（フクロウ博士）は窓口と同じオリジンから読む", () => {
    expect(src).toContain('origin + "/kaizen-kun.png"');
  });

  it("マスコット画像の読込失敗時はonerrorで隠す（壊れアイコンを出さない）", () => {
    expect(src).toContain("onerror=");
    expect(src).toContain("this.style.display");
  });

  it("middleware がマスコット画像を認証除外している（埋め込み先でアイコンが消える事故防止）", () => {
    const mw = readFileSync(path.resolve(__dirname, "../../middleware.ts"), "utf-8");
    expect(mw).toContain("kaizen-kun.png");
    expect(mw).toContain("widget.js");
  });

  it("新しいタブで開く導線がある（iframe内で認証が通らない環境のフォールバック）", () => {
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener noreferrer"');
  });

  it("複数枚設置でも最初の1枚を採用する（currentScript無し環境は先頭scriptへフォールバック）", () => {
    // 古い環境のフォールバックは querySelectorAll の先頭(list[0])を使う＝最初の1枚。
    expect(src).toContain("document.currentScript");
    expect(src).toContain("list[0]");
  });

  it("data-sys 取得失敗時は警告ログを出して安全に窓口を開く", () => {
    expect(src).toContain("console.warn");
    expect(src).toContain("data-sys");
  });

  // ── 例外時もホスト画面を壊さない（degrade-safe）──
  it("build を try/catch で包み、例外時もホスト画面を壊さない", () => {
    expect(src).toContain("safeBuild");
    expect(src).toContain("try {");
    expect(src).toContain("console.error");
  });

  // ── 発見性の改善（pill・初回コールアウト・a11y）──

  it("休止状態はラベル付きpill（読めば用途が分かる文言が入っている）", () => {
    // ボタンに「ご意見・改善はこちら」の機能ラベルが出る＝何のボタンか一読で分かる。
    expect(src).toContain("ご意見・改善はこちら");
    // マスコットの名前を小さく添える＝"顔の見える相談相手"の認知が育つ。
    expect(src).toContain("カイゼンくん");
    expect(src).toContain('class="kz-name"');
    // 狭い画面用の短いラベルも持つ（はみ出し対策）。
    expect(src).toContain('class="kz-label-short"');
  });

  it("狭い画面(<=480px)ではラベルを短縮し、はみ出さない", () => {
    expect(src).toContain("@media (max-width:480px)");
    // 短いラベルへ切り替えるCSSがある。
    expect(src).toContain(".kz-label-short{display:inline}");
    // pillに最大幅の上限があり画面外へ出ない。
    expect(src).toContain("max-width:calc(100vw - 40px)");
  });

  it("iOSのセーフエリア(env(safe-area-inset-*))を尊重して端に食い込まない", () => {
    expect(src).toContain("env(safe-area-inset-right");
    expect(src).toContain("env(safe-area-inset-bottom");
  });

  it("タップ領域は44px以上を満たす（pillの最小高さ56px）", () => {
    expect(src).toContain("min-height:56px");
  });

  it("初回コールアウトは localStorage で一度きり（衝突しない固有キー）", () => {
    expect(src).toContain("kaizen-widget:first-visit-callout:v1");
    expect(src).toContain("localStorage");
    expect(src).toContain("shouldShowCallout");
    expect(src).toContain("markCalloutSeen");
  });

  it("初回コールアウトはホバー非依存で自動表示し、×と自動収納で閉じる", () => {
    // 文面（送っていいと思える優しい説明・どんな小さなことでも）。
    expect(src).toContain("気軽に送れます");
    expect(src).toContain("どんな小さなことでも");
    // 自動表示の遅延と、自動収納のタイマー。
    expect(src).toContain("1400");
    expect(src).toContain("9000");
    // ×ボタンで閉じられる。
    expect(src).toContain("この案内を閉じる");
  });

  it("パネルを開いたらコールアウトは即消える", () => {
    // setOpen(true) の経路で hideCallout を呼ぶ。
    expect(src).toContain("hideCallout()");
  });

  it("登場・呼吸の演出は transform/opacity のみ（レイアウトシフトを出さない）", () => {
    // 位置(fixed)とアニメ(transform)を別レイヤーに分けている。
    expect(src).toContain("kz-anchor");
    expect(src).toContain("kz-enter");
    expect(src).toContain("@keyframes kz-rise");
    expect(src).toContain("@keyframes kz-breathe");
  });

  it("prefers-reduced-motion を尊重して動きを減らせる", () => {
    expect(src).toContain("prefers-reduced-motion");
    expect(src).toContain("matchMedia");
    expect(src).toContain("prefersReducedMotion");
  });

  it("aria/キーボード導線を維持する（haspopup・expanded・focus-visible・Esc）", () => {
    expect(src).toContain('btn.setAttribute("aria-label"');
    expect(src).toContain('aria-haspopup", "dialog"');
    expect(src).toContain('aria-expanded');
    // フォーカスでもツールチップが出る（キーボード操作者にも説明が届く）。
    expect(src).toContain(".kz-btn:focus-visible+.kz-tip");
    // Escでパネルを閉じ、トリガーへフォーカスを戻す。
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain("btn.focus()");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (B) ランタイム検証：軽量DOMスタブ上で build() を実走する。
// jsdomを足さず、widget.js が触るAPIだけを最小実装したスタブで決定的に動かす。
// ────────────────────────────────────────────────────────────────────────────

// 最小DOM要素スタブ。className/属性/子要素/イベント/innerHTML(querySelector用)を持つ。
class StubEl {
  tagName: string;
  className = "";
  id = "";
  parentNode: StubEl | null = null;
  style: Record<string, string> = {};
  children: StubEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  // querySelector を効かせるための「擬似マークアップ」。innerHTML で代入された文字列から
  // class名を拾い、対応する子スタブを生成する（このウィジェットが使う範囲に限定）。
  private _html = "";
  src = "";
  title = "";
  textContent = "";
  focused = false;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }
  attachShadow() {
    // Shadow root も同じスタブで代用（appendChild/querySelector が使えれば十分）。
    // host の子として繋いでおき、findAll/querySelector が shadow内まで辿れるようにする。
    const shadow = new StubEl("#shadow-root");
    this.children.push(shadow);
    return shadow;
  }
  appendChild(child: StubEl) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: StubEl) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === "class") this.className = v;
  }
  getAttribute(k: string) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type: string, e: unknown = {}) {
    (this.listeners[type] || []).forEach((fn) => fn(e));
  }
  focus() {
    this.focused = true;
  }
  set innerHTML(html: string) {
    this._html = html;
    // このウィジェットが後で querySelector する class を持つ子を生成しておく。
    const classes = [
      "kz-callout-text",
      "kz-callout-x",
      "kz-title",
      "kz-x",
      "kz-label",
      "kz-name",
      "kz-avatar",
    ];
    for (const c of classes) {
      if (html.includes('class="' + c + '"') || html.includes("class='" + c + "'")) {
        const el = new StubEl("span");
        el.className = c;
        this.children.push(el);
      }
    }
  }
  get innerHTML() {
    return this._html;
  }
  // 自分・子孫から class セレクタ（".foo"）で最初の1個を返す簡易実装。
  querySelector(sel: string): StubEl | null {
    const want = sel.replace(/^\./, "");
    const walk = (el: StubEl): StubEl | null => {
      for (const c of el.children) {
        if (c.className.split(/\s+/).includes(want)) return c;
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  // 全ノードを class で平坦検索（テスト側の検証用ヘルパ）。
  findAll(className: string): StubEl[] {
    const out: StubEl[] = [];
    const walk = (el: StubEl) => {
      for (const c of el.children) {
        if (c.className.split(/\s+/).includes(className)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

// build() を走らせるための window/document スタブ一式を組み立てる。
function setupDom(opts: { reducedMotion?: boolean; calloutSeen?: boolean } = {}) {
  const body = new StubEl("body");
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const winListeners: Record<string, Array<(e: unknown) => void>> = {};
  const store = new Map<string, string>();
  if (opts.calloutSeen) store.set("kaizen-widget:first-visit-callout:v1", "1");

  const documentStub = {
    readyState: "complete",
    currentScript: {
      getAttribute(k: string) {
        if (k === "data-sys") return "prorepo";
        return null;
      },
      src: "https://kaizen.takagi.bz/widget.js",
    },
    body,
    createElement: (tag: string) => new StubEl(tag),
    getElementById: (id: string) => {
      const walk = (el: StubEl): StubEl | null => {
        for (const c of el.children) {
          if (c.id === id) return c;
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(body);
    },
    querySelectorAll: () => [] as unknown[],
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (docListeners[type] ||= []).push(fn);
    },
  };

  const windowStub: Record<string, unknown> = {
    __kaizenWidgetLoaded: undefined,
    kaizenUser: undefined,
    console,
    matchMedia: (q: string) => ({
      matches: q.includes("prefers-reduced-motion") ? !!opts.reducedMotion : false,
    }),
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (winListeners[type] ||= []).push(fn);
    },
  };

  return { body, documentStub, windowStub, docListeners, winListeners, store };
}

// widget.js を「window/document/localStorage を引数で渡せる関数」として評価する。
// （IIFE内が参照する自由変数を、Functionの引数で差し替える）
function runWidget(env: {
  windowStub: Record<string, unknown>;
  documentStub: unknown;
}) {
  // URL は node 組み込みを使わせる（new URL(...).origin が必要）。
  const factory = new Function(
    "window",
    "document",
    "URL",
    "setTimeout",
    "clearTimeout",
    src
  );
  factory(
    env.windowStub,
    env.documentStub,
    URL,
    globalThis.setTimeout,
    globalThis.clearTimeout
  );
}

describe("widget.js（ランタイム検証 / build() 実走）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pill が描画され、host が body に追加される（マスコット＋名前＋機能ラベル）", () => {
    const env = setupDom();
    runWidget(env);
    // host が body に追加される。
    expect(env.body.children.length).toBe(1);
    const host = env.body.children[0];
    expect(host.id).toBe("kaizen-widget-host");
    // pill・アンカー・テキストノードが生成される。
    expect(host.findAll("kz-anchor").length).toBe(1);
    expect(host.findAll("kz-btn").length).toBe(1);
    expect(host.findAll("kz-name").length).toBeGreaterThan(0);
    expect(host.findAll("kz-label").length).toBeGreaterThan(0);
    const btn = host.findAll("kz-btn")[0];
    // a11y 属性が乗っている。
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("二重ロードガード：2回評価しても host は1つだけ", () => {
    const env = setupDom();
    runWidget(env);
    // 1回目で __kaizenWidgetLoaded が立つ。2回目は即return。
    runWidget(env);
    expect(env.body.children.length).toBe(1);
  });

  it("冪等化：前回の残骸 host があれば取り除いてから作る（二重生成しない）", () => {
    const env = setupDom();
    const stale = new StubEl("div");
    stale.id = "kaizen-widget-host";
    env.body.appendChild(stale);
    runWidget(env);
    // 残骸は除去され、新しい host 1つだけになる。
    expect(env.body.children.length).toBe(1);
    expect(env.body.children[0]).not.toBe(stale);
    expect(env.body.children[0].id).toBe("kaizen-widget-host");
  });

  it("degrade-safe：build 失敗時はロードガードを解除して再試行可能にする", () => {
    const env = setupDom();
    let calls = 0;
    // 2回目の createElement で例外＝build途中で失敗させる。
    (env.documentStub as { createElement: (t: string) => StubEl }).createElement = (
      tag: string
    ) => {
      calls += 1;
      if (calls >= 2) throw new Error("boom");
      return new StubEl(tag);
    };
    runWidget(env);
    // ホストは追加されず（or 途中）、ガードは false に戻って次の試行を許す。
    expect(env.windowStub.__kaizenWidgetLoaded).toBe(false);
  });

  it("初回コールアウト：遅延後に自動表示され、自動収納で閉じる", () => {
    const env = setupDom({ calloutSeen: false });
    runWidget(env);
    const host = env.body.children[0];
    const callout = host.findAll("kz-callout")[0];
    expect(callout.className).toBe("kz-callout"); // まだ非表示
    vi.advanceTimersByTime(1400); // 自動表示の遅延
    expect(callout.className).toContain("show"); // 表示された
    // 「見た」記録が入り、次回は出さない。
    expect(env.store.get("kaizen-widget:first-visit-callout:v1")).toBe("1");
    vi.advanceTimersByTime(9000); // 自動収納
    expect(callout.className).toBe("kz-callout"); // 引っ込んだ
  });

  it("初回コールアウト：×で閉じ、二度目以降は出さない（一度きり）", () => {
    const env = setupDom({ calloutSeen: false });
    runWidget(env);
    const host = env.body.children[0];
    const callout = host.findAll("kz-callout")[0];
    vi.advanceTimersByTime(1400);
    expect(callout.className).toContain("show");
    // ×を押す。
    const x = callout.querySelector(".kz-callout-x")!;
    x.dispatch("click", { stopPropagation() {} });
    expect(callout.className).toBe("kz-callout");
    expect(env.store.get("kaizen-widget:first-visit-callout:v1")).toBe("1");
  });

  it("再訪（calloutSeen=true）ではコールアウトを出さない", () => {
    const env = setupDom({ calloutSeen: true });
    runWidget(env);
    const host = env.body.children[0];
    const callout = host.findAll("kz-callout")[0];
    vi.advanceTimersByTime(20000);
    expect(callout.className).toBe("kz-callout"); // 一度も show にならない
  });

  it("パネル開閉：クリックで開き、Escで閉じ、開けばコールアウトは消える", () => {
    const env = setupDom({ calloutSeen: false });
    runWidget(env);
    const host = env.body.children[0];
    const btn = host.findAll("kz-btn")[0];
    const panel = host.findAll("kz-panel")[0];
    const callout = host.findAll("kz-callout")[0];
    vi.advanceTimersByTime(1400);
    expect(callout.className).toContain("show");
    // クリックで開く。
    btn.dispatch("click");
    expect(panel.className).toContain("open");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    // 開いたらコールアウトは即消える。
    expect(callout.className).toBe("kz-callout");
    // iframe が遅延生成される（開くまでは無い）。
    expect(panel.findAll("kz-frame").length).toBe(1);
    // Esc で閉じる（document の keydown へ配信）。
    env.docListeners["keydown"].forEach((fn) => fn({ key: "Escape" }));
    expect(panel.className).toBe("kz-panel");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // 閉じたらトリガーへフォーカスが戻る。
    expect(btn.focused).toBe(true);
  });

  it("reduced-motion=true のとき登場アニメ（kz-enter）を付けない", () => {
    const env = setupDom({ reducedMotion: true });
    runWidget(env);
    const host = env.body.children[0];
    const anchor = host.findAll("kz-anchor")[0];
    expect(anchor.className).toBe("kz-anchor"); // kz-enter 無し
  });

  it("reduced-motion=false のとき登場アニメ（kz-enter）を付ける", () => {
    const env = setupDom({ reducedMotion: false });
    runWidget(env);
    const host = env.body.children[0];
    const anchor = host.findAll("kz-anchor")[0];
    expect(anchor.className).toContain("kz-enter");
  });

  it("postMessage close：窓口オリジンからのみ閉じる（他オリジンは無視）", () => {
    const env = setupDom();
    runWidget(env);
    const host = env.body.children[0];
    const btn = host.findAll("kz-btn")[0];
    const panel = host.findAll("kz-panel")[0];
    btn.dispatch("click"); // 開く
    expect(panel.className).toContain("open");
    // 別オリジンからの close は無視。
    env.winListeners["message"].forEach((fn) =>
      fn({ origin: "https://evil.example", data: { type: "kaizen:close" } })
    );
    expect(panel.className).toContain("open");
    // 窓口オリジンからの close は効く。
    env.winListeners["message"].forEach((fn) =>
      fn({ origin: "https://kaizen.takagi.bz", data: { type: "kaizen:close" } })
    );
    expect(panel.className).toBe("kz-panel");
  });

  it("reporter 引き継ぎ：window.kaizenUser があれば iframe.src に付く", () => {
    const env = setupDom();
    env.windowStub.kaizenUser = "脇本 佳名子";
    runWidget(env);
    const host = env.body.children[0];
    const btn = host.findAll("kz-btn")[0];
    btn.dispatch("click");
    const frame = host.findAll("kz-frame")[0];
    expect(frame.src).toContain("embed=1");
    expect(frame.src).toContain("sys=prorepo");
    expect(frame.src).toContain("reporter=");
  });
});
