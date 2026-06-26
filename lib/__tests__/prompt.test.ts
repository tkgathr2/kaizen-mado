import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt";

describe("buildSystemPrompt", () => {
  it("対象システムが分かっていればその名前を埋め込む", () => {
    const p = buildSystemPrompt("プロレポ");
    expect(p).toContain("プロレポ");
    expect(p).toContain("record_turn");
  });

  it("slackオプション無し（既定）では read_slack の説明を出さない", () => {
    const p = buildSystemPrompt("Indeed応募通知");
    expect(p).not.toContain("read_slack");
    expect(p).not.toContain("Slack調査");
  });

  it("slack:true のときだけ read_slack の使い方と安全ルールを足す", () => {
    const p = buildSystemPrompt("Indeed応募通知", { slack: true });
    expect(p).toContain("read_slack");
    expect(p).toContain("チャンネルを指定できない");
    // 公開窓口の安全要件：PIIを返答にもチケットにも含めない、が明記されていること
    expect(p).toContain("個人情報");
  });
});
