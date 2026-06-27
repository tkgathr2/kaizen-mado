import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { distillTicket, isDistillEnabled, resolveDistillProvider } from "../distill";
import type { TicketRow } from "../tickets";

const baseRow: TicketRow = {
  pageId: "page-1",
  ticketId: "KZ-10",
  system: "ほうこちゃん",
  type: "改善",
  importance: "中",
  title: "報告書の写真が縦になる",
  detail: "スマホで撮った写真が報告書PDFで横倒しになる。毎回手で直している。",
  reporter: "現場フォーム",
  state: "完了",
  fgsUrl: null,
};

// Anthropic tool_use 応答を模倣
function anthropicResponse(input: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "tool_use", input }] }),
  };
}

// OpenAI chat.completions 応答を模倣
function openaiResponse(obj: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(obj) } }],
    }),
  };
}

// Gemini generateContent 応答を模倣
function geminiResponse(obj: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
    }),
  };
}

const validDistilled = {
  phenomenon: "写真がPDFで横倒しになる",
  cause: "EXIFの回転情報を無視していた",
  action: "PDF生成時にEXIF回転を適用",
  learning: "画像を扱うシステムはEXIF回転の正規化を入力時に行う",
  keywords: ["EXIF", "画像回転", "PDF"],
};

describe("distill", () => {
  let envBackup: Record<string, string | undefined>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    envBackup = {
      KAIZEN_DISTILL_ENABLED: process.env.KAIZEN_DISTILL_ENABLED,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    };
    // 各テスト開始時は全キーをクリア
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    global.fetch = originalFetch;
  });

  // ── isDistillEnabled ──
  it("isDistillEnabled は KAIZEN_DISTILL_ENABLED=true のときだけ true", () => {
    delete process.env.KAIZEN_DISTILL_ENABLED;
    expect(isDistillEnabled()).toBe(false);
    process.env.KAIZEN_DISTILL_ENABLED = "false";
    expect(isDistillEnabled()).toBe(false);
    process.env.KAIZEN_DISTILL_ENABLED = "true";
    expect(isDistillEnabled()).toBe(true);
  });

  // ── resolveDistillProvider ──
  describe("resolveDistillProvider", () => {
    it("全キー無しなら null", () => {
      expect(resolveDistillProvider()).toBeNull();
    });

    it("ANTHROPIC_API_KEY のみ → anthropic", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      expect(resolveDistillProvider()).toBe("anthropic");
    });

    it("OPENAI_API_KEY のみ → openai", () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      expect(resolveDistillProvider()).toBe("openai");
    });

    it("GOOGLE のみ → google", () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
      expect(resolveDistillProvider()).toBe("google");
    });

    it("全キーある場合は anthropic が最優先", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      process.env.OPENAI_API_KEY = "sk-openai-test";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
      expect(resolveDistillProvider()).toBe("anthropic");
    });

    it("Anthropic 無し・OpenAI と Google がある場合は openai が優先", () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
      expect(resolveDistillProvider()).toBe("openai");
    });
  });

  // ── distillTicket：キー無し ──
  it("全キー未設定なら fetch せず null（フォールバック経路）", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    expect(await distillTicket(baseRow)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Anthropic プロバイダ ──
  describe("Anthropic プロバイダ", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    });

    it("正常応答を「事象→原因→対処→学び」の rawLog に整形する", async () => {
      global.fetch = vi.fn().mockResolvedValue(anthropicResponse(validDistilled));

      const result = await distillTicket(baseRow);
      expect(result).not.toBeNull();
      expect(result!.rawLog).toContain("【カイゼンの学び】KZ-10");
      expect(result!.rawLog).toContain("事象: 写真がPDFで横倒しになる");
      expect(result!.rawLog).toContain("原因: EXIFの回転情報を無視していた");
      expect(result!.rawLog).toContain("対処: PDF生成時にEXIF回転を適用");
      expect(result!.rawLog).toContain("学び: 画像を扱うシステムは");
      expect(result!.keywords).toEqual(["EXIF", "画像回転", "PDF"]);
    });

    it("モデル出力にPIIが混ざっても二重マスクで伏字化される", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        anthropicResponse({
          phenomenon: "担当（090-1234-5678）に毎回電話していた",
          cause: "記録なし",
          action: "test@example.com へ自動通知に変更",
          learning: "連絡先の手動運用は自動化する",
        })
      );

      const result = await distillTicket(baseRow);
      expect(result!.rawLog).not.toContain("090-1234-5678");
      expect(result!.rawLog).not.toContain("test@example.com");
      expect(result!.rawLog).toContain("[電話]");
      expect(result!.rawLog).toContain("[メール]");
    });

    it("API失敗・必須欠落・例外はすべて null", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      expect(await distillTicket(baseRow)).toBeNull();

      global.fetch = vi.fn().mockResolvedValue(anthropicResponse({ phenomenon: "x" })); // learning欠落
      expect(await distillTicket(baseRow)).toBeNull();

      global.fetch = vi.fn().mockRejectedValue(new Error("network"));
      expect(await distillTicket(baseRow)).toBeNull();
    });

    it("Anthropic API に x-api-key ヘッダが含まれる", async () => {
      const mockFetch = vi.fn().mockResolvedValue(anthropicResponse(validDistilled));
      global.fetch = mockFetch;

      await distillTicket(baseRow);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("api.anthropic.com");
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
    });
  });

  // ── OpenAI プロバイダ ──
  describe("OpenAI フォールバック（Anthropic キー無し）", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
    });

    it("OpenAI JSON 応答を rawLog に整形する", async () => {
      global.fetch = vi.fn().mockResolvedValue(openaiResponse(validDistilled));

      const result = await distillTicket(baseRow);
      expect(result).not.toBeNull();
      expect(result!.rawLog).toContain("【カイゼンの学び】KZ-10");
      expect(result!.rawLog).toContain("事象: 写真がPDFで横倒しになる");
      expect(result!.rawLog).toContain("学び: 画像を扱うシステムは");
      expect(result!.keywords).toEqual(["EXIF", "画像回転", "PDF"]);
    });

    it("OpenAI API に Bearer ヘッダが含まれる", async () => {
      const mockFetch = vi.fn().mockResolvedValue(openaiResponse(validDistilled));
      global.fetch = mockFetch;

      await distillTicket(baseRow);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("api.openai.com");
      expect((init.headers as Record<string, string>)["authorization"]).toBe(
        "Bearer sk-openai-test"
      );
    });

    it("OpenAI API 失敗は null", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
      expect(await distillTicket(baseRow)).toBeNull();
    });

    it("OpenAI が壊れた JSON を返したら null", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "not-json{" } }],
        }),
      });
      expect(await distillTicket(baseRow)).toBeNull();
    });

    it("learning 欠落は null", async () => {
      global.fetch = vi.fn().mockResolvedValue(openaiResponse({ phenomenon: "x" }));
      expect(await distillTicket(baseRow)).toBeNull();
    });
  });

  // ── Google Gemini プロバイダ ──
  describe("Gemini フォールバック（Anthropic・OpenAI キー無し）", () => {
    beforeEach(() => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test-key";
    });

    it("Gemini JSON 応答を rawLog に整形する", async () => {
      global.fetch = vi.fn().mockResolvedValue(geminiResponse(validDistilled));

      const result = await distillTicket(baseRow);
      expect(result).not.toBeNull();
      expect(result!.rawLog).toContain("【カイゼンの学び】KZ-10");
      expect(result!.rawLog).toContain("事象: 写真がPDFで横倒しになる");
      expect(result!.rawLog).toContain("学び: 画像を扱うシステムは");
    });

    it("Gemini API URL に API キーが含まれる", async () => {
      const mockFetch = vi.fn().mockResolvedValue(geminiResponse(validDistilled));
      global.fetch = mockFetch;

      await distillTicket(baseRow);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("google-test-key");
    });

    it("Gemini API 失敗は null", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      expect(await distillTicket(baseRow)).toBeNull();
    });

    it("Gemini が壊れた JSON を返したら null", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "broken{json" }] } }],
        }),
      });
      expect(await distillTicket(baseRow)).toBeNull();
    });
  });

  // ── プロバイダ優先順の統合確認 ──
  it("Anthropic・OpenAI の両方があるとき Anthropic が呼ばれ OpenAI は呼ばれない", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const mockFetch = vi.fn().mockResolvedValue(anthropicResponse(validDistilled));
    global.fetch = mockFetch;

    const result = await distillTicket(baseRow);
    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("api.anthropic.com");
  });
});
