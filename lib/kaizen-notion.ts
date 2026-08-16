/**
 * カイゼン改善チケットのLINE往復ログ操作
 * 【DB移行・2026-08-16】実体は lib/tickets.ts の Postgres実装（tickets.line_chat列）。
 * 呼び出し元（app/api/kaizen/context・app/api/kaizen/line-chat・app/api/kaizen/ticket・
 * app/api/line/webhook）の変更を避けるため、この薄いラッパーとして名前だけ残す。
 */
export { appendLineChat, getLineChat, ensureLineChatField } from "./tickets";
