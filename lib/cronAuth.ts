// ── cron/内部エンドポイントの共通認証 ──
// CRON_SECRET を2方式で受ける：
//  - x-cron-secret: <secret>            （手動/自前cron）
//  - Authorization: Bearer <secret>     （Vercel Cron が自動付与）
// CRON_SECRET 未設定なら、環境に関わらず原則拒否（fail-closed）。
// preview/誤設定で内部APIが素通しになる事故を防ぐ。
// 開発の利便のためにだけ、明示フラグ ALLOW_INSECURE_CRON=1 のときに限り未設定でも通す。
import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

export function checkCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // secret 未設定：明示的に許可された開発環境だけ通す。それ以外は拒否。
    return process.env.ALLOW_INSECURE_CRON === "1";
  }
  const x = req.headers.get("x-cron-secret");
  if (x && safeEqual(x, secret)) return true;
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), secret)) {
    return true;
  }
  return false;
}

// ── LINE push 専用認証 ──
// /api/line/push は「社長へLINE通知を送る」だけの口。共用 CRON_SECRET に加え、
// 監視系クライアント（kaizen-monitor 等のローカル常駐）向けの専用鍵 MONITOR_PUSH_SECRET も受ける。
// 分離の意図：この鍵が漏れても送れるのは LINE 通知のみで、GO奪取・実行系（/api/process 等）には
// 一切使えない（それらは checkCronSecret のまま＝最小権限）。
export function checkLinePushAuth(req: NextRequest): boolean {
  if (checkCronSecret(req)) return true;
  const monitor = process.env.MONITOR_PUSH_SECRET;
  if (monitor && monitor.trim()) {
    const x = req.headers.get("x-monitor-secret");
    if (x && safeEqual(x, monitor)) return true;
  }
  return false;
}

// ── admin/go 専用認証 ──
// /api/admin/go は「GO/修正/却下を直接適用する」強い操作（社長GOの奪取に直結）。
// 共用の CRON_SECRET だけに依存すると、cron 用の鍵を知る者が誰でも GO を奪える。
// そこで CRON_SECRET から分離する：
//   - ADMIN_GO_SECRET が設定されていれば、それと一致する x-admin-go-secret を必須にする
//     （CRON_SECRET では通さない＝鍵を完全分離）。
//   - ADMIN_GO_SECRET 未設定なら、本番(production)では無効化（呼び出し側で 404）。
//     非本番では従来どおり CRON_SECRET で通す（デモ・切り分け検証の利便を維持）。
// 返り値：
//   "ok"           … 認証成功
//   "unauthorized" … 認証失敗（401）
//   "disabled"     … 本番で ADMIN_GO_SECRET 未設定＝この口は塞ぐ（404 で存在を隠す）
export function checkAdminGoAuth(req: NextRequest): "ok" | "unauthorized" | "disabled" {
  const adminSecret = process.env.ADMIN_GO_SECRET;
  if (adminSecret && adminSecret.trim()) {
    const x = req.headers.get("x-admin-go-secret");
    return x && safeEqual(x, adminSecret) ? "ok" : "unauthorized";
  }
  // ADMIN_GO_SECRET 未設定：本番では塞ぐ（共用CRON_SECRETでのGO奪取を防ぐ）。
  if (process.env.NODE_ENV === "production") return "disabled";
  // 非本番のみ、従来の CRON_SECRET 認証にフォールバック（デモ・検証用）。
  return checkCronSecret(req) ? "ok" : "unauthorized";
}

// 長さに依存しない定数時間比較。
// 入力長そのものがタイミング/例外で漏れないよう、まず両者を HMAC で固定長(32byte)に畳んでから
// crypto.timingSafeEqual で比較する（timingSafeEqual は長さ不一致で throw するため、HMAC化で
// 必ず同じ長さにそろえる）。鍵は実行ごとにランダムでよい（同一プロセス内で a/b を同条件に揃える目的）。
const HMAC_KEY = createHmac("sha256", "cronAuth")
  .update(String(Date.now()) + Math.random())
  .digest();

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", HMAC_KEY).update(a, "utf8").digest();
  const hb = createHmac("sha256", HMAC_KEY).update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
