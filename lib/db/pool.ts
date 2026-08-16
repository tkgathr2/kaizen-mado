// カイゼンくんチケットDBのPostgres接続プール（mention-hisho lib/store.ts PgMentionStoreと同じ流儀）。
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

let ensured: Promise<void> | null = null;

/** テーブル未作成でも初回アクセス時に自動で用意する（mention-hishoのensureと同じ設計）。
 * 【bug-check-lab Medium-4修正・2026-08-16】初回が一時的な接続断等で失敗すると、
 * rejectされたPromiseがそのまま永久にキャッシュされ、以後の全呼び出しが再試行すら
 * せず同じエラーで即失敗し続けていた。失敗時はキャッシュをクリアし、次回呼び出しで
 * 再試行できるようにする。 */
export function ensureSchema(): Promise<void> {
  if (!ensured) {
    ensured = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
