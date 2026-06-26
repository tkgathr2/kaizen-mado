// ── ダッシュボード「進行中」件数の純粋ロジック ──
// 進行中件数 ＝ 全件 −「完了」−「見送り」。
// 段名を直書きで足し合わせると、ファネルの段が増えたとき数え漏れる。
// 「終わった段」だけを引く方式にして、段の増減に強くする。
// （状態の正本 lib/board.ts は変更せず、dashboard 側の集計ロジックのみ）

export const FINISHED_STAGES = new Set(["完了", "見送り"]);

export function inProgressFromFunnel(funnel: { stage: string; count: number }[]): number {
  return funnel.reduce(
    (sum, f) => (FINISHED_STAGES.has(f.stage) ? sum : sum + f.count),
    0
  );
}
