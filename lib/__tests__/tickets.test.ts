import { describe, it, expect, vi, beforeEach } from "vitest";

// Postgres プールをモックする（Notion API fetch のモックから移行・2026-08-16）。
// lib/db/pool.ts の getPool()/ensureSchema() だけを差し替え、tickets.ts 本体は素で動かす。
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db/pool", () => ({
  getPool: () => ({ query: (...args: any[]) => queryMock(...args) }),
  ensureSchema: async () => undefined,
}));

import {
  fetchTicketsByState,
  fetchAllTickets,
  fetchTicketByPageId,
  fetchCompletedUnlearned,
  fetchNonTerminalTickets,
  updateTicketState,
  setTicketUrlField,
  setPrUrl,
  setTicketAssignee,
  setStatusChangedAt,
  appendDiscussionBlocks,
  isStaleImplementing,
  staleImplementingMinutes,
  fetchStaleImplementing,
  submitDedupSeconds,
  anonSubmitDedupSeconds,
  matchDuplicate,
  findRecentDuplicate,
  findTicketByTicketId,
  findGoMachiByTicketId,
  findExistingBySlackThreadTs,
  type TicketRow,
} from "../tickets";
import type { Ticket } from "../types";

/** app/api/board/proposal-token/route.ts が pageId に課している検証。
 * ここを通らない pageId を返すと /board の GO/却下 ボタンが 400 で壊れる。 */
const BOARD_UUID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const T0 = new Date("2026-06-26T12:00:00.000Z");

function dbRow(over: Record<string, any> = {}) {
  return {
    id: "1",
    ticket_number: 12,
    system: "プロレポ",
    type: "改善",
    importance: "高",
    title: "一覧が表示されない",
    detail: "一覧ページが空になる",
    reporter: "現場フォーム",
    state: "受付",
    assignee: "",
    fgs_url: null,
    pr_url: null,
    urgency: null,
    importance_score: null,
    priority: null,
    priority_reason: null,
    status_changed_at: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    slack_user_id: null,
    notion_page_id: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

/** 呼び出し順に返す行を仕込む。以降は空配列。 */
function queueRows(...batches: any[][]) {
  queryMock.mockReset();
  for (const b of batches) queryMock.mockResolvedValueOnce({ rows: b });
  queryMock.mockResolvedValue({ rows: [] });
}

const sqlOf = (i = 0) => String(queryMock.mock.calls[i][0]).replace(/\s+/g, " ").trim();
const paramsOf = (i = 0) => queryMock.mock.calls[i][1];

beforeEach(() => {
  queueRows();
});

describe("tickets（Postgres版）", () => {
  it("fetchTicketsByState がDB行を TicketRow に正しくマップする", async () => {
    queueRows([dbRow()]);

    const rows = await fetchTicketsByState("受付", 5);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.ticketId).toBe("KZ-12");
    expect(r.system).toBe("プロレポ");
    expect(r.type).toBe("改善");
    expect(r.importance).toBe("高");
    expect(r.title).toBe("一覧が表示されない");
    expect(r.detail).toBe("一覧ページが空になる");
    expect(r.reporter).toBe("現場フォーム");
    expect(r.state).toBe("受付");
    expect(r.fgsUrl).toBeNull();
    expect(r.prUrl).toBeUndefined();
    expect(r.lastEdited).toBe(T0.toISOString());
    expect(r.createdTime).toBe(T0.toISOString());
  });

  it("fetchTicketsByState は state で絞り limit を渡す", async () => {
    queueRows([dbRow()]);
    await fetchTicketsByState("受付", 3);
    expect(sqlOf()).toContain("WHERE state = $1");
    expect(sqlOf()).toContain("ORDER BY created_at DESC");
    expect(paramsOf()).toEqual(["受付", 3]);
  });

  it("任意フィールド（PR URL・優先度・Slackメタ）が入っていれば TicketRow に反映する", async () => {
    queueRows([
      dbRow({
        pr_url: "https://github.com/tkgathr2/kaizen-mado/pull/12",
        urgency: 9,
        importance_score: 8,
        priority: "高",
        priority_reason: "業務停止",
        status_changed_at: T0,
        slack_channel_id: "C123",
        slack_thread_ts: "1720000000.0001",
        slack_user_id: "U123",
      }),
    ]);
    const r = (await fetchTicketsByState("レビュー", 1))[0];
    expect(r.prUrl).toBe("https://github.com/tkgathr2/kaizen-mado/pull/12");
    expect(r.urgency).toBe(9);
    expect(r.importanceScore).toBe(8);
    expect(r.priority).toBe("高");
    expect(r.priorityReason).toBe("業務停止");
    expect(r.statusChangedAt).toBe(T0.toISOString());
    expect(r.slackChannelId).toBe("C123");
    expect(r.slackThreadTs).toBe("1720000000.0001");
    expect(r.slackUserId).toBe("U123");
  });

  it("fetchAllTickets は updated_at の新しい順で引く（/board の並び）", async () => {
    queueRows([dbRow()]);
    await fetchAllTickets(250);
    expect(sqlOf()).toContain("ORDER BY updated_at DESC");
    expect(paramsOf()).toEqual([250]);
  });

  it("fetchCompletedUnlearned は 完了 かつ FGSリンク空 を引く", async () => {
    queueRows([dbRow({ state: "完了" })]);
    await fetchCompletedUnlearned(10);
    expect(sqlOf()).toContain("(fgs_url IS NULL OR fgs_url = '')");
    expect(paramsOf()).toEqual(["完了", 10]);
  });

  it("fetchNonTerminalTickets は4状態を1クエリ（state = ANY）でまとめて引く", async () => {
    queueRows([dbRow({ state: "GO待ち" })]);
    await fetchNonTerminalTickets(50);
    expect(sqlOf()).toContain("state = ANY($1)");
    expect(paramsOf()[0]).toEqual(["GO待ち", "差し戻し", "レビュー", "真田実装中"]);
    expect(paramsOf()[1]).toBe(50);
    // Notion版のような状態ごとの複数クエリにはしない。
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

// ── pageId 設計（移行の最重要ポイント）──
describe("pageId の組み立てと逆引き", () => {
  it("移行データ（notion_page_id あり）は実Notion UUIDをそのまま pageId にする", async () => {
    const notionId = "1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5061";
    queueRows([dbRow({ notion_page_id: notionId })]);
    const r = (await fetchTicketsByState("受付", 1))[0];
    expect(r.pageId).toBe(notionId);
  });

  it("新規チケット（notion_page_id なし）は内部IDから合成したUUID形式の pageId になる", async () => {
    queueRows([dbRow({ id: "42", notion_page_id: null })]);
    const r = (await fetchTicketsByState("受付", 1))[0];
    expect(r.pageId).toBe("00000000-0000-4000-8000-00000000002a");
  });

  it("★合成 pageId は /board の proposal-token の UUID 検証を通る（通らないとGO/却下が壊れる）", async () => {
    for (const id of ["1", "42", "999999", "2147483647"]) {
      queueRows([dbRow({ id, notion_page_id: null })]);
      const r = (await fetchTicketsByState("受付", 1))[0];
      expect(BOARD_UUID_RE.test(r.pageId)).toBe(true);
    }
  });

  it("合成 pageId は内部IDへ逆変換され id で直引きされる", async () => {
    queueRows([dbRow({ id: "42" })]);
    await fetchTicketByPageId("00000000-0000-4000-8000-00000000002a");
    expect(sqlOf()).toContain("WHERE id = $1::bigint");
    expect(paramsOf()).toEqual(["42"]);
  });

  it("実Notion UUID は notion_page_id で引く（移行済みチケットの既存リンクが生きる）", async () => {
    const notionId = "1f2e3d4c5b6a79889a0b1c2d3e4f5061";
    queueRows([dbRow({ notion_page_id: notionId })]);
    await fetchTicketByPageId(notionId);
    expect(sqlOf()).toContain("WHERE notion_page_id = $1");
    expect(paramsOf()).toEqual([notionId]);
  });

  it("裸の数値 pageId も内部IDとして受ける（防御的）", async () => {
    queueRows([dbRow()]);
    await fetchTicketByPageId("7");
    expect(sqlOf()).toContain("WHERE id = $1::bigint");
    expect(paramsOf()).toEqual(["7"]);
  });

  it("pageId が空ならDBに触れず null", async () => {
    expect(await fetchTicketByPageId("")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("該当行が無ければ null", async () => {
    queueRows([]);
    expect(await fetchTicketByPageId("00000000-0000-4000-8000-000000000001")).toBeNull();
  });
});

// ── 更新系 ──
describe("更新系（updated_at を必ず進める）", () => {
  it("updateTicketState は state と updated_at を更新する", async () => {
    await updateTicketState("00000000-0000-4000-8000-000000000005", "GO待ち");
    expect(sqlOf()).toBe(
      "UPDATE tickets SET state = $2, updated_at = now() WHERE id = $1::bigint"
    );
    expect(paramsOf()).toEqual(["5", "GO待ち"]);
  });

  it("setTicketUrlField は fgs_url を更新する", async () => {
    await setTicketUrlField("5", "knowhow://memorized");
    expect(sqlOf()).toContain("SET fgs_url = $2");
    expect(paramsOf()).toEqual(["5", "knowhow://memorized"]);
  });

  it("setPrUrl は pr_url を更新する（列が常にあるので旧実装のような400は起きない）", async () => {
    await setPrUrl("5", "https://github.com/tkgathr2/kaizen-mado/pull/12");
    expect(sqlOf()).toContain("SET pr_url = $2");
    expect(paramsOf()).toEqual(["5", "https://github.com/tkgathr2/kaizen-mado/pull/12"]);
  });

  it("setTicketAssignee は assignee を更新する（Notionの1900字切り詰めは廃止）", async () => {
    const long = "あ".repeat(2500);
    await setTicketAssignee("5", long);
    expect(sqlOf()).toContain("SET assignee = $2");
    expect(paramsOf()[1]).toHaveLength(2500);
  });

  it("setStatusChangedAt は status_changed_at を ISO で更新する", async () => {
    await setStatusChangedAt("5", T0);
    expect(sqlOf()).toContain("SET status_changed_at = $2");
    expect(paramsOf()).toEqual(["5", T0.toISOString()]);
  });

  it("setStatusChangedAt はDB例外を握り潰す（状態遷移を巻き添えにしない）", async () => {
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error("connection lost"));
    await expect(setStatusChangedAt("5", T0)).resolves.toBeUndefined();
  });

  it("pageId が空の更新は no-op（DBに触れない）", async () => {
    await updateTicketState("", "完了");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── 議論ログ（追記専用・挿入順が命）──
describe("appendDiscussionBlocks", () => {
  it("チケットを解決し、1回のINSERTで挿入順どおりに複数行を追記する", async () => {
    queueRows([{ id: "5" }]);
    await appendDiscussionBlocks("00000000-0000-4000-8000-000000000005", [
      { heading: "方針", body: "対応します" },
      { heading: "続報" },
      { body: "完了しました" },
    ]);

    // 1回目=ID解決 / 2回目=INSERT / 3回目=updated_at 更新
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(sqlOf(0)).toContain("SELECT id FROM tickets WHERE id = $1::bigint");

    expect(sqlOf(1)).toBe(
      "INSERT INTO ticket_discussion_blocks (ticket_id, heading, body) VALUES " +
        "($1::bigint, $2, $3), ($1::bigint, $4, $5), ($1::bigint, $6, $7)"
    );
    expect(paramsOf(1)).toEqual([
      "5",
      "方針", "対応します",
      "続報", null,
      null, "完了しました",
    ]);

    expect(sqlOf(2)).toContain("UPDATE tickets SET updated_at = now()");
  });

  it("空の lines はDBに触れない", async () => {
    await appendDiscussionBlocks("5", []);
    await appendDiscussionBlocks("5", [{}, { heading: "", body: "" }]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("該当チケットが無ければ throw する（Notion時代の404相当）", async () => {
    queueRows([]);
    await expect(
      appendDiscussionBlocks("00000000-0000-4000-8000-0000000000ff", [{ heading: "x" }])
    ).rejects.toThrow(/チケットが見つかりません/);
  });
});

// ── stuck回収（reaper）──
describe("fetchStaleImplementing", () => {
  it("『実装中』を取得し lastEdited が閾値超のものだけ返す", async () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    queueRows([
      dbRow({ id: "1", title: "fresh", state: "実装中", updated_at: new Date("2026-06-26T11:50:00.000Z") }),
      dbRow({ id: "2", title: "stuck", state: "実装中", updated_at: new Date("2026-06-26T11:20:00.000Z") }),
    ]);

    const rows = await fetchStaleImplementing(30, 10, now);
    expect(paramsOf()).toEqual(["実装中", 10]);
    expect(rows.map((r) => r.title)).toEqual(["stuck"]);
  });

  it("staleImplementingMinutes は env 既定30・正の数のみ採用", () => {
    expect(staleImplementingMinutes({} as NodeJS.ProcessEnv)).toBe(30);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "45" } as any)).toBe(45);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "0" } as any)).toBe(30);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "-5" } as any)).toBe(30);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "abc" } as any)).toBe(30);
  });
});

describe("isStaleImplementing（stuck判定の純粋ロジック）", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const base = { state: "実装中" as const };

  it("実装中＋閾値以上の経過は stuck（true）", () => {
    expect(isStaleImplementing({ ...base, lastEdited: "2026-06-26T11:20:00.000Z" }, now, 30)).toBe(true);
    expect(isStaleImplementing({ ...base, lastEdited: "2026-06-26T11:30:00.000Z" }, now, 30)).toBe(true);
  });

  it("実装中でも閾値未満なら stuck でない（false）", () => {
    expect(isStaleImplementing({ ...base, lastEdited: "2026-06-26T11:45:00.000Z" }, now, 30)).toBe(false);
  });

  it("状態が実装中でなければ常に false（巻き戻さない）", () => {
    expect(isStaleImplementing({ state: "着手", lastEdited: "2026-06-26T10:00:00.000Z" }, now, 30)).toBe(false);
    expect(isStaleImplementing({ state: "完了", lastEdited: "2026-06-26T10:00:00.000Z" }, now, 30)).toBe(false);
  });

  it("lastEdited が無い/不正なら経過判定できず false（安全側）", () => {
    expect(isStaleImplementing({ ...base, lastEdited: undefined }, now, 30)).toBe(false);
    expect(isStaleImplementing({ ...base, lastEdited: "" }, now, 30)).toBe(false);
    expect(isStaleImplementing({ ...base, lastEdited: "not-a-date" }, now, 30)).toBe(false);
  });
});

// ── 起票前 冪等チェック ──
describe("submitDedupSeconds / anonSubmitDedupSeconds（時間窓）", () => {
  it("既定15秒・正の数のみ採用・1〜600にクランプ", () => {
    expect(submitDedupSeconds({} as NodeJS.ProcessEnv)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "30" } as any)).toBe(30);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "0" } as any)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "-5" } as any)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "abc" } as any)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "9999" } as any)).toBe(600);
  });

  it("匿名の窓は記名の半分（最低1秒）", () => {
    expect(anonSubmitDedupSeconds({} as NodeJS.ProcessEnv)).toBe(7);
    expect(anonSubmitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "1" } as any)).toBe(1);
  });
});

describe("matchDuplicate（完全同一内容の厳密照合）", () => {
  const tk = (over: Partial<Ticket> = {}): Ticket => ({
    system: "ほうこちゃん",
    type: "改善",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    importance: "中",
    ...over,
  });
  const row = (over: Partial<TicketRow> = {}): TicketRow => ({
    pageId: "p-1",
    ticketId: "KZ-1",
    system: "ほうこちゃん",
    type: "改善",
    importance: "中",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    reporter: "高木",
    state: "受付",
    fgsUrl: null,
    ...over,
  });

  it("記名：完全同一内容＋同一起票者はヒット（正規化・全半角/大小/空白吸収）", () => {
    expect(matchDuplicate([row({ title: "  写真が横倒し " })], tk(), "高木", false)?.pageId).toBe("p-1");
  });

  it("記名：起票者が違えばヒットしない（別人の同一内容は通す）", () => {
    expect(matchDuplicate([row({ reporter: "脇本" })], tk(), "高木", false)).toBeNull();
  });

  it("内容（detail）が違えばヒットしない（正当な別の声は通す）", () => {
    expect(matchDuplicate([row({ detail: "別の不具合" })], tk(), "高木", false)).toBeNull();
  });

  it("重要度が違えばヒットしない", () => {
    expect(matchDuplicate([row({ importance: "高" })], tk(), "高木", false)).toBeNull();
  });

  it("匿名：起票者を見ず内容完全一致のみでヒット", () => {
    expect(matchDuplicate([row({ reporter: "現場フォーム" })], tk(), null, true)?.pageId).toBe("p-1");
  });
});

describe("findRecentDuplicate（DB段の起票前 冪等チェック）", () => {
  const tk: Ticket = {
    system: "ほうこちゃん",
    type: "改善",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    importance: "中",
  };

  const dupRow = (over: Record<string, any> = {}) =>
    dbRow({
      ticket_number: 7,
      system: "ほうこちゃん",
      type: "改善",
      importance: "中",
      title: "写真が横倒し",
      detail: "PDFで回転する",
      reporter: "高木",
      ...over,
    });

  it("メモリ段をすり抜けた同一内容をDB段で検出して既存を返す（記名）", async () => {
    queueRows([dupRow()]);
    const hit = await findRecentDuplicate(tk, "高木");
    expect(hit?.ticketId).toBe("KZ-7");
    // created_at 窓＋対象システム＋起票者で絞っている
    expect(sqlOf()).toContain("created_at >= $1::timestamptz");
    expect(sqlOf()).toContain("system = $2");
    expect(sqlOf()).toContain("reporter = $3");
    expect(paramsOf()[1]).toBe("ほうこちゃん");
    expect(paramsOf()[2]).toBe("高木");
  });

  it("別内容は弾かない（null＝通常作成にフォールバック）", async () => {
    queueRows([dupRow({ detail: "全く別の不具合" })]);
    expect(await findRecentDuplicate(tk, "高木")).toBeNull();
  });

  it("匿名は起票者フィルタを付けず内容完全一致のみで検出する", async () => {
    queueRows([dupRow({ reporter: "現場フォーム" })]);
    const hit = await findRecentDuplicate(tk, null);
    expect(hit?.ticketId).toBe("KZ-7");
    expect(sqlOf()).not.toContain("reporter = $3");
    expect(paramsOf()).toHaveLength(2);
  });

  it("DBクエリ失敗時は握りつぶして null（起票を止めない＝声を取りこぼさない）", async () => {
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error("connection refused"));
    expect(await findRecentDuplicate(tk, "高木")).toBeNull();
  });
});

describe("findTicketByTicketId（POST /api/kaizen/reply の書き戻し先探索）", () => {
  it("ticketId の番号部分で ticket_number を引き、状態を問わず1件返す", async () => {
    queueRows([dbRow({ ticket_number: 12, state: "差し戻し" })]);
    const hit = await findTicketByTicketId("KZ-12");
    expect(hit?.ticketId).toBe("KZ-12");
    expect(hit?.state).toBe("差し戻し");
    expect(sqlOf()).toContain("WHERE ticket_number = $1");
    expect(paramsOf()).toEqual([12]);
  });

  it("該当チケットが無ければ null", async () => {
    queueRows([]);
    expect(await findTicketByTicketId("KZ-999")).toBeNull();
  });

  it("不正な形式・空文字ならDBに問い合わせず null", async () => {
    expect(await findTicketByTicketId("not-a-ticket-id")).toBeNull();
    expect(await findTicketByTicketId("")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("findGoMachiByTicketId", () => {
  it("連番と GO待ち で1件引く", async () => {
    queueRows([dbRow({ ticket_number: 12, state: "GO待ち" })]);
    const hit = await findGoMachiByTicketId("KZ-12");
    expect(hit?.ticketId).toBe("KZ-12");
    expect(sqlOf()).toContain("WHERE ticket_number = $1 AND state = $2");
    expect(paramsOf()).toEqual([12, "GO待ち"]);
  });

  it("小文字も受ける（kz-12）", async () => {
    queueRows([dbRow({ ticket_number: 12, state: "GO待ち" })]);
    expect((await findGoMachiByTicketId("kz-12"))?.ticketId).toBe("KZ-12");
  });

  it("表記ゆれ（KZ-012・別prefix）はDBに触れず null（Notion版と同じ厳密さ）", async () => {
    expect(await findGoMachiByTicketId("KZ-012")).toBeNull();
    expect(await findGoMachiByTicketId("AB-12")).toBeNull();
    expect(await findGoMachiByTicketId("")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("findExistingBySlackThreadTs", () => {
  it("thread_ts + channel_id + 未終端3状態 で直近1件を引く", async () => {
    queueRows([dbRow({ slack_thread_ts: "1720000000.0001", slack_channel_id: "C1" })]);
    const hit = await findExistingBySlackThreadTs("1720000000.0001", "C1");
    expect(hit?.ticketId).toBe("KZ-12");
    expect(sqlOf()).toContain("slack_thread_ts = $1 AND slack_channel_id = $2");
    expect(sqlOf()).toContain("state = ANY($3)");
    expect(paramsOf()[2]).toEqual(["受付", "GO待ち", "議論中"]);
  });

  it("引数が欠けていればDBに触れず null", async () => {
    expect(await findExistingBySlackThreadTs("", "C1")).toBeNull();
    expect(await findExistingBySlackThreadTs("ts", "")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("DB失敗時は握りつぶして null（fail-safe＝起票を止めない）", async () => {
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error("boom"));
    expect(await findExistingBySlackThreadTs("ts", "C1")).toBeNull();
  });
});
