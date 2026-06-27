// ── 優先度スコアリング（仕様書 §4.5.1 の唯一の正本） ──
// 緊急度(urgency)×重要度(importanceScore)を各1〜10で受け、優先度（高/中/低）を導く純粋ロジック。
// SlackとWEBで同じ基準を共有するため、ここを single source of truth にする。
// 副作用なし・テスト可能。AI生成（lib/anthropic.ts）の数値は coerceTurn でこの clamp を通す。
import type { Priority } from "./types";

/** 1〜10 にクランプ（整数化）。数値でなければ null（＝未算出）を返す。
 * null/undefined/空文字は Number() が 0 になってしまうため、明示的に弾く。 */
export function clampScore(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/**
 * 緊急度・重要度（各1〜10）から優先度を算出する（合計20点満点）。
 * - 高：緊急度≥8 または 重要度≥8 で、かつ 合計≥14
 * - 中：合計 8〜13
 * - 低：合計 ≤7
 */
export function computePriority(urgency: number, importanceScore: number): Priority {
  const u = Math.min(10, Math.max(1, Math.round(urgency)));
  const i = Math.min(10, Math.max(1, Math.round(importanceScore)));
  const sum = u + i;
  if ((u >= 8 || i >= 8) && sum >= 14) return "高";
  if (sum >= 8) return "中";
  return "低";
}

/** 値が優先度（高/中/低）として妥当か。 */
export function isPriority(v: unknown): v is Priority {
  return v === "高" || v === "中" || v === "低";
}

/**
 * 優先度を1段下げる（高→中→低）。低はそれ以上下がらず低のまま。
 * WEB申請の確認カードの「優先度を下げる」ボタン（§4.14）が使う純粋ロジック。
 */
export function lowerPriority(p: Priority): Priority {
  if (p === "高") return "中";
  if (p === "中") return "低";
  return "低";
}
