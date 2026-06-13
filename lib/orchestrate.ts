// ── 実行オーケストレーター：GO済みチケットを「対象システムの実改修」へ流す ──
// serverless(Vercel)上では自分でコードを書けないため、GitHub の repository_dispatch で
// kaizen-mado リポの実行ワークフロー(.github/workflows/kaizen-execute.yml)を起動する。
// ワークフロー側が Claude で対象リポを改修→PR→3条件ゲート→自動マージ→デプロイ→ヘルス→callback。
// トークン未設定なら dispatch しない（fail-safe）。対人送信・課金は含めない。
import type { TicketRow } from "./tickets";
import type { TargetMeta } from "./targets";

// repository_dispatch を撃つ先（このリポ自身が中央オーケストレーター）。
const ORCHESTRATOR_REPO = process.env.KAIZEN_ORCHESTRATOR_REPO || "tkgathr2/kaizen-mado";
const DISPATCH_EVENT = "kaizen_execute";

/** GitHub Actions に渡す実装指示（spec）を組み立てる。 */
export function buildSpec(ticket: TicketRow): string {
  return [
    `# カイゼン実装指示（${ticket.ticketId}）`,
    ``,
    `対象システム: ${ticket.system}`,
    `種別: ${ticket.type} / 重要度: ${ticket.importance}`,
    `件名: ${ticket.title}`,
    ``,
    `## 要望（現場の声）`,
    ticket.detail || "(詳細なし)",
    ``,
    `## 守ること`,
    `- 最小差分で対応する（無関係な変更を混ぜない）。`,
    `- 既存のテスト・lint・型を壊さない。可能ならテストを追加する。`,
    `- 秘密情報/認証/課金/個人情報/マイグレーションには触れない（触れる必要があれば中止し理由を残す）。`,
    `- 変更は1つのPRにまとめ、説明にこのチケットID(${ticket.ticketId})を含める。`,
  ].join("\n");
}

/** dispatch可能か（トークンがあるか）。 */
export function dispatchEnabled(): boolean {
  return Boolean(process.env.GITHUB_DISPATCH_TOKEN);
}

export interface DispatchPayload {
  ticketId: string;
  pageId: string;
  system: string;
  targetRepo: string;
  importance: string;
  forbiddenPaths: string[];
  healthUrl: string | null;
  spec: string;
  callbackUrl: string;
}

/** 実行ワークフローに渡す client_payload を組み立てる（dispatch経路・plan経路で共用）。 */
export function buildDispatchPayload(ticket: TicketRow, target: TargetMeta): DispatchPayload {
  const callbackBase = process.env.KAIZEN_PUBLIC_BASE || "https://kaizen.takagi.bz";
  return {
    ticketId: ticket.ticketId,
    pageId: ticket.pageId,
    system: ticket.system,
    targetRepo: target.repo as string,
    importance: ticket.importance,
    forbiddenPaths: target.forbiddenPaths,
    healthUrl: target.healthUrl,
    spec: buildSpec(ticket),
    callbackUrl: `${callbackBase}/api/execute/callback`,
  };
}

export interface DispatchInput {
  ticket: TicketRow;
  target: TargetMeta;
}

/**
 * 実行ワークフローを起動する。成功で true。
 * トークン未設定・失敗時は false（throwしない＝呼び出し元のループを止めない）。
 */
export async function dispatchExecution({ ticket, target }: DispatchInput): Promise<boolean> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return false;
  if (!target.repo) return false;

  const payload = {
    event_type: DISPATCH_EVENT,
    client_payload: buildDispatchPayload(ticket, target),
  };

  try {
    const res = await fetch(`https://api.github.com/repos/${ORCHESTRATOR_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    // 成功は 204 No Content
    if (res.status === 204) return true;
    const detail = await res.text().catch(() => "");
    console.error("[orchestrate] dispatch失敗", { status: res.status, detail: detail.slice(0, 200) });
    return false;
  } catch (e) {
    console.error("[orchestrate] dispatch例外", { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
