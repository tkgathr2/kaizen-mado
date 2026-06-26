import { describe, it, expect } from "vitest";
import { dedupKey, shouldAccept, acceptSubmit, DEDUP_WINDOW_MS } from "../dedup";
import type { Ticket } from "../types";

function t(over: Partial<Ticket> = {}): Ticket {
  return {
    system: "ほうこちゃん",
    type: "改善",
    title: "写真が横倒しになる",
    detail: "スマホ写真がPDFで回転してしまう",
    importance: "中",
    ...over,
  };
}

describe("dedup（二重起票ガード）", () => {
  it("同一起票者＋同一内容は同じキーになる（前後空白・大小・全半角を正規化）", () => {
    const a = dedupKey(t({ title: "  写真が横倒し  " }), "高木");
    const b = dedupKey(t({ title: "写真が横倒し" }), " 高木 ");
    expect(a).toBe(b);
  });

  it("内容が違えばキーは変わる", () => {
    expect(dedupKey(t({ detail: "A" }), "高木")).not.toBe(dedupKey(t({ detail: "B" }), "高木"));
  });

  it("起票者が違えばキーは変わる", () => {
    expect(dedupKey(t(), "高木")).not.toBe(dedupKey(t(), "脇本"));
  });

  it("reporter が null でもキーを作れる", () => {
    expect(() => dedupKey(t(), null)).not.toThrow();
    expect(dedupKey(t(), null)).toBe(dedupKey(t(), ""));
  });

  it("窓内の同一連打は2回目以降を弾く（1回目だけ受理）", () => {
    const seen = new Map<string, number>();
    const key = dedupKey(t(), "高木");
    expect(shouldAccept(seen, key, 1000)).toBe(true); // 1回目：受理
    expect(shouldAccept(seen, key, 1500)).toBe(false); // 連打：弾く
    expect(shouldAccept(seen, key, 9000)).toBe(false); // 窓内：弾く
  });

  it("窓を越えれば再び受理する（同じ人が後でまた送れる）", () => {
    const seen = new Map<string, number>();
    const key = dedupKey(t(), "高木");
    expect(shouldAccept(seen, key, 0)).toBe(true);
    expect(shouldAccept(seen, key, DEDUP_WINDOW_MS + 1)).toBe(true);
  });

  it("別内容は弾かれない（正当な複数起票は通す）", () => {
    const seen = new Map<string, number>();
    expect(shouldAccept(seen, dedupKey(t({ detail: "A" }), "高木"), 100)).toBe(true);
    expect(shouldAccept(seen, dedupKey(t({ detail: "B" }), "高木"), 200)).toBe(true);
  });
});

describe("acceptSubmit（匿名はdedupスキップ＝常に受理）", () => {
  it("匿名（reporter=null）の同一短文連投は両方受理される（別人の声を消さない）", () => {
    // 同じ短文を続けて匿名で投げても、後の起票が無言で消えない。
    expect(acceptSubmit(t(), null, 1000)).toBe(true);
    expect(acceptSubmit(t(), null, 1001)).toBe(true);
  });

  it("匿名（reporter=空白のみ）も常に受理される", () => {
    expect(acceptSubmit(t(), "   ", 2000)).toBe(true);
    expect(acceptSubmit(t(), "", 2001)).toBe(true);
  });

  it("記名起票は従来どおりサーバ側でも連打を弾く", () => {
    const who = "脇本-" + Math.random().toString(36).slice(2); // テスト間でキー衝突しないよう一意化
    expect(acceptSubmit(t(), who, 3000)).toBe(true);  // 1回目：受理
    expect(acceptSubmit(t(), who, 3100)).toBe(false); // 連打：弾く
  });
});
