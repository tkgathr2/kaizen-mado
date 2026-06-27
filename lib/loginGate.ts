// ── ログインゲート判定（純粋関数・テスト対象） ──
// 「窓口を直接開いた人に、チャットの前にログイン画面を出すか」を1か所で決める。
//
// 最重要の制約（壊すと全社の widget が死ぬ）：
//   カイゼン窓口は他システムに widget.js で iframe 埋め込みされる公開入口。
//   埋め込み（iframe 内）では Google ログインが技術的に不可能で、ホスト側が
//   ユーザー名を reporterParam / window.kaizenUser で渡す。
//   ⇒ 埋め込み時は絶対にゲートを出さない。
//
// ゲートを出すのは「トップレベル表示（直接アクセス）かつ 認証ON かつ 未ログイン」のときだけ。

// 埋め込み（iframe 内）かどうか。
//   - iframe 内（window.self !== window.top）
//   - もしくは reporterParam がある（widget.js が ?reporter= で本人名を渡している）
// どちらかなら埋め込み文脈とみなし、ゲートは出さない。
export function isEmbeddedContext(opts: {
  inIframe: boolean;
  reporterParam?: string | null;
}): boolean {
  if (opts.inIframe) return true;
  if ((opts.reporterParam ?? "").trim()) return true;
  return false;
}

// ログインゲートを描画すべきか。
//   authUiEnabled … NEXT_PUBLIC_AUTH_ENABLED==='1'（鍵未投入の既定では false ＝従来挙動）
//   embedded      … isEmbeddedContext（埋め込みなら出さない）
//   authStatus    … next-auth の useSession status
// 「認証ON かつ 非埋め込み かつ 未ログイン」のときだけ true。
export function shouldShowLoginGate(opts: {
  authUiEnabled: boolean;
  embedded: boolean;
  authStatus: "loading" | "authenticated" | "unauthenticated";
}): boolean {
  if (!opts.authUiEnabled) return false;
  if (opts.embedded) return false;
  return opts.authStatus === "unauthenticated";
}
