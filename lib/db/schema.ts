// カイゼンくん改善チケットDB（Notion→Postgres移行・2026-08-16）
// Vercelサーバーレス環境で実行時に.sqlファイルを読むと本番バンドルに含まれない
// リスクがあるため、TS文字列定数として埋め込む（mention-hisho lib/store.tsと同じ流儀）。
// 過去のマイグレーション事故の教訓（knowhow chunk:5693等）を踏まえ、範囲型は使わない・
// 単純な列型のみで構成する。
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_number INTEGER NOT NULL UNIQUE,
  system TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  importance TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  reporter TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  fgs_url TEXT,
  pr_url TEXT,
  urgency INTEGER,
  importance_score INTEGER,
  priority TEXT,
  priority_reason TEXT,
  status_changed_at TIMESTAMPTZ,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  slack_user_id TEXT,
  notion_page_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tickets_state_idx ON tickets (state);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_notion_page_id_idx ON tickets (notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_slack_thread_idx ON tickets (slack_thread_ts, slack_channel_id) WHERE slack_thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_created_at_idx ON tickets (created_at);

CREATE TABLE IF NOT EXISTS ticket_discussion_blocks (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  heading TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_discussion_blocks_ticket_id_idx ON ticket_discussion_blocks (ticket_id, id);

-- 新規チケットの ticket_number 採番専用シーケンス。tickets.ticket_number 自体は
-- BIGSERIALのidとは独立（Notion移行データの番号を保持するため）なので、
-- 採番だけをこのシーケンスに委ねる。移行スクリプトが「移行データの最大値+1」まで
-- 進める（setval）。移行前（開発環境等）でも 1 から採番できるよう、ここでは
-- CREATE SEQUENCE IF NOT EXISTS のみ行い、初期値の調整はしない。
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq;
`;
