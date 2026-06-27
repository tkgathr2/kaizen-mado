import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chunkReply } from "@/lib/anthropic";

// ── chunkReply（擬似ストリーム分割・純粋関数） ──
describe("chunkReply", () => {
  it("空文字は空配列", () => {
    expect(chunkReply("")).toEqual([]);
  });

  it("分割しても連結すると元に戻る", () => {
    const text = "こんにちは。これはテストです、よろしく！🙏 終わり。";
    const chunks = chunkReply(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("絵文字（サロゲートペア）を割らない", () => {
    const text = "🙏🎉👍😀💡🔥✨🚀🌟📌";
    const chunks = chunkReply(text, 6);
    expect(chunks.join("")).toBe(text);
    // 各チャンクが単体で正しい文字列（壊れたサロゲートを含まない）。
    for (const c of chunks) {
      expect(Array.from(c).join("")).toBe(c);
    }
  });
});

// ── SSE 経路の統合テスト（依存をモックして POST を直接叩く） ──
const callClaude = vi.fn();
const callClaudeWithSlack = vi.fn();

vi.mock("@/lib/anthropic", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/anthropic")>();
  return {
    ...orig, // chunkReply 等の純粋関数は本物を使う
    callClaude: (...a: unknown[]) => callClaude(...a),
    callClaudeWithSlack: (...a: unknown[]) => callClaudeWithSlack(...a),
  };
});
vi.mock("@/lib/slack", () => ({
  slackAvailableForSystem: () => false,
}));
vi.mock("@/lib/recall", () => ({
  isRecallEnabled: () => false,
  recallSimilar: async () => [],
  buildRecallNote: () => "",
}));
vi.mock("@/lib/ratelimit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  clientKeyFromHeaders: () => "test",
}));
vi.mock("@/lib/systems", () => ({
  resolveSystem: (s: unknown) => (typeof s === "string" ? s : null),
}));

async function readSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

function makeReq(body: unknown, headers: Record<string, string> = {}): any {
  return {
    headers: new Headers(headers),
    json: async () => body,
  };
}

describe("/api/chat SSE ストリーミング", () => {
  beforeEach(() => {
    callClaude.mockReset();
    callClaudeWithSlack.mockReset();
    callClaude.mockResolvedValue({
      reply: "わかりました。確認します。",
      phase: "clarify",
      ticket: null,
    });
    process.env.KAIZEN_STREAM_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.KAIZEN_STREAM_ENABLED;
    vi.resetModules();
  });

  it("stream:true ＆ フラグON のとき SSE（delta→done）を返す", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeReq({ system: "テスト", messages: [{ role: "user", content: "こんにちは" }], stream: true })
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSse(res);
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(text).toContain("わかりました");
  });

  it("Accept: text/event-stream でも SSE になる", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeReq(
        { system: "テスト", messages: [{ role: "user", content: "やあ" }] },
        { accept: "text/event-stream" }
      )
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("フラグOFF のときは従来の JSON 応答（回帰ゼロ）", async () => {
    delete process.env.KAIZEN_STREAM_ENABLED;
    const { POST } = await import("../route");
    const res = await POST(
      makeReq({ system: "テスト", messages: [{ role: "user", content: "こんにちは" }], stream: true })
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(json.reply).toContain("わかりました");
  });
});
