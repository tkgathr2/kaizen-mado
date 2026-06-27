import { describe, it, expect, afterEach } from "vitest";
import { preGate, autopilotEnabled } from "../gate";
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

  // ── 単語境界判定（誤爆修正） ──
  it("英語機微語は単語境界で当たる（escalate）", () => {
    for (const w of ["update password field", "rotate the secret", "send an email", "delete the row", "charge the card"]) {
      const d = preGate(ticket({ title: "改善", detail: w }), eligible);
      expect(d.mode, w).toBe("escalate");
    }
  });

  it("英語機微語の部分一致は誤爆しない（auto）", () => {
    // "auth"→author, "price"→enterprise, "charge"→supercharge, "email"を含まない一般語
    for (const w of ["fix the author byline", "for enterprise customers", "supercharge the loader", "improve the dropdown layout"]) {
      const d = preGate(ticket({ title: "改善", detail: w }), eligible);
      expect(d.mode, w).toBe("auto");
    }
  });

  it('"api key" は語間空白を許容して当たる', () => {
    const d = preGate(ticket({ detail: "rotate the api key" }), eligible);
    expect(d.mode).toBe("escalate");
  });

  // ── 屈折形（複数形・過去/進行形）も機微語として捕捉する（安全側の取りこぼし防止） ──
  it("英語機微語の屈折形（payments/charged/deleted等）も escalate", () => {
    for (const w of [
      "the customer was charged twice",
      "deleted records aren't showing",
      "payments page is broken",
      "refunded amount is wrong",
      "invoices list is empty",
      "migrated the table yesterday",
    ]) {
      const d = preGate(ticket({ title: "改善", detail: w }), eligible);
      expect(d.mode, w).toBe("escalate");
    }
  });

  it("屈折形対応後も無関係語は誤爆しない（auto）", () => {
    // 先頭の単語境界は維持＝author/enterprise/supercharge/dropdown は依然ヒットしない
    for (const w of ["fix the author byline", "for enterprise customers", "supercharge the loader", "improve the dropdown layout"]) {
      const d = preGate(ticket({ title: "改善", detail: w }), eligible);
      expect(d.mode, w).toBe("auto");
    }
  });

  // ── 語幹（stem）追加：bill / pay / delet を取りこぼさない ──
  it("語幹 bill/pay/delet の派生は機微として escalate", () => {
    for (const w of [
      "the bill amount is wrong",       // bill
      "billing page broken",            // bill→billing
      "pay button does nothing",        // pay
      "payment failed",                 // pay→payment（payment は屈折表でも当たる）
      "payout schedule is off",         // pay→payout
      "delete the user",                // delet→delete
      "deletion of records failed",     // delet→deletion（屈折表では取りこぼす形）
      "deleted rows still show",        // delet→deleted
      "deleting is too slow",           // delet→deleting
      "deletes everything",             // delet→deletes
    ]) {
      const d = preGate(ticket({ title: "改善", detail: w }), eligible);
      expect(d.mode, w).toBe("escalate");
    }
  });

  it("語幹 pay/bill 追加でも語頭境界で無関係語は誤検知しない（auto）", () => {
    // display/player の "play"、repay の "pay" は語頭境界が無いのでヒットしない。
    for (const w of [
      "fix the display order",     // display（playを含むが語頭でない）
      "player list is empty",      // player（playを含むが pay ではない）
      "repay flow needs polish",   // repay（語中の pay は \b で当たらない）
    ]) {
      const d = preGate(ticket({ title: "改善", detail: w }), eligible);
      expect(d.mode, w).toBe("auto");
    }
  });

  it("日本語機微語は部分一致のまま当たる（境界化しない）", () => {
    const d = preGate(ticket({ detail: "口座情報の表示" }), eligible);
    expect(d.mode).toBe("escalate");
  });

  it("detail が undefined でも 'undefined' を機微語誤検知しない", () => {
    const t = ticket({ title: "一覧を見やすく" });
    // detail を強制的に undefined に
    (t as any).detail = undefined;
    const d = preGate(t, eligible);
    expect(d.mode).toBe("auto");
    expect(d.reasons).toHaveLength(0);
  });
});

describe("autopilotEnabled（真田自走スイッチ）", () => {
  const saved = process.env.KAIZEN_AUTOPILOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.KAIZEN_AUTOPILOT;
    else process.env.KAIZEN_AUTOPILOT = saved;
  });
  it("既定OFF（フェイルクローズ）。on/1/true/yes のときだけ有効", () => {
    delete process.env.KAIZEN_AUTOPILOT;
    expect(autopilotEnabled()).toBe(false); // 既定OFF（未設定＝無人自動実行しない）
    process.env.KAIZEN_AUTOPILOT = "";
    expect(autopilotEnabled()).toBe(false); // 空もOFF
    process.env.KAIZEN_AUTOPILOT = "on";
    expect(autopilotEnabled()).toBe(true);
    process.env.KAIZEN_AUTOPILOT = "1";
    expect(autopilotEnabled()).toBe(true);
    process.env.KAIZEN_AUTOPILOT = "true";
    expect(autopilotEnabled()).toBe(true);
    process.env.KAIZEN_AUTOPILOT = "yes";
    expect(autopilotEnabled()).toBe(true);
    process.env.KAIZEN_AUTOPILOT = "off";
    expect(autopilotEnabled()).toBe(false);
    process.env.KAIZEN_AUTOPILOT = "0";
    expect(autopilotEnabled()).toBe(false);
    process.env.KAIZEN_AUTOPILOT = "false";
    expect(autopilotEnabled()).toBe(false);
    process.env.KAIZEN_AUTOPILOT = "garbage";
    expect(autopilotEnabled()).toBe(false); // 不明値は安全側OFF
  });
});
