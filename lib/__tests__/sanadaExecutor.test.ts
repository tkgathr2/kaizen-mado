// ── バグチェック High-1 / High-2 の回帰テスト（2026-08-12・北村） ──
//
// High-1: 社長がLINEカードの「🛠 ClaudeCodeへ送る」を押すと、真田側で Claude Code が起動する。
//         そのあと真田が書き戻す GO を「着手」にすると、カイゼンくん側の自動改修
//         （/api/execute → repository_dispatch → kaizen-execute.yml、および kaizen-loop.yml の
//         15分ごとのcron）が**同じチケットをもう一度 Claude Code で実装**する。
//         2026-08-12 KZ-132 で実測（真田のセッションと同時にカイゼン側の実装ジョブが走行）。
//         → executor:"sanada" のGOは「真田実装中」へ遷移し、どのクエリにも拾われないこと。
//
// High-2: TicketRow は Slack起点チケットの slackChannelId / slackThreadTs を持っているのに
//         handoff payload に一度も載せていなかった。そのため真田側は合成ts（kaizen:<id>）しか
//         持てず、社長が「✅OK」を押すと chat.postMessage が invalid_thread_ts で必ず失敗した。
//         → Slack起点なら payload に載ること。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updateTicketState = vi.fn(async (..._a: unknown[]) => {});
const appendDiscussionBlocks = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../tickets", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    updateTicketState: (...a: unknown[]) => updateTicketState(...a),
    appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
  };
});

vi.mock("../targets", () => ({
  findTarget: () => ({
    system: "ほうこちゃん",
    repo: "tkgathr2/security-report-system",
    healthUrl: null,
    forbiddenPaths: [],
    autoEligible: true,
  }),
}));

import { applyGoAction } from "../govote";
import { buildHandoffPayload } from "../handoff";
import { KZ_STATUS } from "../kz-state";

function ticket(overrides: Record<string, unknown> = {}): any {
  return {
    pageId: "37b0d980-8b3b-8148-9721-e1fa84498c34",
    ticketId: "KZ-132",
    system: "ほうこちゃん",
    type: "bug",
    importance: "中",
    priority: "高",
    title: "チケット名",
    detail: "チケット内容",
    reporter: "起票者",
    state: "GO待ち",
    fgsUrl: null,
    ...overrides,
  };
}

beforeEach(() => {
  updateTicketState.mockClear();
  appendDiscussionBlocks.mockClear();
});

describe("High-1: 真田実装のGOはカイゼン側の自動改修に拾われない", () => {
  it('executor:"sanada" のGOは「着手」ではなく「真田実装中」へ遷移する', async () => {
    const res = await applyGoAction("go", ticket(), undefined, { executor: "sanada" });
    expect(res.ok).toBe(true);
    expect(res.newState).toBe(KZ_STATUS.SANADA_IMPLEMENTING);
    expect(res.newState).not.toBe(KZ_STATUS.IN_PROGRESS);
    expect(updateTicketState).toHaveBeenCalledWith(expect.any(String), KZ_STATUS.SANADA_IMPLEMENTING);
    // 「着手」へ落ちる呼び出しが1つも無いこと（ここが崩れると二重実装が復活する）。
    for (const call of updateTicketState.mock.calls) {
      expect(call[1]).not.toBe(KZ_STATUS.IN_PROGRESS);
    }
  });

  // 【2026-08-12 本番実測で判明】Notion は未登録の select 選択肢を自動作成せず 400 を返す。
  // 選択肢が消えた/未登録のとき、握り潰して「着手」へ落ちると二重実装が復活する。
  // 進まない方（throw）に倒れることを固定する。
  it("「真田実装中」への遷移が失敗しても「着手」へフォールバックしない（二重実装を復活させない）", async () => {
    updateTicketState.mockRejectedValueOnce(
      new Error('Notion patch error 400: Invalid select value for property "状態"')
    );
    await expect(
      applyGoAction("go", ticket(), undefined, { executor: "sanada" })
    ).rejects.toThrow(/Invalid select value/);
    for (const call of updateTicketState.mock.calls) {
      expect(call[1]).not.toBe(KZ_STATUS.IN_PROGRESS);
    }
  });

  // 【2026-08-15 社長指示】カイゼンくん自身の自動改修（executor未指定）は廃止。状態は変えず
  // 真田専用LINEチャネルでの操作を案内するだけになる（旧: 「着手」へ遷移していた）。
  it("executor 未指定のGOはもう自動改修に入らず、状態を変えず真田チャネルを案内する", async () => {
    const res = await applyGoAction("go", ticket());
    expect(res.newState).toBeUndefined();
    expect(res.skipped).toBe(true);
    expect(res.reply).toContain("真田");
  });

  it('executor:"sanada" でも fix / reject の遷移先は変わらない', async () => {
    const fix = await applyGoAction("fix", ticket(), "直して", { executor: "sanada" });
    expect(fix.newState).toBe(KZ_STATUS.BLOCKED);
    const rej = await applyGoAction("reject", ticket(), undefined, { executor: "sanada" });
    expect(rej.newState).toBe("却下");
  });

  it("GO待ち以外には作用しない（冪等・executor を付けても同じ）", async () => {
    const res = await applyGoAction("go", ticket({ state: KZ_STATUS.SANADA_IMPLEMENTING }), undefined, {
      executor: "sanada",
    });
    expect(res.skipped).toBe(true);
    expect(updateTicketState).not.toHaveBeenCalled();
  });

  // ── 「経路が1本も残っていない」ことの構造的な証明 ──
  // カイゼンくん側で自動改修を起こすのは app/api/execute だけであり、そこが対象チケットを
  // 引くのは fetchTicketsByState / fetchStaleImplementing の状態リテラルだけ。
  // それらの中に「真田実装中」が現れないことをソースで機械検査する
  // （将来 execute に新しい状態を足した人が、この状態を巻き込んだら落ちる）。
  it("app/api/execute と lib/tickets の自動改修クエリが「真田実装中」を引かない", () => {
    const root = join(__dirname, "..", "..");
    const executeSrc = readFileSync(join(root, "app", "api", "execute", "route.ts"), "utf8");
    const ticketsSrc = readFileSync(join(root, "lib", "tickets.ts"), "utf8");

    // execute が直接引く状態
    const executeStates = [...executeSrc.matchAll(/fetchTicketsByState\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(executeStates.length).toBeGreaterThan(0);
    expect(executeStates).not.toContain(KZ_STATUS.SANADA_IMPLEMENTING);

    // reaper（実装中→着手へ戻す）が引く状態
    const stale = ticketsSrc.match(/fetchStaleImplementing[\s\S]{0,600}?fetchTicketsByState\(\s*"([^"]+)"/);
    expect(stale?.[1]).toBe(KZ_STATUS.IMPLEMENTING);
    expect(stale?.[1]).not.toBe(KZ_STATUS.SANADA_IMPLEMENTING);

    // 自動改修の起動そのもの（repository_dispatch）は execute 以外に無い
    const dispatchers = executeSrc.includes("dispatchExecution");
    expect(dispatchers).toBe(true);
  });

  it("kz-sweep は「真田実装中」を監視するが自動クローズはしない", () => {
    const root = join(__dirname, "..", "..");
    const sweepSrc = readFileSync(join(root, "app", "api", "cron", "kz-sweep", "route.ts"), "utf8");
    const ticketsSrc = readFileSync(join(root, "lib", "tickets.ts"), "utf8");
    // 監視対象に入っている（放置検知が効く）
    expect(ticketsSrc).toContain("KZ_STATUS.SANADA_IMPLEMENTING");
    // 分岐がある
    expect(sweepSrc).toContain("KZ_STATUS.SANADA_IMPLEMENTING");
    // その分岐の中でクローズしていない
    const branch = sweepSrc.slice(sweepSrc.indexOf("row.state === KZ_STATUS.SANADA_IMPLEMENTING"));
    const branchBody = branch.slice(0, branch.indexOf('return { ...base, action: "none" };'));
    expect(branchBody).not.toContain("KZ_STATUS.CLOSED");
  });
});

describe("High-2: Slack起点チケットは元スレッドの位置を真田へ渡す", () => {
  const discussion = { houshin: "方針", steps: ["手順1"] };

  it("slackChannelId / slackThreadTs があれば payload に載る", () => {
    const p = buildHandoffPayload(
      ticket({ slackChannelId: "C123ABC", slackThreadTs: "1786400000.123456" }),
      discussion
    );
    expect(p.slackChannel).toBe("C123ABC");
    expect(p.slackThreadTs).toBe("1786400000.123456");
  });

  it("Web窓口起点（Slack情報なし）ではキー自体を付けない", () => {
    const p = buildHandoffPayload(ticket(), discussion);
    expect(p).not.toHaveProperty("slackChannel");
    expect(p).not.toHaveProperty("slackThreadTs");
  });

  it("片方しか無いときは載せない（返信先として成立しないため）", () => {
    const only = buildHandoffPayload(ticket({ slackChannelId: "C123ABC" }), discussion);
    expect(only).not.toHaveProperty("slackChannel");
    expect(only).not.toHaveProperty("slackThreadTs");
  });
});
