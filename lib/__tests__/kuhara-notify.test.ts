import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  notifyKuharaCopy,
  buildKuharaGoText,
  buildKuharaStuckText,
  buildKuharaReviewText,
  buildKuharaMergedText,
  buildKuharaDigestText,
} from "../line";
import type { TicketRow } from "../tickets";
import type { DiscussResult } from "../discuss";

// ── 久原さん（社外・AI・DX顧問候補・NDA未締結）向け Slack複製投稿のテスト ──
// 社長宛LINE通知（GO伺い・詰まり連絡・Merge待ち・完了報告・毎朝ダイジェスト）と同じ内容の
// 要約を、既存のpersona-relay（notifySlackAlertと共用）経由でC0BSSMT0LHWへ複製投稿する機能。
// 検証観点：
//  ① env（PERSONA_RELAY_URL/SECRET・KAIZEN_KUHARA_SLACK_CHANNEL）未設定なら送らない（fail-safe）。
//  ② 揃っていれば正しいURL・チャンネル・要約本文で投げる。
//  ③ fetch失敗（例外・非ok）でも例外を投げず false を返す（呼び出し元を巻き込まない）。
//  ④ 各種別の要約ビルダーが「通知種別・対象案件・チケットURL」を含む（構造化された要約）。

const ticket: TicketRow = {
  pageId: "page-abc",
  ticketId: "KZ-42",
  system: "プロレポ",
  type: "改善",
  importance: "高",
  title: "一覧が重い",
  detail: "...",
  reporter: "現場",
  state: "GO待ち",
  fgsUrl: null,
};

const d: DiscussResult = {
  houshin: "ページングを導入",
  steps: ["①一覧にページングを追加"],
  kousuu: "1〜2日",
  risks: ["既存ソート互換"],
  importance: "高",
  urgency: "中",
  recommendation: "GO推奨",
  goDraft: "...",
  problemPlain: "一覧が重くて開くのが遅い",
  fixPlain: ["表示を軽くする"],
  riskPlain: "並び順がずれないか確認します",
  source: "claude",
};

describe("notifyKuharaCopy（久原さん複製投稿）", () => {
  let saved: Record<string, string | undefined>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saved = {
      url: process.env.PERSONA_RELAY_URL,
      secret: process.env.PERSONA_RELAY_SECRET,
      channel: process.env.KAIZEN_KUHARA_SLACK_CHANNEL,
    };
    fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env.PERSONA_RELAY_URL = saved.url;
    process.env.PERSONA_RELAY_SECRET = saved.secret;
    process.env.KAIZEN_KUHARA_SLACK_CHANNEL = saved.channel;
    vi.unstubAllGlobals();
  });

  it("env未設定なら何もせず false（fetchは呼ばれない）", async () => {
    delete process.env.PERSONA_RELAY_URL;
    delete process.env.PERSONA_RELAY_SECRET;
    delete process.env.KAIZEN_KUHARA_SLACK_CHANNEL;

    const ok = await notifyKuharaCopy("GO伺い", ["line1", "line2"]);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("チャンネルだけ未設定でも送らない（3つ揃わないとfail-safe）", async () => {
    process.env.PERSONA_RELAY_URL = "https://relay.example.com";
    process.env.PERSONA_RELAY_SECRET = "s3cret";
    delete process.env.KAIZEN_KUHARA_SLACK_CHANNEL;

    const ok = await notifyKuharaCopy("GO伺い", ["line1"]);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("3つ揃っていれば persona-relay へ POST し、正しいチャンネル・本文を送る", async () => {
    process.env.PERSONA_RELAY_URL = "https://relay.example.com/";
    process.env.PERSONA_RELAY_SECRET = "s3cret";
    process.env.KAIZEN_KUHARA_SLACK_CHANNEL = "C0BSSMT0LHW";

    const ok = await notifyKuharaCopy("GO伺い", ["🖥 プロレポ", "🎫 KZ-42：一覧が重い"]);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example.com/send"); // 末尾スラッシュは正規化される
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-relay-secret"]).toBe("s3cret");
    const body = JSON.parse(init.body as string);
    expect(body.channel).toBe("C0BSSMT0LHW");
    expect(body.persona).toBe("sanada");
    expect(body.text).toContain("カイゼンくん通知（複製）／GO伺い");
    expect(body.text).toContain("🎫 KZ-42：一覧が重い");
  });

  it("冒頭で久原さんへ@メンションする（2026-08-22追加・メンション無しだと通知が飛ばず本番実測で発覚）", async () => {
    process.env.PERSONA_RELAY_URL = "https://relay.example.com";
    process.env.PERSONA_RELAY_SECRET = "s3cret";
    process.env.KAIZEN_KUHARA_SLACK_CHANNEL = "C0BSSMT0LHW";

    await notifyKuharaCopy("GO伺い", ["line1"]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain("<@U0BLFU47BS9>");
    expect(body.text.indexOf("<@U0BLFU47BS9>")).toBe(0); // 冒頭であること
  });

  it("relayがエラー応答(ok:false)を返しても例外を投げずfalseを返す", async () => {
    process.env.PERSONA_RELAY_URL = "https://relay.example.com";
    process.env.PERSONA_RELAY_SECRET = "s3cret";
    process.env.KAIZEN_KUHARA_SLACK_CHANNEL = "C0BSSMT0LHW";
    fetchMock.mockResolvedValue({ ok: false } as Response);

    const ok = await notifyKuharaCopy("詰まり連絡", ["x"]);

    expect(ok).toBe(false);
  });

  it("fetchが例外を投げても呼び出し元へ伝播させずfalseを返す（fail-safe）", async () => {
    process.env.PERSONA_RELAY_URL = "https://relay.example.com";
    process.env.PERSONA_RELAY_SECRET = "s3cret";
    process.env.KAIZEN_KUHARA_SLACK_CHANNEL = "C0BSSMT0LHW";
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(notifyKuharaCopy("Merge待ち", ["x"])).resolves.toBe(false);
  });
});

describe("久原さん複製投稿の要約ビルダー（構造化フォーマット）", () => {
  it("buildKuharaGoText：システム名・案件ID/タイトル・こまりごと・チケットURLを含む", () => {
    const lines = buildKuharaGoText(ticket, d).join("\n");
    expect(lines).toContain("プロレポ");
    expect(lines).toContain("KZ-42");
    expect(lines).toContain("一覧が重い");
    expect(lines).toContain("一覧が重くて開くのが遅い"); // こまりごと（problemPlain）
    expect(lines).toContain("GO推奨"); // おすすめ
    expect(lines).toContain("https://kaizen.takagi.bz/board/ticket/page-abc");
  });

  it("buildKuharaStuckText：詰まった理由とチケットURLを含む", () => {
    const lines = buildKuharaStuckText(ticket, "Notionトークンが必要です").join("\n");
    expect(lines).toContain("KZ-42");
    expect(lines).toContain("Notionトークンが必要です");
    expect(lines).toContain("https://kaizen.takagi.bz/board/ticket/page-abc");
  });

  it("buildKuharaReviewText：PR URLとMerge待ちの理由を含む", () => {
    const lines = buildKuharaReviewText(
      ticket,
      "https://github.com/x/y/pull/1",
      "自動マージ条件を満たさず"
    ).join("\n");
    expect(lines).toContain("Merge待ち");
    expect(lines).toContain("https://github.com/x/y/pull/1");
    expect(lines).toContain("自動マージ条件を満たさず");
  });

  it("buildKuharaMergedText：完了・PR URL・チケットURLを含む", () => {
    const lines = buildKuharaMergedText(ticket, "https://github.com/x/y/pull/1").join("\n");
    expect(lines).toContain("本番反映まで完了しました");
    expect(lines).toContain("https://github.com/x/y/pull/1");
    expect(lines).toContain("https://kaizen.takagi.bz/board/ticket/page-abc");
  });

  it("buildKuharaDigestText：件数・各チケットの1行要約・全体像URLを含む", () => {
    const items = [
      { ticketId: "KZ-1", type: "completion", message: "反映しました" },
      { ticketId: "KZ-2", type: "error", message: "改修が失敗" },
    ];
    const lines = buildKuharaDigestText(items).join("\n");
    expect(lines).toContain("2件");
    expect(lines).toContain("KZ-1");
    expect(lines).toContain("KZ-2");
    expect(lines).toContain("反映しました");
    expect(lines).toContain("https://kaizen.takagi.bz/board");
  });

  it("buildKuharaDigestText：21件以上は20件で畳んで残数を表示する", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      ticketId: `KZ-${i}`,
      type: "completion",
      message: "m",
    }));
    const lines = buildKuharaDigestText(items).join("\n");
    expect(lines).toContain("…ほか 5件");
  });
});
