import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordLearning,
  recallLearning,
  isMemoryEnabled,
  type LearningEvent,
} from "../memory";

describe("memory層（統一メモリ＝全体学習の土台）", () => {
  let originalEnabled: string | undefined;
  let originalKey: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnabled = process.env.KNOWHOW_ENABLED;
    originalKey = process.env.KNOWHOW_PROJECT_KEY;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.KNOWHOW_ENABLED;
    else process.env.KNOWHOW_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.KNOWHOW_PROJECT_KEY;
    else process.env.KNOWHOW_PROJECT_KEY = originalKey;
    global.fetch = originalFetch;
  });

  // ── isMemoryEnabled ──
  it("KNOWHOW_ENABLED=true のときだけ有効", () => {
    process.env.KNOWHOW_ENABLED = "true";
    expect(isMemoryEnabled()).toBe(true);
    process.env.KNOWHOW_ENABLED = "false";
    expect(isMemoryEnabled()).toBe(false);
    delete process.env.KNOWHOW_ENABLED;
    expect(isMemoryEnabled()).toBe(false);
  });

  // ── recordLearning：fail-safe ──
  describe("recordLearning", () => {
    it("無効時は fetch を呼ばず false（no-op）", async () => {
      delete process.env.KNOWHOW_ENABLED;
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const ok = await recordLearning({ kind: "decision", summary: "x" });
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("summary が空なら記録しない（ノイズを貯めない）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const ok = await recordLearning({ kind: "decision", summary: "  " });
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("有効時に /api/devin/memorize へ送り、kind/全体学習 タグが付く", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      let url = "";
      let body: any = null;
      global.fetch = vi.fn().mockImplementation((u: string, init: RequestInit) => {
        url = u;
        body = JSON.parse(init.body as string);
        return Promise.resolve({ ok: true });
      });

      const ok = await recordLearning({
        kind: "conversation",
        system: "プロレポ",
        summary: "一覧の表示が遅いという声が複数",
        tags: ["速度"],
      });
      expect(ok).toBe(true);
      expect(url).toContain("/api/devin/memorize");
      expect(body.tags).toContain("全体学習");
      expect(body.tags).toContain("conversation");
      expect(body.tags).toContain("プロレポ");
      expect(body.tags).toContain("速度");
      expect(body.raw_log).toContain("【conversation】");
    });

    it("開発の学びと会話の学びが同じ project_key に貯まる（横断の肝）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      process.env.KNOWHOW_PROJECT_KEY = "cto-lab";
      const keys: string[] = [];
      global.fetch = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
        keys.push(JSON.parse(init.body as string).project_key);
        return Promise.resolve({ ok: true });
      });

      await recordLearning({ kind: "fix_success", summary: "開発の学び" });
      await recordLearning({ kind: "conversation", summary: "会話の学び" });
      expect(keys).toEqual(["cto-lab", "cto-lab"]);
    });

    it("失敗系 kind は status=failed で記録（しくじり先生）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      const statuses: string[] = [];
      global.fetch = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
        statuses.push(JSON.parse(init.body as string).status);
        return Promise.resolve({ ok: true });
      });

      await recordLearning({ kind: "fix_failed", summary: "差し戻された" });
      await recordLearning({ kind: "correction", summary: "違うと言われた" });
      await recordLearning({ kind: "fix_success", summary: "うまくいった" });
      expect(statuses).toEqual(["failed", "failed", "success"]);
    });

    it("status を明示指定したら kind 既定より優先される", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      let status = "";
      global.fetch = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
        status = JSON.parse(init.body as string).status;
        return Promise.resolve({ ok: true });
      });
      await recordLearning({ kind: "fix_failed", summary: "x", status: "success" });
      expect(status).toBe("success");
    });

    it("summary/detail の PII（メール・電話）はマスクされてから送られる", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      let raw = "";
      global.fetch = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
        raw = JSON.parse(init.body as string).raw_log;
        return Promise.resolve({ ok: true });
      });

      const ev: LearningEvent = {
        kind: "conversation",
        summary: "tanaka@example.com から相談",
        detail: "090-1234-5678 に折り返し",
      };
      await recordLearning(ev);
      expect(raw).not.toContain("tanaka@example.com");
      expect(raw).not.toContain("090-1234-5678");
      expect(raw).toContain("[メール]");
      expect(raw).toContain("[電話]");
    });

    it("res.ok=false なら false（例外を投げない）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const ok = await recordLearning({ kind: "decision", summary: "x" });
      expect(ok).toBe(false);
    });

    it("fetch が throw しても false（fail-safe）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      global.fetch = vi.fn().mockRejectedValue(new Error("network"));
      const ok = await recordLearning({ kind: "decision", summary: "x" });
      expect(ok).toBe(false);
    });
  });

  // ── recallLearning：fail-safe ──
  describe("recallLearning", () => {
    it("無効時は fetch を呼ばず []", async () => {
      delete process.env.KNOWHOW_ENABLED;
      const mockFetch = vi.fn();
      global.fetch = mockFetch;
      const hits = await recallLearning("何か");
      expect(hits).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("query が空なら fetch を呼ばず []", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      const mockFetch = vi.fn();
      global.fetch = mockFetch;
      const hits = await recallLearning("   ");
      expect(hits).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("有効時に /api/devin/recall を叩き、結果を整形して返す", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      let url = "";
      global.fetch = vi.fn().mockImplementation((u: string) => {
        url = u;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { content: "過去の学びA", score: 0.9, tags: ["fix_success"] },
              { content: "  ", score: 0.1, tags: [] }, // 空はフィルタされる
            ],
          }),
        });
      });

      const hits = await recallLearning("プロレポ 一覧 遅い");
      expect(url).toContain("/api/devin/recall");
      expect(hits).toHaveLength(1);
      expect(hits[0].content).toBe("過去の学びA");
      expect(hits[0].score).toBe(0.9);
    });

    it("kinds 指定で、その kind タグを含むものだけに絞る（横断記憶からの選別）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { content: "失敗の学び", score: 0.8, tags: ["全体学習", "fix_failed"] },
            { content: "会話の学び", score: 0.7, tags: ["全体学習", "conversation"] },
          ],
        }),
      });

      const hits = await recallLearning("一括出力", { kinds: ["fix_failed"] });
      expect(hits).toHaveLength(1);
      expect(hits[0].content).toBe("失敗の学び");
    });

    it("res.ok=false なら []", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const hits = await recallLearning("x");
      expect(hits).toEqual([]);
    });

    it("fetch が throw（タイムアウト含む）しても []（fail-safe）", async () => {
      process.env.KNOWHOW_ENABLED = "true";
      global.fetch = vi.fn().mockRejectedValue(new Error("aborted"));
      const hits = await recallLearning("x");
      expect(hits).toEqual([]);
    });
  });
});
