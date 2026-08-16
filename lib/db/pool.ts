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

/** テーブル未作成でも初回アクセス時に自動で用意する（mention-hishoのensureと同じ設計）。 */
export function ensureSchema(): Promise<void> {
  if (!ensured) {
    ensured = getPool().query(SCHEMA_SQL).then(() => undefined);
  }
  return ensured;
}
