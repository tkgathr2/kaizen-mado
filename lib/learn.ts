// ── ⑧ 完了/差し戻し/却下チケット → 学び還元（全体学習の土台へ） ──
// 完了（成功）だけでなく、差し戻し・却下（失敗）も「学び」として同じ記憶に貯める
// ＝しくじり先生（同じ種の要望でこう失敗した→次は注意）の発想。
// 全部 lib/memory.ts（統一メモリ層）経由＝開発の学びも会話の学びも横断で効く。
//
// 段階リリースのため既定OFF（KNOWHOW_ENABLED !== "true" なら no-op）。
// knowhow送信は認証ゼロで全公開 → memory層が必ず PIIマスクしてから送る。
// memorize成功した行のみ FGSリンクに冪等マークを付け、次回 is_empty から外す。
import { distillTicket, isDistillEnabled } from "./distill";
import { recordLearning, type LearningKind } from "./memory";
import {
  fetchCompletedUnlearned,
  fetchTicketsByState,
  setTicketUrlField,
  type TicketRow,
} from "./tickets";

const MEMORIZED_MARK = "knowhow://memorized";

/** 失敗（差し戻し・却下）から学ぶ対象の状態。完了は別経路（成功の学び）。 */
const FAILED_STATES = ["差し戻し", "却下"] as const;

/**
 * 完了チケットを「成功の学び」として全体学習に記録する。成功したら true。
 * Phase 2（KAIZEN_DISTILL_ENABLED=true）：Claude(haiku)で「事象→原因→対処→学び」へ
 * 蒸留し、その本文を詳細として記録する（PIIは memory層で再マスク）。
 * 蒸留失敗・OFF時は「要望→やったこと→結果」の固定要約にフォールバック。
 */
async function memorizeCompleted(ticket: TicketRow): Promise<boolean> {
  const distilled = isDistillEnabled() ? await distillTicket(ticket) : null;

  // 完了チケットから「要望→やったこと→結果」を要約して記録する。
  const summary = `${ticket.system}：「${ticket.title}」の改善が完了`;
  const detail = distilled
    ? distilled.rawLog
    : [
        `要望: ${ticket.title}`,
        `内容: ${ticket.detail}`,
        `結果: 現場の声を起点に改善を完了。再発防止・横展開の観点で活用する。`,
      ].join("\n");

  return recordLearning({
    kind: "fix_success",
    system: ticket.system,
    summary,
    detail,
    tags: [ticket.type, ...(distilled?.keywords ?? [])],
  });
}

/**
 * 差し戻し/却下チケットを「失敗の学び」として全体学習に記録する。成功したら true。
 * 「この種の要望はこう失敗した＝次は注意」を残す（しくじり先生）。
 * state によって kind を分ける：差し戻し→fix_failed（やり直し）／却下→correction（軌道修正）。
 */
async function memorizeFailed(ticket: TicketRow): Promise<boolean> {
  const kind: LearningKind = ticket.state === "却下" ? "correction" : "fix_failed";
  const outcome =
    ticket.state === "却下"
      ? "社長判断で却下（今回は見送り）。同種の要望は提案前に要否・前提を見直す。"
      : "社長から差し戻し（要修正）。同種の要望は次回この観点を先に詰める。";

  const summary = `${ticket.system}：「${ticket.title}」が${ticket.state}`;
  const detail = [
    `要望: ${ticket.title}`,
    `内容: ${ticket.detail}`,
    `結果: ${outcome}`,
  ].join("\n");

  return recordLearning({
    kind,
    system: ticket.system,
    summary,
    detail,
    tags: [ticket.type, ticket.state],
  });
}

/**
 * 完了済み未学習チケットを「成功の学び」として全体学習に還元する。
 * 既定OFF（KNOWHOW_ENABLED !== "true"）なら {memorized:0, skipped:"disabled"}。
 */
export async function returnLearningFromCompleted(
  limit = 10
): Promise<{ memorized: number; skipped?: string }> {
  if (process.env.KNOWHOW_ENABLED !== "true") {
    return { memorized: 0, skipped: "disabled" };
  }

  const rows = await fetchCompletedUnlearned(limit);
  let memorized = 0;

  for (const row of rows) {
    const ok = await memorizeCompleted(row);
    if (!ok) continue; // 失敗は握りつぶし＝マークしない→次回再試行
    try {
      await setTicketUrlField(row.pageId, MEMORIZED_MARK);
      memorized += 1;
    } catch (err) {
      // マーク失敗は次回再送（二重送信は許容＝重複より取りこぼし回避を優先）
      console.error("[learn] mark failed:", (err as Error).message);
    }
  }

  return { memorized };
}

/**
 * 差し戻し/却下チケットを「失敗の学び」として全体学習に還元する。
 * ＝しくじり先生：同じ種類の要望で二度同じ失敗をしないための土台。
 * 完了還元と同じく FGSリンクの冪等マークで未学習だけを拾う（二重記録防止）。
 * 既定OFF（KNOWHOW_ENABLED !== "true"）なら {memorized:0, skipped:"disabled"}。
 */
export async function returnLearningFromFailed(
  limit = 10
): Promise<{ memorized: number; skipped?: string }> {
  if (process.env.KNOWHOW_ENABLED !== "true") {
    return { memorized: 0, skipped: "disabled" };
  }

  let memorized = 0;
  for (const state of FAILED_STATES) {
    const rows = await fetchTicketsByState(state, limit);
    for (const row of rows) {
      // 未学習（FGSリンク空）のものだけ＝二重記録を防ぐ。
      if (row.fgsUrl) continue;
      const ok = await memorizeFailed(row);
      if (!ok) continue; // 失敗は握りつぶし＝マークしない→次回再試行
      try {
        await setTicketUrlField(row.pageId, MEMORIZED_MARK);
        memorized += 1;
      } catch (err) {
        console.error("[learn] mark failed:", (err as Error).message);
      }
    }
  }

  return { memorized };
}
