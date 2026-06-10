import { describe, it, expect } from "vitest";
import { preGate } from "../gate";
import type { TicketRow } from "../tickets";
import type { TargetMeta } from "../targets";

function ticket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    pageId: "p1",
    ticketId: "KZ-1",
    system: "ステレポ",
    type: "改善",
    importance: "中",
    title: "一覧を見やすく",
    detail: "並び順を変えたい",
    reporter: "現場",
    state: "着手",
    fgsUrl: null,
    ...over,
  };
}

const eligible: TargetMeta = {
  system: "ステレポ",
  repo: "tkgathr2/sterepo",
  healthUrl: null,
  forbiddenPaths: [".env"],
  autoEligible: true,
};

describe("preGate", () => {
  it("対象未定義(null)は escalate", () => {
    expect(preGate(ticket(), null).mode).toBe("escalate");
  });

  it("autoEligible=false は escalate", () => {
    const t = { ...eligible, autoEligible: false };
    const d = preGate(ticket(), t);
    expect(d.mode).toBe("escalate");
    expect(d.reasons.join()).toContain("未許可");
  });

  it("repo未確定は escalate", () => {
    const t = { ...eligible, repo: null };
    expect(preGate(ticket(), t).mode).toBe("escalate");
  });

  it("新機能は escalate", () => {
    expect(preGate(ticket({ type: "新機能" }), eligible).mode).toBe("escalate");
  });

  it("機微キーワード（請求）は escalate", () => {
    const d = preGate(ticket({ detail: "請求金額の計算を直して" }), eligible);
    expect(d.mode).toBe("escalate");
    expect(d.reasons.join()).toContain("機微");
  });

  it("適格＋改善＋非機微は auto", () => {
    const d = preGate(ticket(), eligible);
    expect(d.mode).toBe("auto");
    expect(d.reasons).toHaveLength(0);
  });
});
