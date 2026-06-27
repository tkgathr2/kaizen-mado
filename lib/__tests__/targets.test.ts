import { describe, it, expect } from "vitest";
import { TARGETS, findTarget } from "../targets";

describe("targets", () => {
  it("全システムが autoEligible=true（社長指示2026-06-27「全部ONにして」）", () => {
    // 1件でも false が残っていたら、GO後にautoEligibleを理由に止まりうるので回帰防止。
    const notEligible = TARGETS.filter((t) => !t.autoEligible).map((t) => t.system);
    expect(notEligible).toEqual([]);
  });

  it("findTarget は名前で引ける／未知は null", () => {
    expect(findTarget("ステレポ")?.repo).toBe("tkgathr2/sterepo");
    expect(findTarget("存在しないシステム")).toBe(null);
    expect(findTarget(null)).toBe(null);
    expect(findTarget(undefined)).toBe(null);
  });

  it("repo:null のシステムも存在する（物理的に自動修正不能＝リポ未設定で正直に弾く対象）", () => {
    // autoEligible=true でも repo が無いものは execute 側で「リポ未設定」として弾かれる。
    const repoNull = TARGETS.filter((t) => t.repo === null);
    expect(repoNull.length).toBeGreaterThan(0);
  });

  it("共通 forbiddenPaths は概念キーワードへ拡張済み（members.ts 単一依存を脱却）", () => {
    // 全システムの forbiddenPaths に、PII/認可/スキーマ系の概念語が入っていること。
    for (const t of TARGETS) {
      const fp = t.forbiddenPaths;
      // PII＝members 1ファイル名依存ではなく概念語(members/meibo)で守る
      expect(fp).toContain("members");
      expect(fp).toContain("meibo");
      // 認可・スキーマ・課金の概念
      expect(fp).toContain("authz");
      expect(fp).toContain("prisma");
      expect(fp).toContain("schema");
      expect(fp).toContain("payment");
    }
  });

  it("PII保有対象（キャスト名簿くん）はより厳しい禁止語を持つ", () => {
    const cast = findTarget("キャスト名簿くん")!;
    // 共通には無い PII_HEAVY 専用語が乗っていること。
    expect(cast.forbiddenPaths).toContain("phone");
    expect(cast.forbiddenPaths).toContain("email");
    expect(cast.forbiddenPaths).toContain("export");
    // 共通語も含む（スーパーセット）。
    expect(cast.forbiddenPaths).toContain("meibo");
  });
});
