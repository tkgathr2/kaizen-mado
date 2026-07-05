// ── KZ-50 E2E: LINEトークン401失効 → Slackアラート(persona-relay)配線の検証 ──
//
// シナリオ：
//   1. pushText() が postLine() を呼ぶ
//   2. postLine() が LINE API から 401 を受ける（トークン失効）
//   3. postLine() が notifySlackAlert("401 @ https://api.line.me/... ...") を呼ぶ
//   4. notifySlackAlert() が persona-relay ( /send ) へ POST する
//   5. persona-relay が Slack #system-alerts (C0BD5ESUFMM) へ真田Bot名義で送る
//
// fetch はグローバルにモックし、宛先URL（LINE API / persona-relay）で挙動を分岐させる。
// pushText 経由（手動呼び出し）と /api/line/push 経由（APIルート）の両方で
// 同じアラート配線が動くことを確認する。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SLACK_ALERT_CHANNEL = "C0BD5ESUFMM";

describe("KZ-50: LINE 401 → notifySlackAlert → persona-relay(Slack)", () => {
  let savedEnv: Record<string, string | undefined>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    savedEnv = {
      tok: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      sec: process.env.LINE_CHANNEL_SECRET,
      uid: process.env.LINE_TARGET_USER_ID,
      relayUrl: process.env.PERSONA_RELAY_URL,
      relaySecret: process.env.PERSONA_RELAY_SECRET,
      cronSecret: process.env.CRON_SECRET,
      allowInsecure: process.env.ALLOW_INSECURE_CRON,
    };
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.LINE_CHANNEL_SECRET = "test-secret";
    process.env.LINE_TARGET_USER_ID = "Utestuser";
    process.env.PERSONA_RELAY_URL = "https://persona-relay.example.com";
    process.env.PERSONA_RELAY_SECRET = "test-relay-secret";
    delete process.env.CRON_SECRET;
    process.env.ALLOW_INSECURE_CRON = "1";

    // fetch を差し替え：LINE push endpoint には 401、persona-relay の /send には成功を返す。
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.line.me")) {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ message: "Authentication failed" }),
          json: async () => ({}),
        } as Response;
      }
      if (u.includes("persona-relay.example.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1234567890.000100" }),
        } as Response;
      }
      throw new Error(`unexpected fetch url: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const [k, envk] of [
      ["tok", "LINE_CHANNEL_ACCESS_TOKEN"],
      ["sec", "LINE_CHANNEL_SECRET"],
      ["uid", "LINE_TARGET_USER_ID"],
      ["relayUrl", "PERSONA_RELAY_URL"],
      ["relaySecret", "PERSONA_RELAY_SECRET"],
      ["cronSecret", "CRON_SECRET"],
      ["allowInsecure", "ALLOW_INSECURE_CRON"],
    ] as const) {
      if (savedEnv[k] === undefined) delete process.env[envk];
      else process.env[envk] = savedEnv[k]!;
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("手動 pushText() 呼び出し：401検知 → notifySlackAlert が persona-relay へPOSTする", async () => {
    const { pushText } = await import("../line");

    const ok = await pushText("テスト送信");

    // postLine は401時 null を返すため pushText は false（成功扱いにしない）。
    expect(ok).toBe(false);

    // 1) LINE push endpoint が401で呼ばれている
    const lineCall = fetchMock.mock.calls.find(([u]) => String(u).includes("api.line.me"));
    expect(lineCall).toBeDefined();

    // 2) persona-relay の /send が呼ばれている（notifySlackAlert 経由）
    const relayCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("persona-relay.example.com")
    );
    expect(relayCall).toBeDefined();
    const [relayUrl, relayInit] = relayCall!;
    expect(String(relayUrl)).toBe("https://persona-relay.example.com/send");

    // 3) リクエストヘッダーに relay secret が乗っている
    const headers = (relayInit as RequestInit).headers as Record<string, string>;
    expect(headers["x-relay-secret"]).toBe("test-relay-secret");

    // 4) ボディ：宛先チャンネルが system-alerts、本文に "401" とLINEエンドポイントを含む
    const body = JSON.parse((relayInit as RequestInit).body as string);
    expect(body.channel).toBe(SLACK_ALERT_CHANNEL);
    expect(body.persona).toBe("sanada");
    expect(body.text).toContain("401");
    expect(body.text).toContain("https://api.line.me/v2/bot/message/push");
  });

  it("notifySlackAlert を直接呼んでも persona-relay へ同じ形でPOSTする", async () => {
    const { notifySlackAlert } = await import("../line");

    const ok = await notifySlackAlert("401 @ https://api.line.me/v2/bot/message/push テスト詳細");
    expect(ok).toBe(true);

    const relayCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("persona-relay.example.com")
    );
    expect(relayCall).toBeDefined();
    const body = JSON.parse((relayCall![1] as RequestInit).body as string);
    expect(body.channel).toBe(SLACK_ALERT_CHANNEL);
    expect(body.persona).toBe("sanada");
    expect(body.text).toContain("401");
  });

  it("PERSONA_RELAY_URL/SECRET 未設定なら fail-safe で何もしない（Slackへ飛ばない）", async () => {
    delete process.env.PERSONA_RELAY_URL;
    delete process.env.PERSONA_RELAY_SECRET;
    const { pushText } = await import("../line");

    const ok = await pushText("テスト送信2");
    expect(ok).toBe(false);

    // persona-relay 宛のPOSTは一切発生しない
    const relayCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("persona-relay.example.com")
    );
    expect(relayCall).toBeUndefined();
  });

  it("/api/line/push ルート経由でも pushText→postLine→401検知→notifySlackAlert が動く", async () => {
    const { POST } = await import("../../app/api/line/push/route");

    const req = {
      headers: { get: () => null },
      json: async () => ({ text: "APIルート経由のテスト送信" }),
    } as unknown as import("next/server").NextRequest;

    const res = await POST(req);
    const json = await res.json();

    // pushText が false を返すため、ルートは 502（LINE送信失敗）を返す。
    expect(res.status).toBe(502);
    expect(json.error).toBe("LINE send failed");

    // それでも persona-relay へのアラートは飛んでいる（副作用として独立に検証）。
    const relayCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("persona-relay.example.com")
    );
    expect(relayCall).toBeDefined();
    const body = JSON.parse((relayCall![1] as RequestInit).body as string);
    expect(body.channel).toBe(SLACK_ALERT_CHANNEL);
    expect(body.text).toContain("401");
  });
});
