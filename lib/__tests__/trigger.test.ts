import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { kickEndpoint, publicBase } from "../trigger";

describe("trigger", () => {
  let saved: Record<string, string | undefined>;
  let savedFetch: typeof global.fetch;

  beforeEach(() => {
    saved = {
      secret: process.env.CRON_SECRET,
      base: process.env.KAIZEN_PUBLIC_BASE,
      vprod: process.env.VERCEL_PROJECT_PRODUCTION_URL,
      vurl: process.env.VERCEL_URL,
    };
    savedFetch = global.fetch;
    delete process.env.KAIZEN_PUBLIC_BASE;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
  });
  afterEach(() => {
    for (const [k, envk] of [
      ["secret", "CRON_SECRET"],
      ["base", "KAIZEN_PUBLIC_BASE"],
      ["vprod", "VERCEL_PROJECT_PRODUCTION_URL"],
      ["vurl", "VERCEL_URL"],
    ] as const) {
      if (saved[k] === undefined) delete process.env[envk];
      else process.env[envk] = saved[k]!;
    }
    global.fetch = savedFetch;
  });

  it("publicBase：明示 > Vercel > 既定", () => {
    expect(publicBase()).toBe("https://kaizen.takagi.bz");
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "kaizen.example.app/";
    expect(publicBase()).toBe("https://kaizen.example.app");
    process.env.KAIZEN_PUBLIC_BASE = "https://override.test/";
    expect(publicBase()).toBe("https://override.test");
  });

  it("CRON_SECRET未設定なら no-op(false)・fetchを呼ばない", async () => {
    delete process.env.CRON_SECRET;
    const f = vi.fn();
    global.fetch = f as any;
    expect(await kickEndpoint("/api/process")).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("secret設定時：Bearer付きGETを叩き、2xxで true", async () => {
    process.env.CRON_SECRET = "s3cret";
    let captured: { url: string; init: any } | null = null;
    global.fetch = vi.fn().mockImplementation((url: string, init: any) => {
      captured = { url, init };
      return Promise.resolve({ ok: true, status: 200 });
    }) as any;
    const ok = await kickEndpoint("/api/execute");
    expect(ok).toBe(true);
    expect(captured!.url).toBe("https://kaizen.takagi.bz/api/execute");
    expect(captured!.init.method).toBe("GET");
    expect(captured!.init.headers.Authorization).toBe("Bearer s3cret");
  });

  it("非2xxは false（throwしない）", async () => {
    process.env.CRON_SECRET = "s3cret";
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as any;
    expect(await kickEndpoint("/api/process")).toBe(false);
  });

  it("fetch例外でも false（throwしない）", async () => {
    process.env.CRON_SECRET = "s3cret";
    global.fetch = vi.fn().mockRejectedValue(new Error("network")) as any;
    expect(await kickEndpoint("/api/process")).toBe(false);
  });
});
