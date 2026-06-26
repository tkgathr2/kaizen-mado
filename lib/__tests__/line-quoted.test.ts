import { describe, it, expect } from "vitest";
import { recordSentMessage, getQuotedMap } from "../line";

// 引用返信のための「送信メッセージID → チケットID」対応（揮発・best-effort）の単体テスト。
// LINE/Anthropic への実HTTPは飛ばさない（純粋なメモリ操作のみ）。
describe("recordSentMessage / getQuotedMap", () => {
  it("記録したIDがマップに出る", () => {
    recordSentMessage("msg-1", "KZ-10");
    expect(getQuotedMap()["msg-1"]).toBe("KZ-10");
  });

  it("空のmessageId/ticketIdは無視（壊れた対応を作らない）", () => {
    const before = Object.keys(getQuotedMap()).length;
    recordSentMessage("", "KZ-99");
    recordSentMessage("msg-x", "");
    expect(Object.keys(getQuotedMap()).length).toBe(before);
  });

  it("同じmessageIdの再記録は最新のチケットIDで上書き", () => {
    recordSentMessage("msg-2", "KZ-1");
    recordSentMessage("msg-2", "KZ-2");
    expect(getQuotedMap()["msg-2"]).toBe("KZ-2");
  });

  it("上限を超えると古いものから捨てる（簡易LRU・メモリ暴走防止）", () => {
    // 上限(200)を超える件数を入れ、最初に入れたキーが消えていることを確認。
    recordSentMessage("evict-first", "KZ-0");
    for (let i = 0; i < 220; i++) recordSentMessage(`bulk-${i}`, `KZ-${i}`);
    const map = getQuotedMap();
    expect(map["evict-first"]).toBeUndefined();
    // 直近に入れたものは残る
    expect(map["bulk-219"]).toBe("KZ-219");
  });
});
