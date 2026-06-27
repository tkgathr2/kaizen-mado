"use client";

import { Suspense, useEffect, useRef, useState } from "react";
// 二重送信ガード：React state は非同期更新のため、連打で状態更新前に再発火し得る。
// ref は同期更新なので「実行中」を確実にブロックでき、重複起票/重複送信を防ぐ。
import { useSearchParams } from "next/navigation";
// optional auth：このサイトで Google ログイン済みなら起票者名を自動で引き継ぐ（任意・強制しない）。
import { useSession, signIn } from "next-auth/react";
import { resolveSystem } from "@/lib/systems";
import { isEmbed } from "@/lib/embed";
import { resolveReporter } from "@/lib/reporter";
import {
  ALLOWED_MIMES,
  MAX_ATTACHMENTS,
  MAX_BYTES_PER_IMAGE,
  MAX_TOTAL_BYTES,
} from "@/lib/attachments";
import type { Attachment, ChatMessage, Ticket } from "@/lib/types";

// File を data URL（base64）へ読み込む。
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

// 優先度バッジの CSS クラス接尾辞（高=赤/中=橙/低=灰。色は globals.css）。
function prioClass(priority: "高" | "中" | "低"): string {
  return priority === "高" ? "high" : priority === "中" ? "mid" : "low";
}

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

  // このサイト自体での Google ログイン状態（optional auth）。
  // 鍵未投入・未ログインでも安全に動く（status は "unauthenticated"、session は null）。
  const { data: session, status: authStatus } = useSession();
  const sessionName = (session?.user?.name ?? "").trim();
  const isAuthed = authStatus === "authenticated" && !!sessionName;
  // 「Googleでログイン（任意）」ボタンを出すかどうか。
  // OAuth鍵が本番に入った時だけ NEXT_PUBLIC_AUTH_ENABLED=1 を立てる運用。
  // 未設定（＝現状・鍵未投入）ではボタンを出さず、従来どおり手入力だけで送れる（fail-safe）。
  const authUiEnabled = process.env.NEXT_PUBLIC_AUTH_ENABLED === "1";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"clarify" | "confirm">("clarify");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  // reporter state は「お名前（任意）」手入力欄の値のみを持つ。
  // 最終的な起票者名は resolveReporter(reporterParam > sessionName > 手入力) で決める。
  const [reporter, setReporter] = useState("");
  const [status, setStatus] = useState<"chatting" | "submitting" | "done">("chatting");
  const [doneId, setDoneId] = useState<string>("");
  const [error, setError] = useState("");
  // 簡易モード（AI未応答でフォールバック）で返したアシスタント発話の index 集合。
  // そのターンだけ「※ いまは簡易モードで受付中です」と薄く注記する。
  const [fallbackIdx, setFallbackIdx] = useState<Set<number>>(() => new Set());
  // 添付画像（送信前の下書き）。送信時に user メッセージへ移し、入力欄はクリアする。
  const [pending, setPending] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  // ドラッグ&ドロップ中の視覚フィードバック（全画面のみ）。
  const [dragging, setDragging] = useState(false);
  // 拡大表示（lightbox）中の画像 dataUrl（null で閉じる）。
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0); // dragenter/leave のネスト相殺カウンタ
  const inFlightRef = useRef(false); // send/submit 実行中フラグ（同期・二重発火防止）

  // 添付候補を取り込む（型・サイズ・枚数を弾く）。複数ファイル可。
  async function addFiles(files: FileList | File[]) {
    setAttachError("");
    const list = Array.from(files);
    const accepted: Attachment[] = [];
    let total = pending.reduce((s, a) => s + a.bytes, 0);
    let slots = MAX_ATTACHMENTS - pending.length;
    for (const f of list) {
      if (slots <= 0) {
        setAttachError(`画像は最大${MAX_ATTACHMENTS}枚までです`);
        break;
      }
      if (!(ALLOWED_MIMES as readonly string[]).includes(f.type)) {
        setAttachError("対応していない画像形式です（png / jpeg / gif / webp）");
        continue;
      }
      if (f.size > MAX_BYTES_PER_IMAGE) {
        setAttachError(`1枚あたり${Math.floor(MAX_BYTES_PER_IMAGE / (1024 * 1024))}MBまでです`);
        continue;
      }
      if (total + f.size > MAX_TOTAL_BYTES) {
        setAttachError(`合計${Math.floor(MAX_TOTAL_BYTES / (1024 * 1024))}MBまでです`);
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(f);
        accepted.push({
          dataUrl,
          mime: f.type as Attachment["mime"],
          bytes: f.size,
          name: f.name,
        });
        total += f.size;
        slots--;
      } catch {
        setAttachError("画像の読み込みに失敗しました");
      }
    }
    if (accepted.length > 0) setPending((p) => [...p, ...accepted]);
  }

  function removePending(idx: number) {
    setPending((p) => p.filter((_, i) => i !== idx));
    setAttachError("");
  }

  function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  // ドラッグ&ドロップ（embed 内では iframe 跨ぎ不可なので全画面時のみ受け付ける）。
  function onDrop(e: React.DragEvent) {
    if (embed) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void addFiles(files);
  }
  function onDragEnter(e: React.DragEvent) {
    if (embed) return;
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (embed) return;
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
  }
  function onDragLeave(e: React.DragEvent) {
    if (embed) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

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
    // 画像だけ（テキスト空）でも送れるようにする。
    if ((!text && pending.length === 0) || busy || status !== "chatting" || inFlightRef.current)
      return;
    inFlightRef.current = true;
    setError("");
    setInput("");
    const attachments = pending;
    setPending([]);
    setAttachError("");
    const userMsg: ChatMessage = { role: "user", content: text };
    if (attachments.length > 0) userMsg.attachments = attachments;
    const next: ChatMessage[] = [...messages, userMsg];
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
      // 起票者名：reporterParam（widget）> session.user.name（このサイトでログイン）> 手入力。
      // 認証ON時はサーバ側(/api/submit)もセッションから本人を確定するが、未ログイン手入力時のために送る。
      const effectiveReporter = resolveReporter({
        reporterParam,
        sessionName,
        manualInput: reporter,
      });
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, reporter: effectiveReporter || null }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "起票に失敗しました");
      // 受付番号は取れたときだけ使う（取れなければ "KZ-受付" のようなダミーは出さない）。
      const id = typeof data.ticketId === "string" ? data.ticketId.trim() : "";
      setDoneId(id);
      setStatus("done");
      // 完了の合図はチャット内の1行に集約（別カードでは番号を二重に出さない）。
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: id ? `送りました（${id}）。ありがとうございました！` : "送りました。ありがとうございました！",
        },
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
    <div
      className={embed ? "app embed" : "app"}
      onDrop={onDrop}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dragging && !embed && (
        <div className="drop-overlay">画像をここにドロップして添付</div>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="画像拡大表示">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="添付画像（拡大）" onClick={(e) => e.stopPropagation()} />
          <button type="button" className="lightbox-close" onClick={() => setLightbox(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}
      {!embed && (
        <header className="header">
          <div className="logo-wrap">
            <img src="/kaizen-kun.png" alt="フクロウ博士" className="logo" />
            <span className="logo-name">フクロウ博士</span>
          </div>
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
            {m.attachments && m.attachments.length > 0 && (
              <div className="msg-images">
                {m.attachments.map((a, j) => (
                  <button
                    key={j}
                    type="button"
                    className="msg-image"
                    onClick={() => setLightbox(a.dataUrl)}
                    title="クリックで拡大"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.dataUrl} alt={a.name || "添付画像"} />
                  </button>
                ))}
              </div>
            )}
            {m.content && <div className="bubble">{m.content}</div>}
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
              <dt>緊急度</dt>
              <dd>{typeof ticket.urgency === "number" ? `${ticket.urgency}/10` : "—"}</dd>
              <dt>重要度</dt>
              <dd>
                {typeof ticket.importanceScore === "number"
                  ? `${ticket.importanceScore}/10`
                  : "—"}
              </dd>
              <dt>優先度</dt>
              <dd>
                {ticket.priority ? (
                  <span className={`prio-badge prio-${prioClass(ticket.priority)}`}>
                    {ticket.priority}
                  </span>
                ) : (
                  "—"
                )}
              </dd>
              <dt>件名</dt>
              <dd>{ticket.title}</dd>
              <dt>内容</dt>
              <dd>{ticket.detail}</dd>
              {ticket.priorityReason && (
                <>
                  <dt>根拠</dt>
                  <dd>{ticket.priorityReason}</dd>
                </>
              )}
            </dl>
          </div>
        )}

        {status === "done" && (
          <div className="done">
            送信が完了しました 🎉
            {doneId && (
              <>
                <br />
                受付番号 <span className="kz">{doneId}</span>
                <br />
                <small className="kz-keep">控えなくても大丈夫です</small>
              </>
            )}
            <br />
            <small>CTO室で内容を確認し、改善を検討します。ありがとうございました。</small>
          </div>
        )}
      </div>

      {showConfirm && (
        <>
          {/* 起票者の出し分け（optional auth）：
              ① widget（reporterParam）… 埋め込み元の本人。入力欄は出さない（従来どおり）。
              ② このサイトでログイン済み … 名前を自動引き継ぎ。「○○さんとして送信」と表示。
              ③ 未ログイン … 手入力欄＋「Googleでログインして名前を引き継ぐ（任意）」ボタン。 */}
          {!reporterParam && isAuthed && (
            <div className="reporter">
              <span>
                <strong>{sessionName}</strong> さんとして送信します
              </span>
            </div>
          )}
          {!reporterParam && !isAuthed && (
            <div className="reporter">
              <label htmlFor="reporter">お名前（任意）</label>
              <input
                id="reporter"
                value={reporter}
                onChange={(e) => setReporter(e.target.value)}
                placeholder="例：高木"
                maxLength={40}
              />
              {authUiEnabled && (
                <button
                  type="button"
                  className="ghost reporter-login"
                  onClick={() => signIn("google")}
                  title="Googleでログインすると、お名前を自動で引き継ぎます"
                >
                  Googleでログイン（任意）
                </button>
              )}
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
        <div className="composer-wrap">
          {pending.length > 0 && (
            <div className="attach-previews">
              {pending.map((a, i) => (
                <div className="attach-thumb" key={i}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.dataUrl} alt={a.name || "添付画像"} />
                  <button
                    type="button"
                    className="attach-remove"
                    onClick={() => removePending(i)}
                    aria-label="この画像を削除"
                    title="削除"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachError && <div className="attach-error">{attachError}</div>}
          <div className="composer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = ""; // 同じファイルの連続選択を許可
              }}
            />
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || status === "submitting" || pending.length >= MAX_ATTACHMENTS}
              aria-label="画像を添付"
              title="画像を添付"
            >
              ＋
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={embed ? "メッセージを入力" : "メッセージを入力（Enterで送信 / Shift+Enterで改行）"}
              rows={1}
              disabled={busy || status === "submitting"}
            />
            <button
              className="send"
              onClick={send}
              disabled={busy || (!input.trim() && pending.length === 0)}
              aria-label="送信"
              title="送信"
            >
              ↑
            </button>
          </div>
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
