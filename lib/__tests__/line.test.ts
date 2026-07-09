import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  lineEnabled,
  isAuthorizedUser,
  verifyLineSignature,
  proposalToken,
  verifyProposalToken,
  parsePostback,
  parseTextCommand,
  buildProposalText,
} from "../line";
import type { TicketRow } from "../tickets";
import type { DiscussResult } from "../discuss";

const SECRET = "test-channel-secret";
const USER = "U1234567890abcdef";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("line（純関数）", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      tok: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      sec: process.env.LINE_CHANNEL_SECRET,
      uid: process.env.LINE_TARGET_USER_ID,
    };
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.LINE_CHANNEL_SECRET = SECRET;
    process.env.LINE_TARGET_USER_ID = USER;
  });

  afterEach(() => {
    for (const [k, envk] of [
      ["tok", "LINE_CHANNEL_ACCESS_TOKEN"],
      ["sec", "LINE_CHANNEL_SECRET"],
      ["uid", "LINE_TARGET_USER_ID"],
    ] as const) {
      if (saved[k] === undefined) delete process.env[envk];
      else process.env[envk] = saved[k]!;
    }
  });

  it("lineEnabled は3鍵が揃ったときだけ true", () => {
    expect(lineEnabled()).toBe(true);
    delete process.env.LINE_TARGET_USER_ID;
    expect(lineEnabled()).toBe(false);
  });

  it("isAuthorizedUser は本人のみ true", () => {
    expect(isAuthorizedUser(USER)).toBe(true);
    expect(isAuthorizedUser("Uother")).toBe(false);
    expect(isAuthorizedUser(null)).toBe(false);
    expect(isAuthorizedUser(undefined)).toBe(false);
  });

  it("verifyLineSignature は正しい署名のみ true", () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(body, sign(body))).toBe(true);
    expect(verifyLineSignature(body, sign(body, "wrong-secret"))).toBe(false);
    expect(verifyLineSignature(body, null)).toBe(false);
    expect(verifyLineSignature(body, "garbage")).toBe(false);
  });

  it("proposalToken / verifyProposalToken は往復一致、別pageId・改ざんは false、長さ32hex", () => {
    const pid = "page-abc-123";
    const tk = proposalToken(pid);
    expect(tk).toHaveLength(32); // 64bit(16hex)→128bit(32hex)に延長
    expect(verifyProposalToken(pid, tk)).toBe(true);
    expect(verifyProposalToken("other-page", tk)).toBe(false);
    expect(verifyProposalToken(pid, tk.slice(0, 31) + "0")).toBe(false);
    expect(verifyProposalToken(pid, "")).toBe(false);
  });

  it("proposalToken は state を混ぜる：状態が変わるとトークンが変わり、旧状態トークンは失効（事実上ワンタイム）", () => {
    const pid = "page-xyz-999";
    // 既定（"GO待ち"）で発行したトークン
    const tkGoMachi = proposalToken(pid);
    // state を明示しても既定と同じ（提案は GO待ち で発行される）
    expect(proposalToken(pid, "GO待ち")).toBe(tkGoMachi);
    // 状態が変われば別トークン
    const tkChakushu = proposalToken(pid, "着手");
    const tkReject = proposalToken(pid, "却下");
    expect(tkChakushu).not.toBe(tkGoMachi);
    expect(tkReject).not.toBe(tkGoMachi);
    // 検証も状態と一致したときだけ true
    expect(verifyProposalToken(pid, tkGoMachi, "GO待ち")).toBe(true);
    expect(verifyProposalToken(pid, tkGoMachi)).toBe(true); // 既定=GO待ち
    // GO/却下で状態が変わったあと、GO待ちで発行した旧トークンは失効する
    expect(verifyProposalToken(pid, tkGoMachi, "着手")).toBe(false);
    expect(verifyProposalToken(pid, tkGoMachi, "却下")).toBe(false);
    expect(verifyProposalToken(pid, tkGoMachi, "差し戻し")).toBe(false);
  });

  it("parsePostback は kz/pid/tk を抽出、不正は null", () => {
    const tk = proposalToken("p1");
    expect(parsePostback(`kz=go&pid=p1&tk=${tk}`)).toEqual({ action: "go", pageId: "p1", token: tk });
    expect(parsePostback("kz=fix&pid=p2&tk=x")).toEqual({ action: "fix", pageId: "p2", token: "x" });
    expect(parsePostback("kz=reject&pid=p3&tk=x")?.action).toBe("reject");
    expect(parsePostback("kz=unknown&pid=p1&tk=x")).toBeNull();
    expect(parsePostback("pid=p1&tk=x")).toBeNull(); // kzなし
    expect(parsePostback("kz=go&tk=x")).toBeNull(); // pidなし
    expect(parsePostback(null)).toBeNull();
  });

  it("parseTextCommand：GO/却下/修正を判定、雑談は null", () => {
    expect(parseTextCommand("GO KZ-12")).toEqual({ action: "go", ticketId: "KZ-12", body: "" });
    expect(parseTextCommand("ok kz-7")).toEqual({ action: "go", ticketId: "KZ-7", body: "" });
    expect(parseTextCommand("却下 KZ-3")).toEqual({ action: "reject", ticketId: "KZ-3", body: "" });
    expect(parseTextCommand("修正して")).toEqual({ action: "fix", ticketId: null, body: "" });
    expect(parseTextCommand("GO")).toEqual({ action: "go", ticketId: null, body: "" });
    expect(parseTextCommand("今日は寒いね")).toBeNull();
    expect(parseTextCommand("")).toBeNull();
    expect(parseTextCommand(null)).toBeNull();
  });

  it("parseTextCommand：修正本文(body)を抽出する（コマンド語・ID除去）", () => {
    expect(parseTextCommand("修正 KZ-12 ボタンの色を青に直して")).toEqual({
      action: "fix",
      ticketId: "KZ-12",
      body: "ボタンの色を青に直して",
    });
    // ID表記揺れ・区切り記号も除去して本文だけ残す
    expect(parseTextCommand("修正KZ12、一覧を新着順にして")).toEqual({
      action: "fix",
      ticketId: "KZ-12",
      body: "一覧を新着順にして",
    });
    // ID無し＋本文
    expect(parseTextCommand("修正 文言をやわらかく")).toEqual({
      action: "fix",
      ticketId: null,
      body: "文言をやわらかく",
    });
    // GO/却下にも本文が付けば拾う（保存はfix時のみだが抽出は一貫させる）
    expect(parseTextCommand("却下 KZ-3 今回は見送り")).toEqual({
      action: "reject",
      ticketId: "KZ-3",
      body: "今回は見送り",
    });
  });

  it("buildProposalText はID・対象・推奨・返信ガイドを含む", () => {
    const ticket = {
      pageId: "p1",
      ticketId: "KZ-12",
      system: "プロレポ",
      type: "改善",
      importance: "高",
      title: "一覧が重い",
      detail: "...",
      reporter: "現場",
      state: "GO待ち",
      fgsUrl: null,
    } as TicketRow;
    const d: DiscussResult = {
      houshin: "ページングを導入",
      steps: ["①一覧にページングを追加", "②並び順テストを足す"],
      kousuu: "1〜2日",
      risks: ["既存ソート互換"],
      importance: "高",
      urgency: "中",
      recommendation: "GO推奨",
      goDraft: "...",
      problemPlain: "一覧が重くて開くのが遅い",
      fixPlain: ["表示を軽くする", "並び順を確かめる"],
      riskPlain: "今の並び順がずれないか確認します",
      source: "claude",
    };
    const text = buildProposalText(ticket, d);
    expect(text).toContain("KZ-12");
    expect(text).toContain("プロレポ");
    expect(text).toContain("GO推奨");
    expect(text).toContain("GO KZ-12");
    expect(text).toContain("https://www.notion.so/p1");
    // 読みやすさ改修（2026-06-27）：素人語の見出し＋空行レイアウト
    expect(text).toContain("❓ こまりごと");
    expect(text).toContain("一覧が重くて開くのが遅い");
    expect(text).toContain("🔧 直し方");
    expect(text).toContain("・表示を軽くする");
    expect(text).toContain("⚠ 気をつけること");
    expect(text).toContain("今の並び順がずれないか確認します");
    expect(text).toContain("📊 重要度 高／緊急度 中");
    // GO/修正/却下 とID付き返信ガイドを含む
    expect(text).toContain("GO ／ 修正 ／ 却下");
    expect(text).toContain("GO KZ-12");
    // mid-word の「…ほか○件」ぶつ切りは出さない
    expect(text).not.toContain("…ほか");
    // セクション間に空行（余白）がある
    expect(text).toContain("\n\n❓ こまりごと");
    // 社長要望「誰から来たか分かるようにしてほしい」対応（2026-07-08）
    expect(text).toContain("👤 誰から：現場");
  });

  // 社長指示 2026-07-09「SlackのIDではなくて名前にして」：生の <@U…> を出さない
  it("buildProposalText：起票者が生のSlackメンションでもIDを表示しない", () => {
    const savedNames = process.env.KAIZEN_SLACK_USER_NAMES;
    process.env.KAIZEN_SLACK_USER_NAMES = "U0AR8F63YBA:西村克人";
    try {
    const base = {
      pageId: "p2", ticketId: "KZ-72", system: "ほうこちゃん", type: "新機能",
      importance: "中", title: "御中欄を手入力に", detail: "d", state: "GO待ち", fgsUrl: null,
    };
    const d: DiscussResult = {
      houshin: "御中欄を入力式にする", steps: ["①入力欄化"], kousuu: "1〜2日",
      risks: [], importance: "中", urgency: "中", recommendation: "GO推奨",
      goDraft: "...", problemPlain: "御中が固定", fixPlain: ["手入力にする"],
      riskPlain: "空欄印刷の崩れ", source: "claude",
    };
    // 既知ユーザー → 名前で表示
    const known = buildProposalText(
      { ...base, reporter: "Slack:<@U0AR8F63YBA>" } as TicketRow, d
    );
    expect(known).toContain("👤 誰から：西村克人");
    expect(known).not.toContain("U0AR8F63YBA");
    // 未知ユーザー → 生IDを出さず読める表記
    const unknown = buildProposalText(
      { ...base, reporter: "Slack:<@UZZ9NOTINMAP>" } as TicketRow, d
    );
    expect(unknown).toContain("👤 誰から：Slackの方（お名前未登録）");
    expect(unknown).not.toContain("UZZ9NOTINMAP");
    } finally {
      if (savedNames === undefined) delete process.env.KAIZEN_SLACK_USER_NAMES;
      else process.env.KAIZEN_SLACK_USER_NAMES = savedNames;
    }
  });

  // plain が空なら houshin/steps/risks へフォールバックして破綻しない
  it("buildProposalText：plain無しは houshin/steps/risks にフォールバック", () => {
    const ticket = {
      pageId: "p9", ticketId: "KZ-9", system: "プロレポ", type: "改善",
      importance: "中", title: "t", detail: "d", reporter: "現場", state: "GO待ち", fgsUrl: null,
    } as TicketRow;
    const d: DiscussResult = {
      houshin: "ここを直す方針です",
      steps: ["①該当箇所を直す"],
      kousuu: "半日",
      risks: [],
      importance: "低",
      urgency: "低",
      recommendation: "要検討",
      goDraft: "",
      problemPlain: "",
      fixPlain: [],
      riskPlain: "",
      source: "fallback",
    };
    const text = buildProposalText(ticket, d);
    // problemPlain 空 → title/houshin から
    expect(text).toContain("❓ こまりごと");
    // fixPlain 空 → steps から
    expect(text).toContain("・①該当箇所を直す");
    // riskPlain 空・risks 空 → 特になし
    expect(text).toContain("特になし");
  });
});

import { buildNextStepLines } from "../line";

describe("buildNextStepLines（社長案件の具体的な次の一手・W5）", () => {
  it("PCのClaude Codeへ貼れる指示文の雛形（system/titleから）を出す", () => {
    const lines = buildNextStepLines(
      { system: "プロレポ", title: "一覧が重い" },
      ["repo未確定"]
    );
    const text = lines.join("\n");
    expect(text).toContain("Claude Code");
    expect(text).toContain("プロレポ");
    expect(text).toContain("一覧が重い");
    expect(text).toContain("真田");
  });

  it("認証切れ系の理由なら復旧の暫定手順を添える", () => {
    const lines = buildNextStepLines(
      { system: "ほうこちゃん", title: "通知が来ない" },
      ["認証情報の再設定が必要"]
    );
    const text = lines.join("\n");
    expect(text).toContain("暫定対応");
    expect(text).toContain("再ログイン");
    // 認証以外の理由のときは暫定対応行を出さない
    const noAuth = buildNextStepLines({ system: "ほうこちゃん", title: "x" }, ["repo未確定"]);
    expect(noAuth.join("\n")).not.toContain("暫定対応");
  });

  it("system/title が空でも既定文言で落ちない", () => {
    const lines = buildNextStepLines({}, []);
    const text = lines.join("\n");
    expect(text).toContain("該当リポ");
    expect(text).toContain("この件");
  });
});

import { truncateForLine, notionPageUrl } from "../line";

describe("文面ヘルパ", () => {
  it("truncateForLine は改行を保持し連続空白を1つに潰して max 文字に丸める", () => {
    expect(truncateForLine("あいうえお", 10)).toBe("あいうえお");
    // 実装は「改行は保持・連続空白は1スペース」（lib/line.ts の意図コメント準拠）
    expect(truncateForLine("あい\nうえ  お", 10)).toBe("あい\nうえ お");
    expect(truncateForLine("あいうえおかきくけこさ", 10)).toBe("あいうえおかきくけ…");
    expect(truncateForLine(null, 5)).toBe("");
  });
  it("notionPageUrl はハイフン無しのURLを返す", () => {
    expect(notionPageUrl("37b0d980-8b3b-8148-9721-e1fa84498c34")).toBe(
      "https://www.notion.so/37b0d9808b3b81489721e1fa84498c34"
    );
  });
});

import { stageBar } from "../line";

describe("工程ステッパー stageBar", () => {
  it("いまの工程を🔵、過去を✅、未来を・で示す（全6工程）", () => {
    const bar = stageBar(4);
    // ①声②提案③GO は完了、④着手がいまここ、⑤PR⑥反映はこれから
    expect(bar).toContain("✅声");
    expect(bar).toContain("✅提案");
    expect(bar).toContain("✅GO");
    expect(bar).toContain("🔵着手");
    expect(bar).toContain("・PR");
    expect(bar).toContain("・反映");
  });
  it("最終工程(6=反映)は全完了の手前まで✅、反映が🔵", () => {
    const bar = stageBar(6);
    expect(bar).toContain("✅PR");
    expect(bar).toContain("🔵反映");
    expect(bar).not.toContain("・");
  });
  it("提案文は主題（システム）が先頭、工程バー・リンクは後ろ", () => {
    const t = {
      pageId: "p1", ticketId: "KZ-20", system: "プロレポ", type: "改善",
      importance: "低", title: "一覧を新着順に", detail: "y", reporter: "現場",
      state: "GO待ち", fgsUrl: null,
    } as TicketRow;
    const d: DiscussResult = {
      houshin: "a", steps: [], kousuu: "b", risks: [],
      importance: "中", urgency: "低", recommendation: "GO推奨", goDraft: "",
      problemPlain: "一覧を新着順にしたい", fixPlain: ["並び順を新着順に変える"], riskPlain: "特になし",
      source: "claude",
    };
    const text = buildProposalText(t, d);
    const lines = text.split("\n");
    // 1行目=「あなた待ち」バナー（対応要否を最上段で示す・社長要望2026-07-08）
    expect(lines[0]).toContain("あなた待ち");
    // その直後にやさしいシステム名と「カイゼンの提案」が続く
    expect(lines[2]).toContain("プロレポ");
    expect(lines[3]).toContain("提案");
    // こまりごとに plain が出る
    expect(text).toContain("一覧を新着順にしたい");
    // 工程バーとリンクは存在しつつ、主題より後ろ
    expect(text).toContain("🔵提案");
    expect(text).toContain("/board");
    expect(text.indexOf("プロレポ")).toBeLessThan(text.indexOf("📍"));
    // バナーが主題より前にある
    expect(text.indexOf("あなた待ち")).toBeLessThan(text.indexOf("プロレポ"));
  });
});

import { msgHead, systemLabel, actionBanner } from "../line";

describe("actionBanner（対応要否バナー）", () => {
  it("reply/tap は『あなた待ち』＋具体アクション、fyi は『お知らせ』", () => {
    expect(actionBanner("reply", "直していい？を決めてください")).toBe(
      "🟢 あなた待ち → 直していい？を決めてください"
    );
    expect(actionBanner("tap", "Mergeボタンを1回タップ")).toBe(
      "🟢 あなた待ち → Mergeボタンを1回タップ"
    );
    expect(actionBanner("fyi", "真田が対応中・操作は要りません")).toBe(
      "⚪ お知らせ（真田が対応中・操作は要りません）"
    );
  });
  it("action 未指定でも既定の文言でフォールバックする", () => {
    expect(actionBanner("reply")).toContain("LINEで返信");
    expect(actionBanner("tap")).toContain("ボタンを1回タップ");
    expect(actionBanner("fyi")).toContain("操作は要りません");
  });
});

describe("systemLabel（やさしいシステム名）", () => {
  it("既知システムはやさしい説明つき、未知はそのまま", () => {
    expect(systemLabel("カイゼンくん本体")).toContain("窓口アプリ");
    expect(systemLabel("ほうこちゃん")).toContain("警備");
    expect(systemLabel("謎システム")).toBe("謎システム");
    expect(systemLabel(null)).toContain("未特定");
  });
});

describe("msgHead（何の件かヘッダー・3行）", () => {
  it("①やさしいシステム名（最上段）②種別③ざっくり何を、の3行", () => {
    const h = msgHead("💡", "カイゼンの提案", "カイゼンくん本体", "窓口に説明を1行足す");
    const lines = h.split("\n");
    expect(lines[0]).toContain("🖥");
    expect(lines[0]).toContain("カイゼンくん（"); // 何のシステムかが最上段
    expect(lines[1]).toBe("💡【カイゼンの提案】"); // 種別
    expect(lines[2]).toContain("窓口に説明を1行足す"); // ざっくり何を
  });
  it("system/title が空でも既定文言で落ちない", () => {
    const h = msgHead("✅", "完了", null, null);
    expect(h).toContain("未特定");
    expect(h).toContain("改善のご要望");
  });
});

import { looksGarbled, cleanForLine, msgHead as msgHead2 } from "../line";

describe("文字化け検知ガード（looksGarbled / cleanForLine）", () => {
  // 正常な入力は文字化けと誤判定しない（誤検知ゼロが最優先）
  it.each([
    "CSV取込でスタッフ名が重複するとエラーで止まる",
    "窓口に説明を1行足す",
    "実績や繁忙期の集計が見たい", // 7E00台の常用漢字（繁・績）でも誤検知しない
    "Indeedの応募通知が来ない",
    "ﾊﾟｿｺﾝが重い", // 正常な半角カタカナ単体は素通し
    "ABC test only english",
    "短い", // 4文字未満は素通し
  ])("正常: %s → garbled=false", (s) => {
    expect(looksGarbled(s)).toBe(false);
  });

  // 文字化け（UTF-8→CP932誤デコード／置換文字）は検知する
  it.each([
    "縺ｻ縺?縺薙■繧繧",
    "ﾎ繧吶￥繧吶￥ 譁?ｭ怜喧縺代＠縺溘ち繧､繝医Ν",
    "縺ｩ縺?↑繧九°繧上°繧峨↑縺?ｉ縺励＞",
    "壊れた�データ�です", // 置換文字 U+FFFD
  ])("文字化け: %s → garbled=true", (s) => {
    expect(looksGarbled(s)).toBe(true);
  });

  it("cleanForLine は文字化けを呪文でなく警告文に置換する", () => {
    const out = cleanForLine("縺ｻ縺?縺薙■繧繧", 32);
    expect(out).toContain("文字化けの可能性");
    expect(out).not.toContain("縺");
  });

  it("cleanForLine は正常文はそのまま（max超で…）", () => {
    expect(cleanForLine("正常なタイトル", 32)).toBe("正常なタイトル");
  });

  it("msgHead は文字化けタイトルを警告に置換して呪文を出さない", () => {
    const h = msgHead2("💡", "カイゼンの提案", "ほうこちゃん", "ﾎ繧吶￥繧吶￥ 譁?ｭ怜喧縺代＠縺溘ち繧､繝医Ν");
    expect(h).toContain("文字化けの可能性");
    expect(h).not.toContain("繧吶");
  });
});
