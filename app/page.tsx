"use client";

import { Suspense, useEffect, useRef, useState } from "react";
// 二重送信ガード：React state は非同期更新のため、連打で状態更新前に再発火し得る。
// ref は同期更新なので「実行中」を確実にブロックでき、重複起票/重複送信を防ぐ。
import { useSearchParams } from "next/navigation";
// optional auth：このサイトで Google ログイン済みなら起票者名を自動で引き継ぐ（任意・強制しない）。
import { useSession, signIn } from "next-auth/react";
import { resolveSystem } from "@/lib/systems";
import { lowerPriority } from "@/lib/priority";
import { isEmbed } from "@/lib/embed";
import { isEmbeddedContext, shouldShowLoginGate } from "@/lib/loginGate";
import { resolveReporter } from "@/lib/reporter";
import MarkdownMessage from "@/lib/MarkdownMessage";
import { SUGGESTION_TEMPLATES } from "@/lib/templates";
import {
  ATTACH_ACCEPT,
  UX_MAX_ATTACHMENTS,
  attachErrorMessage,
  checkAttachOne,
  fileIcon,
} from "./attachUx";
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

// SSE の1イベント（"event: x\ndata: {...}"）をパースする。data が JSON でなければ null。
function parseSseEvent(raw: string): { event: string; data: any } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
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

  // ── ログインゲート（直接アクセス時のみ）の SSR/ハイドレーション安全判定 ──
  // iframe 内かどうか（window.self !== window.top）はサーバ側では判定不能。
  // マウント前にゲートを描画するとサーバ描画と食い違い hydration mismatch になるため、
  // mounted（クライアントで useEffect 後に true）になるまではゲートを出さない。
  const [mounted, setMounted] = useState(false);
  const [inIframe, setInIframe] = useState(false);
  useEffect(() => {
    setMounted(true);
    try {
      setInIframe(window.self !== window.top);
    } catch {
      // クロスオリジンで window.top にアクセスすると例外＝iframe 内とみなす。
      setInIframe(true);
    }
  }, []);
  // 埋め込み文脈（iframe 内 / ?embed=1 / widget が reporter を渡している）ではゲートを絶対に出さない。
  const embeddedForGate = isEmbeddedContext({ inIframe, embedFlag: embed, reporterParam });
  // ゲートを描画すべきか：認証ON・非埋め込み・未ログインのときだけ。
  // mounted 前は iframe 判定が未確定なので出さない（チラつき・hydration mismatch 防止）。
  const showLoginGate =
    mounted &&
    shouldShowLoginGate({ authUiEnabled, embedded: embeddedForGate, authStatus });
  // 認証ON・非埋め込みで status が読み込み中の間はチャットもゲートも出さずローディング。
  const showAuthLoading =
    mounted && authUiEnabled && !embeddedForGate && authStatus === "loading";

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
  // ストリーミング中の途中テキスト（assistant 行に逐次反映）。null＝非ストリーミング。
  const [streaming, setStreaming] = useState<string | null>(null);
  // コピー完了の一時表示（メッセージ index → true）。
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null); // スマホ撮影用（capture）
  const dragDepth = useRef(0); // dragenter/leave のネスト相殺カウンタ
  const inFlightRef = useRef(false); // send/submit 実行中フラグ（同期・二重発火防止）

  // 添付が画像かどうか（kind 省略の旧データは mime から推定）。
  function isImageAttachment(a: Attachment): boolean {
    if (a.kind === "image") return true;
    if (a.kind === "file") return false;
    return typeof a.mime === "string" && a.mime.startsWith("image/");
  }

  // 添付候補を取り込む（型・サイズ・点数を弾く）。画像＋ファイル混在可・複数可。
  // 検証は純粋ヘルパ checkAttachOne（テスト済み）に委譲。サーバ側 lib/attachments.ts が最終防衛。
  async function addFiles(files: FileList | File[]) {
    setAttachError("");
    const list = Array.from(files);
    const accepted: Attachment[] = [];
    let total = pending.reduce((s, a) => s + a.bytes, 0);
    let count = pending.length;
    for (const f of list) {
      const res = checkAttachOne({ type: f.type, name: f.name, size: f.size }, count, total);
      if (!res.ok) {
        setAttachError(attachErrorMessage(res.error!));
        if (res.error === "slots") break; // これ以上は入らない
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(f);
        accepted.push({
          kind: res.kind,
          dataUrl,
          mime: res.mime as Attachment["mime"],
          bytes: f.size,
          name: f.name,
        });
        total += f.size;
        count++;
      } catch {
        setAttachError("ファイルの読み込みに失敗しました");
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

  // 1ターン送信の中核。
  //  - override 指定時（再生成・編集）は input/pending を使わず、与えられた本文で送る。
  //  - 履歴は呼び出し側が組み立て済み（baseMessages）を渡す（末尾は user ターン）。
  // 送信は常に stream:true + Accept:text/event-stream で投げ、レスポンスの Content-Type で分岐：
  //   text/event-stream → delta を逐次描画（KAIZEN_STREAM_ENABLED 有効時）。
  //   application/json  → 従来どおり一括表示（フラグOFF時に自然フォールバック）。
  async function runTurn(baseMessages: ChatMessage[]) {
    setBusy(true);
    setStreaming(null);
    let res: Response;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ system: sysRaw, messages: baseMessages, stream: true }),
      });
    } catch {
      appendAssistantError();
      setBusy(false);
      inFlightRef.current = false;
      return;
    }

    const ctype = res.headers.get("content-type") || "";
    try {
      if (res.ok && ctype.includes("text/event-stream") && res.body) {
        await consumeStream(res);
      } else {
        // 非ストリーム（フラグOFF / 429 / エラー）：従来の一括 JSON。
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "通信に失敗しました");
        applyResult(data);
      }
    } catch {
      appendAssistantError();
    } finally {
      setStreaming(null);
      setBusy(false);
      inFlightRef.current = false;
    }
  }

  // SSE（delta/done/error）を読み取り、reply を逐次描画して最後に確定する。
  async function consumeStream(res: Response) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = ""; // ここまでの reply
    let doneData: any = null;
    setStreaming("");
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE は "\n\n" 区切りのイベント。完結したものから処理する。
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const evt = parseSseEvent(raw);
        if (!evt) continue;
        if (evt.event === "delta" && typeof evt.data?.text === "string") {
          acc += evt.data.text;
          setStreaming(acc);
        } else if (evt.event === "done") {
          doneData = evt.data;
        } else if (evt.event === "error") {
          throw new Error(evt.data?.message || "stream error");
        }
      }
    }
    // done が来ていれば確定結果を適用、無ければ acc を最終 reply として確定。
    if (doneData) {
      applyResult({ ...doneData, reply: doneData.reply ?? acc });
    } else {
      applyResult({ reply: acc, phase: "clarify", ticket: null });
    }
  }

  // 確定結果（done もしくは一括 JSON）を会話へ反映する。
  function applyResult(data: any) {
    setMessages((m) => {
      if (data?.fallback) {
        const idx = m.length;
        setFallbackIdx((s) => new Set(s).add(idx));
      }
      return [...m, { role: "assistant", content: String(data?.reply ?? "") }];
    });
    setPhase(data?.phase === "confirm" ? "confirm" : "clarify");
    setTicket(data?.phase === "confirm" ? (data.ticket as Ticket) : null);
  }

  function appendAssistantError() {
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        content:
          "すみません、うまく受け取れませんでした。もう一度だけ、要点を教えていただけますか？",
      },
    ]);
  }

  async function send() {
    const text = input.trim();
    // 画像/ファイルだけ（テキスト空）でも送れるようにする。
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
    await runTurn(next);
  }

  // 🔄 再生成：最後の assistant 発話を捨て、直前の user ターンで再送する。
  async function regenerate() {
    if (busy || status !== "chatting" || inFlightRef.current) return;
    // 末尾が assistant のときだけ（その1つを差し替える）。直前に user が必要。
    const lastUser = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return i;
      }
      return -1;
    })();
    if (lastUser < 0) return;
    inFlightRef.current = true;
    setError("");
    // user ターンまでを履歴として残し、その後の assistant を落として再送。
    const base = messages.slice(0, lastUser + 1);
    setMessages(base);
    setPhase("clarify");
    setTicket(null);
    await runTurn(base);
  }

  // ✏️ 直前の自分の送信を編集して送り直す：入力欄に戻し、その user ターン以降を会話から外す。
  function editLastUser() {
    if (busy || status !== "chatting") return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const target = messages[idx];
    setInput(target.content);
    // 添付があれば下書きへ戻す。
    if (target.attachments && target.attachments.length > 0) {
      setPending(target.attachments);
    }
    setMessages(messages.slice(0, idx));
    setPhase("clarify");
    setTicket(null);
    setError("");
  }

  // 📋 コピー：AI返答の本文（生 markdown）をクリップボードへ。
  async function copyMessage(idx: number, content: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        // フォールバック（古い環境）。
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      /* コピー失敗は黙って無視（致命的でない） */
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

  // 認証ON・非埋め込みで status 確定待ちの間はチラつき防止のため空＋スピナーだけ。
  if (showAuthLoading) {
    return (
      <div className={embed ? "app embed" : "app"}>
        <div className="auth-loading" aria-live="polite">
          <span className="auth-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  // 直接アクセス（非埋め込み）かつ認証ON・未ログイン：チャットの前にログイン画面を出す。
  // 埋め込み（iframe）では絶対にここへ来ない（embeddedForGate で弾く）。
  if (showLoginGate) {
    return (
      <div className="app login-gate">
        <div className="login-card">
          <img src="/kaizen-kun.png" alt="フクロウ博士" className="login-logo" />
          <h1 className="login-title">カイゼン窓口</h1>
          <p className="login-lead">続けるにはGoogleでログインしてください</p>
          <button type="button" className="primary login-btn" onClick={() => signIn("google")}>
            Googleでログイン
          </button>
          <p className="login-note">
            ログインすると、お名前が自動で入ります（毎回入力しなくて大丈夫です）
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={embed ? "app embed" : "app"}
      onDrop={onDrop}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dragging && !embed && (
        <div className="drop-overlay">ここにドロップして添付（画像・PDF・ファイル）</div>
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
        {messages.map((m, i) => {
          const isLastAssistant =
            m.role === "assistant" && i === messages.length - 1 && status !== "done";
          return (
            <div key={i} className={`row ${m.role}`}>
              {m.attachments && m.attachments.length > 0 && (
                <>
                  {/* 画像はサムネプレビュー（拡大可）。 */}
                  {m.attachments.some(isImageAttachment) && (
                    <div className="msg-images">
                      {m.attachments.filter(isImageAttachment).map((a, j) => (
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
                  {/* 非画像は 📄＋ファイル名チップ。 */}
                  {m.attachments.some((a) => !isImageAttachment(a)) && (
                    <div className="msg-files">
                      {m.attachments
                        .filter((a) => !isImageAttachment(a))
                        .map((a, j) => (
                          <span className="msg-file-chip" key={j} title={a.name || "添付ファイル"}>
                            <span className="msg-file-icon" aria-hidden="true">
                              {fileIcon(String(a.mime))}
                            </span>
                            <span className="msg-file-name">{a.name || "添付ファイル"}</span>
                          </span>
                        ))}
                    </div>
                  )}
                </>
              )}
              {m.content &&
                (m.role === "assistant" ? (
                  <div className="bubble">
                    <MarkdownMessage content={m.content} />
                  </div>
                ) : (
                  <div className="bubble">{m.content}</div>
                ))}
              {m.role === "assistant" && fallbackIdx.has(i) && (
                <div className="fallback-note">※ いまは簡易モードで受付中です</div>
              )}
              {/* AI返答のアクション（コピー／最後の返答は再生成）。busy 中は出さない。 */}
              {m.role === "assistant" && m.content && !busy && (
                <div className="msg-actions">
                  <button
                    type="button"
                    className="msg-action"
                    onClick={() => copyMessage(i, m.content)}
                    title="コピー"
                    aria-label="この返答をコピー"
                  >
                    {copiedIdx === i ? "✓ コピーしました" : "📋 コピー"}
                  </button>
                  {isLastAssistant && (
                    <button
                      type="button"
                      className="msg-action"
                      onClick={regenerate}
                      title="もう一度回答してもらう"
                      aria-label="再生成"
                    >
                      🔄 再生成
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ストリーミング中の途中テキスト（確定前）。 */}
        {streaming !== null && streaming.length > 0 && (
          <div className="row assistant">
            <div className="bubble">
              <MarkdownMessage content={streaming} />
            </div>
          </div>
        )}

        {/* 考え中インジケータ（送信後は常に表示・待ち不安の解消）。 */}
        {busy && (streaming === null || streaming.length === 0) && (
          <div className="typing thinking" aria-live="polite">
            <span>考え中</span>
            <span className="dots">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
          </div>
        )}

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
              {/* 埋め込み(iframe)では Google ログインを出さない。
                  理由：①widget は別サイトに iframe 埋め込みされ、kaizen の Cookie が
                  サードパーティ扱いで遮断/分割される→ iframe 内 signIn は MissingCSRF で
                  「Unable to sign in.」のNextAuth画面に落ちる。②Google は OAuth 画面の
                  iframe 表示自体を拒否する。よって埋め込みでは原理的にログイン不可。
                  埋め込みでは手入力（お名前・任意）だけで送れる設計に倒す。 */}
              {authUiEnabled && !embed && (
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
            {/* 優先度を1段下げる（高→中→低・§4.14）。本人算出が既定で、利用者が手で微調整できる。
                既に「低」のときや優先度が無いとき（旧チケット相当）は出さない。 */}
            {ticket.priority && ticket.priority !== "低" && (
              <button
                className="ghost"
                onClick={() =>
                  setTicket((t) =>
                    t && t.priority ? { ...t, priority: lowerPriority(t.priority) } : t
                  )
                }
                disabled={status === "submitting"}
                title="優先度を1段下げます（高→中→低）"
              >
                優先度を下げる
              </button>
            )}
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
          {/* テンプレ例文：入力が空＆会話が浅い（挨拶のみ＝user発言なし）ときだけチップ表示。
              タップで入力欄へ挿入（自動送信しない＝編集できる）。 */}
          {!input.trim() &&
            pending.length === 0 &&
            !busy &&
            status === "chatting" &&
            !messages.some((m) => m.role === "user") && (
              <div className="templates" aria-label="よくあるご相談">
                {SUGGESTION_TEMPLATES.map((t, i) => (
                  <button
                    type="button"
                    className="template-chip"
                    key={i}
                    onClick={() => setInput(t.text)}
                    title={t.text}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          {pending.length > 0 && (
            <div className="attach-previews">
              {pending.map((a, i) =>
                isImageAttachment(a) ? (
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
                ) : (
                  <div className="attach-file" key={i} title={a.name || "添付ファイル"}>
                    <span className="attach-file-icon" aria-hidden="true">
                      {fileIcon(String(a.mime))}
                    </span>
                    <span className="attach-file-name">{a.name || "添付ファイル"}</span>
                    <button
                      type="button"
                      className="attach-file-remove"
                      onClick={() => removePending(i)}
                      aria-label="このファイルを削除"
                      title="削除"
                    >
                      ×
                    </button>
                  </div>
                )
              )}
            </div>
          )}
          {attachError && <div className="attach-error">{attachError}</div>}
          <div className="composer">
            <input
              ref={fileInputRef}
              type="file"
              accept={ATTACH_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = ""; // 同じファイルの連続選択を許可
              }}
            />
            {/* スマホ撮影：capture でカメラを直接起動。 */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || status === "submitting" || pending.length >= UX_MAX_ATTACHMENTS}
              aria-label="画像・ファイルを添付"
              title="画像・ファイルを添付（PDF / CSV / Excel / Word など）"
            >
              ＋
            </button>
            <button
              type="button"
              className="attach-btn camera-btn"
              onClick={() => cameraInputRef.current?.click()}
              disabled={busy || status === "submitting" || pending.length >= UX_MAX_ATTACHMENTS}
              aria-label="カメラで撮影して添付"
              title="カメラで撮影して添付"
            >
              📷
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
            {/* ✏️ 直前の自分の送信を編集して送り直す（直前が user のときだけ意味がある）。 */}
            {!busy &&
              status === "chatting" &&
              !input.trim() &&
              pending.length === 0 &&
              messages.some((m) => m.role === "user") && (
                <button
                  type="button"
                  className="attach-btn edit-btn"
                  onClick={editLastUser}
                  aria-label="直前の送信を編集"
                  title="直前の自分の送信を編集して送り直す"
                >
                  ✏️
                </button>
              )}
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
