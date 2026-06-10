// ── 埋め込みモード判定 ──
// widget.js が iframe で窓口を開くとき ?embed=1 を付ける。
// 真値表記のゆらぎ（1/true/yes、大文字小文字・空白）を吸収する純粋関数。

export function isEmbed(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
