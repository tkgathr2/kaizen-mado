import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  jstHour,
  jstMinute,
  encodeQueue,
  decodeQueue,
  encodeSent,
  decodeSent,
  dedupeLatest,
  filterSuppressed,
  buildDigestText,
  enqueueNotification,
  runDailyNotificationBatch,
  __setDigestStoreForTest,
  type DigestStore,
  type DigestBlock,
  type QueuedNotification,
} from "@/lib/notification";

// ── LINE をモック（pushText は実送信させない） ──
const pushMock = vi.fn(async (_t: string) => true);
let lineOn = true;
vi.mock("@/lib/line", () => ({
  pushText: (t: string) => pushMock(t),
  lineEnabled: () => lineOn,
  truncateForLine: (s: string | null | undefined, max: number) => {
    const t = (s || "").trim().replace(/\s+/g, " ");
    return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + "…";
  },
  BOARD_URL: "https://kaizen.example/board",
  actionBanner: (kind: string, action?: string) => `BANNER(${kind}:${action ?? ""})`,
}));

// ── テスト用のインメモリストア ──
class MemStore implements DigestStore {
  blocks: DigestBlock[] = [];
  private seq = 0;
  on = true;
  enabled() {
    return this.on;
  }
  async append(text: string) {
    this.blocks.push({ id: `b${this.seq++}`, text });
  }
  async list() {
    return [...this.blocks];
  }
  async remove(ids: string[]) {
    this.blocks = this.blocks.filter((b) => !ids.includes(b.id));
  }
}

function n(
  ticketId: string,
  type: QueuedNotification["type"],
  message: string,
  createdAt: Date,
  errorSummary?: string
): QueuedNotification {
  return { id: `${ticketId}-${type}`, ticketId, type, message, errorSummary, createdAt };
}

let mem: MemStore;

beforeEach(() => {
  pushMock.mockClear();
  pushMock.mockResolvedValue(true as never);
  lineOn = true;
  mem = new MemStore();
  __setDigestStoreForTest(mem);
});

afterEach(() => {
  __setDigestStoreForTest(null);
});

describe("jstHour / jstMinute", () => {
  it("UTC 23:00 は JST 08:00 になる", () => {
    const d = new Date("2026-07-04T23:00:00Z");
    expect(jstHour(d)).toBe(8);
    expect(jstMinute(d)).toBe(0);
  });
  it("UTC 15:00 は JST 00:00（深夜）になる（h23 で 24 にならない）", () => {
    const d = new Date("2026-07-04T15:00:00Z");
    expect(jstHour(d)).toBe(0);
  });
});

describe("encode / decode", () => {
  it("キュー項目は往復できる", () => {
    const item = n("KZ-1", "completion", "反映しました", new Date("2026-07-04T00:00:00Z"));
    const round = decodeQueue(encodeQueue(item));
    expect(round?.ticketId).toBe("KZ-1");
    expect(round?.type).toBe("completion");
    expect(round?.message).toBe("反映しました");
    expect(round?.createdAt.toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });
  it("プレフィックス無し・壊れたJSONは null", () => {
    expect(decodeQueue("ただの議論ブロック")).toBeNull();
    expect(decodeQueue("⟦KZQ⟧{壊れ")).toBeNull();
  });
  it("未知の type は弾く", () => {
    expect(decodeQueue('⟦KZQ⟧{"t":"KZ-1","y":"unknown"}')).toBeNull();
  });
  it("送信ログは往復できる", () => {
    const enc = encodeSent("KZ-2:error", 1720000000000);
    const dec = decodeSent(enc);
    expect(dec).toEqual({ key: "KZ-2:error", ts: 1720000000000 });
  });
});

describe("dedupeLatest", () => {
  it("同一 ticketId+type は最新だけ残す", () => {
    const older = n("KZ-1", "execution_started", "旧", new Date("2026-07-04T00:00:00Z"));
    const newer = n("KZ-1", "execution_started", "新", new Date("2026-07-04T01:00:00Z"));
    const other = n("KZ-1", "completion", "完了", new Date("2026-07-04T02:00:00Z"));
    const out = dedupeLatest([older, newer, other]);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.type === "execution_started")?.message).toBe("新");
  });
});

describe("filterSuppressed", () => {
  it("直近送信済みキーは落とす", () => {
    const a = n("KZ-1", "completion", "a", new Date());
    const b = n("KZ-2", "completion", "b", new Date());
    const out = filterSuppressed([a, b], new Set(["KZ-1:completion"]));
    expect(out.map((x) => x.ticketId)).toEqual(["KZ-2"]);
  });
});

describe("buildDigestText", () => {
  it("チケットごとにまとめ、種別ラベルとエラー要約を含む", () => {
    const items = [
      n("KZ-1", "completion", "反映しました", new Date()),
      n("KZ-2", "error", "失敗", new Date(), "TypeError: x is undefined"),
    ];
    const text = buildDigestText(items);
    expect(text).toContain("🌅 カイゼン 昨日のうごき（まとめ）");
    expect(text).toContain("● KZ-1");
    expect(text).toContain("✅ 反映済み");
    expect(text).toContain("● KZ-2");
    expect(text).toContain("⚠️ エラー");
    expect(text).toContain("TypeError: x is undefined");
    expect(text).toContain("https://kaizen.example/board");
  });

  it("大量件数でも LINE 5000字上限を超えず、超過分は「…ほか N件」に畳む", () => {
    // 500チケット × completion → 素朴に組むと 5000字を大きく超える。
    const items = Array.from({ length: 500 }, (_, i) =>
      n(`KZ-${i}`, "completion", "本番反映まで完了しました", new Date())
    );
    const text = buildDigestText(items);
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(text).toContain("…ほか");
    // 先頭のチケットは載っている（打ち切りは末尾側）。
    expect(text).toContain("● KZ-0");
  });
});

describe("enqueueNotification", () => {
  it("通常項目はキューに積まれる", async () => {
    await enqueueNotification("KZ-1", "completion", "反映しました");
    expect(mem.blocks).toHaveLength(1);
    expect(decodeQueue(mem.blocks[0].text)?.ticketId).toBe("KZ-1");
  });
  it("error 種別で要約が空／「不明」を含むなら積まない", async () => {
    await enqueueNotification("KZ-1", "error", "失敗", "");
    await enqueueNotification("KZ-2", "error", "失敗", "理由不明です");
    expect(mem.blocks).toHaveLength(0);
  });
  it("error 種別でも実エラー文があれば積む", async () => {
    await enqueueNotification("KZ-3", "error", "失敗", "ReferenceError: foo");
    expect(mem.blocks).toHaveLength(1);
  });
  it("LINE 未設定なら no-op", async () => {
    lineOn = false;
    await enqueueNotification("KZ-1", "completion", "x");
    expect(mem.blocks).toHaveLength(0);
  });
  it("ストア無効なら no-op", async () => {
    mem.on = false;
    await enqueueNotification("KZ-1", "completion", "x");
    expect(mem.blocks).toHaveLength(0);
  });
});

describe("runDailyNotificationBatch", () => {
  it("キューを1通に束ねて送信し、消費＋送信ログ化する", async () => {
    await mem.append(encodeQueue(n("KZ-1", "completion", "反映", new Date())));
    await mem.append(encodeQueue(n("KZ-2", "pr_ready", "PR", new Date())));

    const res = await runDailyNotificationBatch({ force: true });

    expect(res.ok).toBe(true);
    expect(res.sent).toBe(2);
    expect(pushMock).toHaveBeenCalledTimes(1);
    // キューは消え、送信ログ（⟦KZS⟧）だけが残る。
    const queued = mem.blocks.filter((b) => decodeQueue(b.text));
    const sentLog = mem.blocks.filter((b) => decodeSent(b.text));
    expect(queued).toHaveLength(0);
    expect(sentLog).toHaveLength(2);
  });

  it("直近24hに送信済みのキーは再送抑止する", async () => {
    // 送信ログを1時間前に付けておく → 同キーは送らない。
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    await mem.append(encodeSent("KZ-1:completion", oneHourAgo));
    await mem.append(encodeQueue(n("KZ-1", "completion", "反映", new Date())));

    const res = await runDailyNotificationBatch({ force: true });

    expect(res.sent).toBe(0);
    expect(res.skipped).toBe("all-suppressed");
    expect(pushMock).not.toHaveBeenCalled();
    // 抑止されたキューは消費される（溜め込まない）。
    expect(mem.blocks.filter((b) => decodeQueue(b.text))).toHaveLength(0);
  });

  it("同一 ticketId+type の重複は最新1件に畳んで送る", async () => {
    await mem.append(
      encodeQueue(n("KZ-1", "execution_started", "旧", new Date("2026-07-04T00:00:00Z")))
    );
    await mem.append(
      encodeQueue(n("KZ-1", "execution_started", "新", new Date("2026-07-04T05:00:00Z")))
    );

    const res = await runDailyNotificationBatch({ force: true });

    expect(res.sent).toBe(1);
    const body = pushMock.mock.calls[0][0];
    expect(body).toContain("新");
    expect(body).not.toContain("：旧");
  });

  it("送信失敗時はキューを残して次回リトライする（送信ログを付けない）", async () => {
    pushMock.mockResolvedValueOnce(false as never);
    await mem.append(encodeQueue(n("KZ-1", "completion", "反映", new Date())));

    const res = await runDailyNotificationBatch({ force: true });

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("send-failed");
    expect(mem.blocks.filter((b) => decodeQueue(b.text))).toHaveLength(1);
    expect(mem.blocks.filter((b) => decodeSent(b.text))).toHaveLength(0);
  });

  it("送信失敗が続いても48h超の古い送信ログは毎回掃除される", async () => {
    pushMock.mockResolvedValueOnce(false as never);
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await mem.append(encodeSent("KZ-9:completion", threeDaysAgo)); // 古いログ（>48h）
    await mem.append(encodeQueue(n("KZ-1", "completion", "反映", new Date())));

    const res = await runDailyNotificationBatch({ force: true });

    expect(res.skipped).toBe("send-failed");
    // 送信は失敗したが、古い送信ログは掃除され、キューは次回用に残る。
    expect(mem.blocks.filter((b) => decodeSent(b.text))).toHaveLength(0);
    expect(mem.blocks.filter((b) => decodeQueue(b.text))).toHaveLength(1);
  });

  it("キューが空なら送らず empty を返す", async () => {
    const res = await runDailyNotificationBatch({ force: true });
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe("empty");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ストア無効なら disabled", async () => {
    mem.on = false;
    const res = await runDailyNotificationBatch({ force: true });
    expect(res.skipped).toBe("disabled");
  });

  it("LINE 未設定ならキューを消費だけして line-disabled", async () => {
    lineOn = false;
    await mem.append(encodeQueue(n("KZ-1", "completion", "反映", new Date())));
    const res = await runDailyNotificationBatch({ force: true });
    expect(res.skipped).toBe("line-disabled");
    expect(pushMock).not.toHaveBeenCalled();
    expect(mem.blocks.filter((b) => decodeQueue(b.text))).toHaveLength(0);
  });
});
