"use client";

import { Suspense, useEffect, useRef, useState } from "react";
// 二重送信ガード：React state は非同期更新のため、連打で状態更新前に再発火し得る。
// ref は同期更新なので「実行中」を確実にブロックでき、重複起票/重複送信を防ぐ。
import { useSearchParams } from "next/navigation";
import { resolveSystem } from "@/lib/systems";
import { isEmbed } from "@/lib/embed";
import type { ChatMessage, Ticket } from "@/lib/types";

function greeting(systemName: string | null): string {
  if (systemName) {
    return `${systemName}のカイゼン窓口です。${systemName}について「困っていること」「こうなったら嬉しいこと」「気づいたこと」を、気軽に教えてください。まずはどんなことか、一言で大丈夫です。`;
  }
  return "高木産業グループのカイゼン窓口です。システムへの困りごと・改善のご要望をお聞きします。まず、どのシステムについてのお話か教えていただけますか？（例：プロレポ／ステレポ／ほうこちゃん など）";
}

function KaizenMado() {
  const params = useSearchParams();
  const sysRaw = params.get("sys");
  const systemName = resolveSystem(sysRaw);
  // 埋め込みモード（widget.js の iframe 内）：ヘッダー/フッターを畳んでチャットに集中させる。
  // パネルのタイトルバー・閉じるボタンは widget.js 側（親ページ）が持つ。
  const embed = isEmbed(params.get("embed"));
  // 埋め込み元のログイン済みユーザー名（widget.js が window.kaizenUser から引き継ぐ）。
  // ある場合は「お名前」入力欄を出さず、そのまま起票の reporter に使う。
  const reporterParam = (params.get("reporter") ?? "").trim();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"clarify" | "confirm">("clarify");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [reporter, setReporter] = useState(reporterParam);
  const [status, setStatus] = useState<"chatting" | "submitting" | "done">("chatting");
  const [doneId, setDoneId] = useState<string>("");
  const [error, setError] = useState("");
  // 簡易モード（AI未応答でフォールバック）で返したアシスタント発話の index 集合。
  // そのターンだけ「※ いまは簡易モードで受付中です」と薄く注記する。
  const [fallbackIdx, setFallbackIdx] = useState<Set<number>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false); // send/submit 実行中フラグ（同期・二重発火防止）

  // 初期挨拶（ローカル生成。履歴の一部としてモデルにも渡る）
  useEffect(() => {
    setMessages([{ role: "assistant", content: greeting(systemName) }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sysRaw]);

  // 会話の自動追従：新着メッセージ・確認カード表示・送信完了のたびに最下部へスクロール。
  // DOM反映後に確実に追従させるため requestAnimationFrame を1枚挟む。
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages, busy, status, phase, ticket]);

  async function send() {
    const text = input.trim();
    if (!text || busy || status !== "chatting" || inFlightRef.current) return;
    inFlightRef.current = true;
    setError("");
    setInput("");
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system: sysRaw, messages: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "通信に失敗しました");

      setMessages((m) => {
        // このアシスタント発話が簡易モード（fallback）なら index を控える。
        if (data?.fallback) {
          const idx = m.length;
          setFallbackIdx((s) => new Set(s).add(idx));
        }
        return [...m, { role: "assistant", content: data.reply }];
      });
      setPhase(data.phase === "confirm" ? "confirm" : "clarify");
      setTicket(data.phase === "confirm" ? (data.ticket as Ticket) : null);
    } catch (e) {
      // ここに来るのは想定外（API側でフォールバック済み）。会話は続けられるようにする。
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "すみません、うまく受け取れませんでした。もう一度だけ、要点を教えていただけますか？",
        },
      ]);
    } finally {
      setBusy(false);
      inFlightRef.current = false;
    }
  }

  async function submit() {
    if (!ticket || status !== "chatting" || inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus("submitting");
    setError("");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, reporter: reporter.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "起票に失敗しました");
      setDoneId(data.ticketId || "KZ-受付");
      setStatus("done");
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `送りました（${data.ticketId}）。ありがとうございました！` },
      ]);
    } catch (e) {
      setError((e as Error).message);
      setStatus("chatting");
    } finally {
      inFlightRef.current = false;
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const showConfirm = phase === "confirm" && ticket && status !== "done";

  return (
    <div className={embed ? "app embed" : "app"}>
      {!embed && (
        <header className="header">
          <div className="logo">🛠️</div>
          <div>
            <h1>カイゼン窓口</h1>
            <div className="sub">高木産業グループ カイゼンくん</div>
            <div className="catchphrase">気づいたことを送ると、システムが良くなっていきます</div>
          </div>
          <div className="pill">{systemName ? `対象：${systemName}` : "対象：未指定"}</div>
        </header>
      )}

      <div className="chat" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`row ${m.role}`}>
            <div className="bubble">{m.content}</div>
            {m.role === "assistant" && fallbackIdx.has(i) && (
              <div className="fallback-note">※ いまは簡易モードで受付中です</div>
            )}
          </div>
        ))}

        {busy && <div className="typing">入力中…</div>}

        {showConfirm && ticket && (
          <div className="confirm-card">
            <dl>
              <dt>対象</dt>
              <dd>{ticket.system}</dd>
              <dt>種別</dt>
              <dd>{ticket.type}</dd>
              <dt>重要度</dt>
              <dd>{ticket.importance}</dd>
              <dt>件名</dt>
              <dd>{ticket.title}</dd>
              <dt>内容</dt>
              <dd>{ticket.detail}</dd>
            </dl>
          </div>
        )}

        {status === "done" && (
          <div className="done">
            送信が完了しました 🎉
            <br />
            受付番号 <span className="kz">{doneId}</span>
            <br />
            <small>CTO室で内容を確認し、改善を検討します。ありがとうございました。</small>
          </div>
        )}
      </div>

      {showConfirm && (
        <>
          {!reporterParam && (
            <div className="reporter">
              <label htmlFor="reporter">お名前（任意）</label>
              <input
                id="reporter"
                value={reporter}
                onChange={(e) => setReporter(e.target.value)}
                placeholder="例：高木"
                maxLength={40}
              />
            </div>
          )}
          <div className="send-actions">
            <button className="primary" onClick={submit} disabled={status === "submitting"}>
              {status === "submitting" ? "送信中…" : "この内容で送る"}
            </button>
            <button
              className="ghost"
              onClick={() => {
                setPhase("clarify");
                setTicket(null);
                // 無言の入力欄に取り残さない：どこを直すか尋ねる一言を足して会話を続ける。
                setMessages((m) => [
                  ...m,
                  {
                    role: "assistant",
                    content:
                      "どこを直しましょう？ 違う点や、足したいことを教えてください。",
                  },
                ]);
              }}
              disabled={status === "submitting"}
            >
              修正する
            </button>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}

      {status !== "done" && (
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={embed ? "メッセージを入力" : "メッセージを入力（Enterで送信 / Shift+Enterで改行）"}
            rows={1}
            disabled={busy || status === "submitting"}
          />
          <button
            className="send"
            onClick={send}
            disabled={busy || !input.trim()}
            aria-label="送信"
            title="送信"
          >
            ↑
          </button>
        </div>
      )}

      {!embed && (
        <div className="footer">
          カイゼンくん 第1段・カイゼン窓口 ／ 入力内容はNotionの改善チケットに記録されます
          <br />
          <small>このシステムは現場の声で日々改善されています</small>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="app" />}>
      <KaizenMado />
    </Suspense>
  );
}
