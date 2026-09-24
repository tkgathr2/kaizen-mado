// ── GET /api/cron/merge-wait-list ── 毎朝6時JST・Merge待ちPR一覧をSlackへ ──
// tkgathr2 organization配下の open PR を検索し、「merge-waiting」ラベル付き、または
// CI green かつ diff<50行（=auto-merge-deploy 基準を満たすのに未マージ）のものを
// 「Merge待ち」として1通のSlackメッセージにまとめて投稿する。
// GITHUB_TOKEN / SLACK_WEBHOOK_URL 未設定ならno-op（安全側の既定）。CRON_SECRET認証必須。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GH_API = "https://api.github.com";
const ORG = "tkgathr2";
const SMALL_DIFF_LINES = 50;

interface MergeWaitPR {
  repo: string;
  number: number;
  title: string;
  url: string;
  ageHours: number;
  diffLines: number;
  priority: "🔴" | "🟡" | "⚪";
}

async function ghFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status}`);
  return res.json();
}

function priorityOf(ageHours: number): MergeWaitPR["priority"] {
  if (ageHours >= 48) return "🔴";
  if (ageHours >= 12) return "🟡";
  return "⚪";
}

// 1回の検索（org横断）でPRを絞り込んでからPRごとに詳細を引く＝複数リポを個別に叩かない効率化。
async function collectMergeWaitPRs(token: string): Promise<MergeWaitPR[]> {
  const q = `org:${ORG} is:pr is:open draft:false`;
  const search = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=50`, token);
  const items: any[] = Array.isArray(search?.items) ? search.items : [];
  const results: MergeWaitPR[] = [];

  for (const item of items) {
    const [owner, repo] = String(item.repository_url).split("/repos/")[1].split("/");
    try {
      const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${item.number}`, token);
      const diffLines = (pr.additions ?? 0) + (pr.deletions ?? 0);
      const hasWaitLabel = (pr.labels ?? []).some((l: any) => l.name === "merge-waiting");
      const ciGreenAndSmall = pr.mergeable_state === "clean" && diffLines < SMALL_DIFF_LINES;
      if (!hasWaitLabel && !ciGreenAndSmall) continue;
      const ageHours = Math.round((Date.now() - new Date(pr.created_at).getTime()) / 36e5);
      results.push({
        repo: `${owner}/${repo}`,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        ageHours,
        diffLines,
        priority: priorityOf(ageHours),
      });
    } catch (e) {
      console.error("[merge-wait-list] PR取得失敗:", owner, repo, item.number, (e as Error).message);
    }
  }
  return results.sort((a, b) => b.ageHours - a.ageHours);
}

function formatMessage(prs: MergeWaitPR[]): string {
  if (prs.length === 0) return "📋 Merge待ち案件：本日はありません。";
  const lines = prs.map(
    (p) => `${p.priority} ${p.repo}#${p.number}「${p.title}」\n経過${p.ageHours}h・diff${p.diffLines}行\n${p.url}`
  );
  return `📋 Merge待ち案件（${prs.length}件）\n\n${lines.join("\n\n")}`;
}

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = process.env.GITHUB_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!token || !webhook) {
    return NextResponse.json({ ok: true, skipped: "GITHUB_TOKEN/SLACK_WEBHOOK_URL未設定" });
  }

  let prs: MergeWaitPR[];
  try {
    prs = await collectMergeWaitPRs(token);
  } catch (err) {
    console.error("[merge-wait-list] 検索失敗:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "PR検索に失敗しました" }, { status: 502 });
  }

  const slackRes = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: formatMessage(prs) }),
  }).catch((e) => {
    console.error("[merge-wait-list] Slack投稿失敗:", (e as Error).message);
    return null;
  });

  return NextResponse.json({ ok: true, count: prs.length, slackOk: Boolean(slackRes && slackRes.ok) });
}

export async function GET(req: NextRequest) {
  return handler(req);
}
export async function POST(req: NextRequest) {
  return handler(req);
}
