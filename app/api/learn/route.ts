// ── POST /api/learn ── ⑧ 完了チケット → 学び還元（knowhowへ） ──
// 完了済み未学習チケットを knowhow に memorize する。誰にも送信しない（対人送信なし）。
// 段階リリースのため既定OFF（KNOWHOW_ENABLED）。CRON_SECRET で内部/cron保護。
import { NextRequest, NextResponse } from "next/server";
import { returnLearningFromCompleted } from "@/lib/learn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 本番で未設定＝fail-closed（Notion書き換え・knowhow送信を野ざらしにしない）。
    // 開発（NODE_ENV!==production）では未設定でも通す。
    return process.env.NODE_ENV !== "production";
  }
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await returnLearningFromCompleted();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[learn] failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "学び還元に失敗しました。" },
      { status: 500 }
    );
  }
}
