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

  // W1：要領よく聞く（最小往復・1〜2問でまとめて・詳しければ即confirm）
  it("最小の往復で要点を取り早めにconfirmへ進む方針が明記されている", () => {
    const p = buildSystemPrompt("プロレポ");
    expect(p).toContain("最小の往復");
    // 一度に1〜2問でまとめて聞く（1問ずつ刻まない）
    expect(p).toContain("1〜2問");
    // 利用者が最初から詳しく書いたら即confirm
    expect(p).toContain("即 confirm");
    // 旧「一度に複数を聞かない」縛りは外れている（要領よく聞くため）
    expect(p).not.toContain("一度に複数を聞かない");
  });
});
