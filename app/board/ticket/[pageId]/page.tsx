"use client";

// ── チケット詳細（/board/ticket/[pageId]） ──
// カード情報 + LINE会話（社長⇔カイゼンくんの往復）をタイムラインで表示。
// データは /api/kaizen/ticket/[pageId]（Notionの lineChat フィールドをパースして整形）。
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { metaOf } from "@/lib/board";

interface ChatEntry {
  sender: string;
  text: string;
  time?: string;
}

interface TicketDetail {
  ok: boolean;
  ticketId: string;
  title: string;
  system: string;
  state: string;
  url: string;
  chat: ChatEntry[];
  chatLineCount: number;
}

export default function TicketDetailPage() {
  const params = useParams<{ pageId: string }>();
  const pageId = params?.pageId;
  const [data, setData] = useState<TicketDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!pageId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/kaizen/ticket/${encodeURIComponent(pageId)}`, {
        cache: "no-store",
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) throw new Error(d?.error || "読み込みに失敗しました");
      setData(d as TicketDetail);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    load();
  }, [load]);

  const m = data ? metaOf(data.state) : null;

  return (
    <div className="board" style={{ maxWidth: 640, margin: "0 auto" }}>
      <header className="board-head">
        <div className="board-titlewrap">
          <h1>チケット詳細</h1>
          <div className="board-sub">
            <a href="/board" style={{ color: "inherit" }}>
              ← 状況ボードへ戻る
            </a>
          </div>
        </div>
        <button className="board-refresh" onClick={load} disabled={loading} title="今すぐ更新">
          {loading ? "更新中…" : "↻ 更新"}
        </button>
      </header>

      {error && <div className="error">読み込みエラー：{error}</div>}

      {data && (
        <>
          <div
            className="board-card"
            style={{ marginBottom: 20, cursor: "default" }}
          >
            <div className="board-card-top">
              <span className="board-card-id">{data.ticketId}</span>
              <span className="board-card-sys">{data.system}</span>
            </div>
            <div className="board-card-title" style={{ fontSize: 16 }}>
              {data.title}
            </div>
            <div className="board-card-foot">
              {m && (
                <span className="board-tag" style={{ color: m.color }}>
                  {m.emoji} {data.state}
                </span>
              )}
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer"
                className="board-tag"
                style={{ marginLeft: "auto" }}
              >
                Notionで開く ↗
              </a>
            </div>
          </div>

          <section>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              💬 LINE会話（{data.chatLineCount}件）
            </h2>
            {data.chat.length === 0 ? (
              <div className="board-empty">まだLINEでのやり取りがありません。</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {data.chat.map((c, i) => {
                  const isUser = c.sender === "user" || c.sender === "社長";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: isUser ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          maxWidth: "78%",
                          background: isUser ? "var(--user-bubble)" : "#fff",
                          border: isUser ? "none" : "1px solid var(--line)",
                          borderRadius: 14,
                          padding: "8px 14px",
                          fontSize: 14,
                          lineHeight: 1.6,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--muted)",
                            marginBottom: 2,
                          }}
                        >
                          {c.time ? `${c.time} ・ ` : ""}
                          {isUser ? "社長" : "カイゼンくん"}
                        </div>
                        {c.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
