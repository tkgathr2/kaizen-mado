// ── GET /api/health ── カイゼン自律ループ 死活監視エンドポイント ──
// ループの要所（AIモデル疎通・Notion読取・knowhow・滞留）が生きているか点検し、
// 結果JSONを返す。各チェックは fail-safe（鍵未設定=skipped・例外=error として握る）。
// チェック自体に失敗しても全体は 200 で返し、判定は body.ok / body.problems で示す。
// CRON_SECRET が設定されていれば認証を要求（?secret= / x-cron-secret / Vercel Cron の Bearer）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { runHealthChecks } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron / 監視ワークフローは GET で叩く。手動確認も GET。
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // runHealthChecks 自体は各チェックを握って必ず HealthReport を返す。
  // 念のため最外周も try で包み、観測APIが500を返さないようにする。
  try {
    const report = await runHealthChecks();
    return NextResponse.json(report, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        problems: ["health-internal"],
        checks: [
          {
            name: "health-internal",
            status: "error",
            detail: (e as Error).message || "health error",
          },
        ],
        checkedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}

// cronAuth（x-cron-secret / Bearer）に加え、監視ワークフローの簡便のため
// ?secret= クエリでも受ける。?secret= は CRON_SECRET と定数時間で照合する。
function isAuthorized(req: NextRequest): boolean {
  if (checkCronSecret(req)) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const q = req.nextUrl.searchParams.get("secret");
  return !!q && safeEqual(q, secret);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
