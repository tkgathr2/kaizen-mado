import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSpec,
  dispatchEnabled,
  dispatchExecution,
  buildDispatchPayload,
  sanitizeField,
} from "../orchestrate";
import type { TicketRow } from "../tickets";
import type { TargetMeta } from "../targets";

function ticket(): TicketRow {
  return {
    pageId: "page-1",
    ticketId: "KZ-9",
    system: "ステレポ",
    type: "改善",
    importance: "中",
    title: "並び順",
    detail: "新着順にしたい",
    reporter: "現場",
    state: "着手",
    fgsUrl: null,
  };
}

const target: TargetMeta = {
  system: "ステレポ",
  repo: "tkgathr2/sterepo",
  healthUrl: null,
  forbiddenPaths: [".env"],
  autoEligible: true,
};

describe("orchestrate", () => {
  let savedToken: string | undefined;
  let savedFetch: typeof global.fetch;

  beforeEach(() => {
    savedToken = process.env.GITHUB_DISPATCH_TOKEN;
    savedFetch = global.fetch;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = savedToken;
    global.fetch = savedFetch;
  });

  it("buildSpec はチケットID・件名・内容・守ることを含む", () => {
    const s = buildSpec(ticket());
    expect(s).toContain("KZ-9");
    expect(s).toContain("新着順にしたい");
    expect(s).toContain("最小差分");
  });

  it("dispatchEnabled はトークン有無を反映", () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    expect(dispatchEnabled()).toBe(false);
    process.env.GITHUB_DISPATCH_TOKEN = "tok";
    expect(dispatchEnabled()).toBe(true);
  });

  it("トークン未設定なら dispatchしない(false)・fetchを呼ばない", async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const f = vi.fn();
    global.fetch = f as any;
    const ok = await dispatchExecution({ ticket: ticket(), target });
    expect(ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("204応答で true、dispatches APIへ正しいpayloadをPOST", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "tok";
    let captured: { url: string; init: any } | null = null;
    global.fetch = vi.fn().mockImplementation((url: string, init: any) => {
      captured = { url, init };
      return Promise.resolve({ status: 204, text: async () => "" });
    }) as any;

    const ok = await dispatchExecution({ ticket: ticket(), target });
    expect(ok).toBe(true);
    expect(captured!.url).toContain("/dispatches");
    const body = JSON.parse(captured!.init.body);
    expect(body.event_type).toBe("kaizen_execute");
    expect(body.client_payload.ticketId).toBe("KZ-9");
    expect(body.client_payload.targetRepo).toBe("tkgathr2/sterepo");
    expect(body.client_payload.callbackUrl).toContain("/api/execute/callback");
  });

  it("非204応答は false", async () => {
    process.env.GITHUB_DISPATCH_TOKEN = "tok";
    global.fetch = vi.fn().mockResolvedValue({ status: 403, text: async () => "forbidden" }) as any;
    const ok = await dispatchExecution({ ticket: ticket(), target });
    expect(ok).toBe(false);
  });

  it("buildDispatchPayload はActions(plan経路)が使う形を返す", () => {
    const p = buildDispatchPayload(ticket(), target);
    expect(p.ticketId).toBe("KZ-9");
    expect(p.targetRepo).toBe("tkgathr2/sterepo");
    expect(p.forbiddenPaths).toEqual([".env"]);
    expect(p.callbackUrl).toContain("/api/execute/callback");
    expect(p.spec).toContain("KZ-9");
    expect(p.autoMerge).toBe(false); // 既定は自動マージしない
  });

  it("buildDispatchPayload(…, true) で autoMerge=true（真田自走）", () => {
    const p = buildDispatchPayload(ticket(), target, true);
    expect(p.autoMerge).toBe(true);
  });
});
