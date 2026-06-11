import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallSimilar, buildRecallNote, isRecallEnabled } from "../recall";
import type { Ticket } from "../types";

const ticket: Ticket = {
  system: "ほうこちゃん",
  type: "改善",
  title: "写真が横倒しになる",
  detail: "スマホ写真がPDFで回転してしまう",
  importance: "中",
};

describe("recall", () => {
  let envBackup: Record<string, string | undefined>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    envBackup = {
      KAIZEN_RECALL_ENABLED: process.env.KAIZEN_RECALL_ENABLED,
      KB_API_KEY: process.env.KB_API_KEY,
    };
    originalFetch = global.fetch;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    global.fetch = originalFetch;
  });

  it("既定OFF：KAIZEN_RECALL_ENABLED未設定ならfetchせず[]", async () => {
    delete process.env.KAIZEN_RECALL_ENABLED;
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    expect(isRecallEnabled()).toBe(false);
    expect(await recallSimilar(ticket)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ON時はrecall APIを叩き、ヒットを返す（X-API-Key付与）", async () => {
    process.env.KAIZEN_RECALL_ENABLED = "true";
    process.env.KB_API_KEY = "kb-test";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { chunk_id: 1, content: "EXIF回転を正規化して解決", chunk_type: "session", score: 0.9, tags: ["画像"] },
          { chunk_id: 2, content: "", chunk_type: "session", score: 0.5, tags: [] }, // 空contentは除外
        ],
        total: 2,
      }),
    });
    global.fetch = mockFetch;

    const hits = await recallSimilar(ticket);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("EXIF");
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/devin/recall");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("kb-test");
    const body = JSON.parse(init.body);
    expect(body.query).toContain("ほうこちゃん");
    expect(body.top_k).toBe(3);
  });

  it("APIエラー・例外は無言スキップで[]（会話を止めない）", async () => {
    process.env.KAIZEN_RECALL_ENABLED = "true";

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    expect(await recallSimilar(ticket)).toEqual([]);

    global.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
    expect(await recallSimilar(ticket)).toEqual([]);
  });

  it("buildRecallNote：0件はnull、ヒット時は件数と代表例90字以内を含む", () => {
    expect(buildRecallNote([])).toBeNull();
    const note = buildRecallNote([
      { content: "あ".repeat(200), score: 0.9, tags: [] },
      { content: "別の学び", score: 0.5, tags: [] },
    ]);
    expect(note).toContain("2件");
    expect(note).toContain("あ".repeat(90));
    expect(note).not.toContain("あ".repeat(91));
  });
});
