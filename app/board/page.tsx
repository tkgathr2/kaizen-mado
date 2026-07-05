"use client";

// ── カイゼンくん 状況ボード（/board） ──
// 「声→起票→議論→GO待ち→着手→実装中→レビュー→完了」の全チケットの流れを1画面で見える化。
// データは /api/board（Notion改善チケットDBを状態ごとに整形・読み取り専用）。
// 20秒ごとに自動更新。操作ボタンは置かない（対人送信・本番破壊なし＝見るだけ）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardColumn } from "@/lib/board";
// 状態ごとの見た目（絵文字＋色）は lib/board.ts の正本を使う（状態名のズレを防ぐ）。
// 滞留判定・要対応集計も lib/board.ts の純粋関数（テスト済み）を使う。
import { metaOf, isCardStalled, heroSummary } from "@/lib/board";

interface BoardData {
  ok: boolean;
  configured: boolean;
  columns: BoardColumn[];
  counts: Record<string, number>;
  total: number;
  updatedAt: string;
}

const IMP_COLOR: Record<string, string> = { 高: "#b4452b", 中: "#9a5a16", 低: "#83807a" };
// 優先度バッジ色（仕様書 §4.13・確認カードと同色）。
const PRIO_COLOR: Record<string, string> = { 高: "#A32D2D", 中: "#BA7517", 低: "#5F5E5A" };

const POLL_MS = 20000;

function relTime(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return `${d}日前`;
}

function doneDateMD(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function clockHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function BoardPage() {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 列ごとの折りたたみ状態。モバイル初回表示では「完了」を畳んで現役チケットを先に見せる。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const didInitCollapse = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/board", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d?.ok) throw new Error(d?.error || "読み込みに失敗しました");
      setData(d as BoardData);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  // 初回データ到着時のみ：
  // - モバイル幅なら「完了」列を畳む（現役チケットを先に見せる）
  // - 空列（0件）はデスクトップでも畳んだ状態で始める（視覚ノイズ削減。開閉は既存トグルで可能）
  // 開閉操作はその後ユーザーに委ねる。
  useEffect(() => {
    if (!data || didInitCollapse.current) return;
    didInitCollapse.current = true;
    const init: Record<string, boolean> = {};
    for (const col of data.columns) {
      if (col.cards.length === 0) init[col.state] = true;
    }
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 719px)").matches) {
      init["完了"] = true;
    }
    setCollapsed(init);
  }, [data]);

  const toggleCol = (state: string) =>
    setCollapsed((p) => ({ ...p, [state]: !p[state] }));

  // サマリーチップ→該当列へスクロール（畳まれていれば開く）。
  // smooth は展開に伴う再レイアウトで中断されることがあるため、確実な即時ジャンプにする。
  const jumpToCol = (state: string) => {
    setCollapsed((p) => ({ ...p, [state]: false }));
    setTimeout(() => {
      document.getElementById(`col-${state}`)?.scrollIntoView({ block: "start" });
    }, 80);
  };

  // 要対応サマリー（ヒーローバー）。20秒ポーリングごとの再レンダーで now も進む。
  const now = Date.now();
  const hero =
    data && data.configured && data.total > 0 ? heroSummary(data.columns, now) : null;

  const handleBoardAction = async (pageId: string, action: "go" | "reject") => {
    setActionInFlight(pageId);
    try {
      // サーバーからトークンを取得してから操作を実行
      const tokenResp = await fetch(`/api/board/proposal-token?pageId=${encodeURIComponent(pageId)}`);
      const tokenData = await tokenResp.json();
      if (!tokenData.token) {
        alert("トークン取得に失敗しました");
        return;
      }

      const resp = await fetch("/api/board/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId, action, token: tokenData.token }),
      });
      const result = await resp.json();
      if (!result.ok) {
        alert(`操作に失敗しました: ${result.error}`);
        return;
      }
      alert(`✓ ${action === "go" ? "GO" : "却下"} を実行しました`);
      // 即座に再読み込み
      await load();
    } catch (e) {
      alert(`エラー: ${(e as Error).message}`);
    } finally {
      setActionInFlight(null);
    }
  };

  return (
    <div className="board">
      <header className="board-head">
        <img src="/kaizen-kun.png" alt="カイゼンくん" className="board-logo" />
        <div className="board-titlewrap">
          <h1>カイゼン状況ボード</h1>
          <div className="board-sub">
            声 → 起票 → 議論 → GO待ち → 着手 → 実装中 → レビュー → 完了 ／ 20秒ごとに自動更新
          </div>
        </div>
        <button className="board-refresh" onClick={load} disabled={loading} title="今すぐ更新">
          {loading ? "更新中…" : "↻ 更新"}
        </button>
      </header>

      {error && <div className="error">読み込みエラー：{error}</div>}

      {data && !data.configured && (
        <div className="board-note">
          Notion未接続のため表示できません（環境変数 NOTION_TOKEN / NOTION_DATABASE_ID 未設定）。
        </div>
      )}

      {data && data.configured && data.total === 0 && (
        <div className="board-meta">
          全 {data.total} 件 ／ 最終取得 {clockHHMM(data.updatedAt)}
        </div>
      )}

      {data && data.configured && data.total === 0 && (
        <div className="board-blank">
          まだ声がありません。各システム右下のフクロウ博士からどうぞ。
        </div>
      )}

      {data && data.configured && data.total > 0 && hero && (
        <>
          {/* 要対応ヒーローバー：GO待ち／止まってるかも／今日完了 を最上部で大きく見せる */}
          <div className="board-hero" role="status">
            {hero.allClear ? (
              <div className="board-hero-ok">
                🟢 すべて順調・要対応なし
                {hero.doneToday > 0 && (
                  <span className="board-hero-sub">（✅ 今日完了 {hero.doneToday}件）</span>
                )}
              </div>
            ) : (
              <>
                {hero.goWait > 0 && (
                  <button
                    type="button"
                    className="board-hero-item hero-go"
                    onClick={() => jumpToCol("GO待ち")}
                    title="GO待ち列へ移動"
                  >
                    🟢 GO待ち {hero.goWait}件
                    {hero.goWaitOver > 0 && (
                      <span className="board-hero-sub">（⏰48時間超 {hero.goWaitOver}件）</span>
                    )}
                  </button>
                )}
                {hero.stalledActive > 0 && (
                  <button
                    type="button"
                    className="board-hero-item hero-stall"
                    onClick={() => jumpToCol(hero.firstStalledState ?? "着手")}
                    title="停滞中の列へ移動"
                  >
                    ⚠️ 止まってるかも {hero.stalledActive}件
                  </button>
                )}
                <button
                  type="button"
                  className="board-hero-item hero-done"
                  onClick={() => jumpToCol("完了")}
                  title="完了列へ移動"
                >
                  ✅ 今日完了 {hero.doneToday}件
                </button>
              </>
            )}
          </div>
          <div className="board-meta">
            全 {data.total} 件 ／ 最終取得 {clockHHMM(data.updatedAt)}
          </div>
          <div className="board-summary">
            {Object.entries(data.counts)
              .filter(([, count]) => count > 0)
              .map(([state, count]) => {
                const m = metaOf(state);
                return (
                  <button
                    key={state}
                    type="button"
                    className="board-summary-item"
                    onClick={() => jumpToCol(state)}
                    title={`${state}の列へ移動`}
                  >
                    <span aria-hidden>{m.emoji}</span>
                    {state}: {count}
                  </button>
                );
              })}
          </div>
          <div className="board-cols">
            {data.columns.map((col) => {
              const m = metaOf(col.state);
              const isCollapsed = !!collapsed[col.state];
              // 列内に停滞カードがあれば、列ヘッダに警告ドットを出す。
              const hasStalled = col.cards.some(
                (c) => isCardStalled(col.state, c.lastEdited, now).stalled
              );
              return (
                <section
                  key={col.state}
                  id={`col-${col.state}`}
                  className={`board-col${col.cards.length === 0 ? " is-empty" : ""}${isCollapsed ? " is-collapsed" : ""}`}
                >
                  <button
                    type="button"
                    className="board-col-head"
                    style={{ borderTopColor: m.color }}
                    onClick={() => toggleCol(col.state)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? "タップで開く" : "タップで畳む"}
                  >
                    <span className="board-col-name">
                      <span aria-hidden>{m.emoji}</span> {col.state}
                      {hasStalled && (
                        <span
                          className="board-col-warn-dot"
                          title="停滞しているカードがあります"
                          aria-label="停滞しているカードがあります"
                        >
                          •
                        </span>
                      )}
                    </span>
                    <span className="board-col-count">{col.cards.length}</span>
                    <span className="board-col-chevron" aria-hidden>
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  <div className="board-col-body">
                    {col.cards.length === 0 && <div className="board-empty">—</div>}
                    {col.cards.map((c) => {
                      const stall = isCardStalled(col.state, c.lastEdited, now);
                      // 緊急度／重要度の数字は常時表示をやめ、ホバー（title）へ移動（ノイズ削減）。
                      const scoreHint =
                        typeof c.urgency === "number" || typeof c.importanceScore === "number"
                          ? ` ／ 緊急度${typeof c.urgency === "number" ? c.urgency : "—"}／重要度${
                              typeof c.importanceScore === "number" ? c.importanceScore : "—"
                            }（各10点満点）`
                          : "";
                      return (
                      <div
                        key={c.pageId}
                        className={`board-card-wrap${col.state === "GO待ち" ? " has-actions" : ""}`}
                      >
                        <a
                          className={`board-card${stall.stalled ? " is-stalled" : ""}`}
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`Notionでチケット全文を開く${scoreHint}`}
                        >
                          <div className="board-card-top">
                            <span className="board-card-id">{c.ticketId || "KZ-?"}</span>
                            <span className="board-card-sys">{c.system}</span>
                          </div>
                          <div className="board-card-title">{c.title}</div>
                          <div className="board-card-foot">
                            {c.type && <span className="board-tag">{c.type}</span>}
                            {/* 優先度バッジ（新）。旧チケット（priority無し）は出さず重要度のみ表示。 */}
                            {c.priority ? (
                              <span
                                className="board-prio"
                                style={{ background: PRIO_COLOR[c.priority] ?? "#5F5E5A" }}
                              >
                                優先度{c.priority}
                              </span>
                            ) : (
                              c.importance && (
                                <span
                                  className="board-tag"
                                  style={{ color: IMP_COLOR[c.importance] ?? "#83807a" }}
                                >
                                  重要度{c.importance}
                                </span>
                              )
                            )}
                            {stall.stalled && (
                              <span
                                className={`board-stall-badge${stall.kind === "goWait" ? " is-gowait" : ""}`}
                              >
                                {stall.label}
                              </span>
                            )}
                            {c.lastEdited && (
                              <span className="board-card-time">{relTime(c.lastEdited)}</span>
                            )}
                            {col.state === "完了" && c.statusChangedAt && (
                              <span className="board-card-done-date">{doneDateMD(c.statusChangedAt)}</span>
                            )}
                          </div>
                        </a>
                        <a
                          href={`/board/ticket/${encodeURIComponent(c.pageId)}`}
                          className="board-card-chatlink"
                          title="LINE会話を見る"
                          onClick={(e) => e.stopPropagation()}
                        >
                          💬 LINE会話
                        </a>
                        {col.state === "GO待ち" && (
                          <div className="board-card-actions">
                            <button
                              className="board-action-btn go-btn"
                              onClick={() => handleBoardAction(c.pageId, "go")}
                              disabled={actionInFlight === c.pageId}
                              title="このチケットにGOします"
                            >
                              {actionInFlight === c.pageId ? "…" : "✓ GO"}
                            </button>
                            <button
                              className="board-action-btn reject-btn"
                              onClick={() => handleBoardAction(c.pageId, "reject")}
                              disabled={actionInFlight === c.pageId}
                              title="このチケットを却下します"
                            >
                              {actionInFlight === c.pageId ? "…" : "✕ 却下"}
                            </button>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {!data && !error && <div className="typing">読み込み中…</div>}

      <div className="board-footer">
        カイゼンくん 状況ボード ／ 読み取り専用（操作はLINE・Notion・GitHubで） ／{" "}
        <a href="/dashboard">成長ダッシュボード</a>
          {" ／ "}
          <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>🔁 自動ループ稼働中</span>
      </div>
    </div>
  );
}
