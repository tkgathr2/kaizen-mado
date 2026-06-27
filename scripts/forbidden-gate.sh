#!/usr/bin/env bash
# ── 禁止パス判定（自動マージ可否ゲートの中核・両ワークフロー共用） ──
# 旧実装の grep -qiE "(^|[/,])$p(/|$|\.|,)" は「パスセグメント完全一致」しか当たらず、
# 認可中核(lib/authz.ts・lib/cronAuth.ts・lib/gate.ts・lib/targets.ts)・ワークフロー自身・
# 複数形(payments/invoices)・ディレクトリ(app/members/...)・prisma/schema を全部素通しにしていた
# （実証済み）。ここで2段構えに強化する：
#
#   (A) ALWAYS_FORBIDDEN … per-target の forbiddenPaths とは無関係に、常に review へ落とす中核。
#       認可・ゲート・対象マッピング・CI/ワークフロー定義・スキーマは「自動で触らせない」。
#       ＝ゲートが自分自身と認可中核を守れるようにする（allowlist的な最後の砦）。
#   (B) 渡された forbiddenPaths … 各語を「概念マッチ」で判定。語境界に縛らず、
#       パス中の部分一致＋複数形/拡張子/ディレクトリも捕捉する（取りこぼしを塞ぐ）。
#
# 使い方：
#   forbidden-gate.sh "<改行区切りのtouchedファイル>" "<カンマ区切りのforbiddenPaths>"
# 出力：1つでも当たれば、当たった理由（語）を1行で stdout に出して exit 1。
#       何も当たらなければ何も出さず exit 0。
set -euo pipefail

TOUCHED="${1:-}"
FORBIDDEN="${2:-}"

# (A) 常に自動マージ禁止＝review に落とす中核パス概念。
#   - 認可/秘密/ゲート/対象マッピング：security-critical な意思決定コード。
#   - .github/ workflows：自動実行パイプライン自身（ゲートの改ざん防止）。
#   - prisma / schema / *.sql / migration(s)：DBスキーマ・PII土台。
#   - members / roster / meibo / cast / pii / personal：個人情報の気配。
ALWAYS_FORBIDDEN="authz cronauth /gate gate.ts targets.ts .github/ workflows/ prisma schema .sql migration migrations members roster meibo cast pii personal billing payment payments invoice invoices secrets .env auth middleware credential"

HIT=""

# 小文字化した touched 一覧（概念マッチは大文字小文字を無視する）。
TOUCHED_LC="$(printf '%s' "$TOUCHED" | tr '[:upper:]' '[:lower:]')"

contains() {
  # $1 を部分文字列として TOUCHED_LC に含むか（固定文字列・大小無視）。
  case "$TOUCHED_LC" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

# (A) 中核：固定の概念キーワードを部分一致で必ず判定。
for kw in $ALWAYS_FORBIDDEN; do
  if contains "$kw"; then HIT="$HIT $kw"; fi
done

# (B) per-target：渡された各禁止語を概念マッチ（部分一致＋複数形）で判定。
IFS=',' read -ra PATHS <<< "$FORBIDDEN"
for p in "${PATHS[@]}"; do
  p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]' | sed 's/^ *//; s/ *$//')"
  [ -z "$p" ] && continue
  if contains "$p"; then HIT="$HIT $p"; continue; fi
  # 末尾 .ts/.tsx 等を外した語幹でも当てる（"members.ts" → "members" がディレクトリでも当たる）。
  stem="${p%.*}"
  if [ "$stem" != "$p" ] && [ -n "$stem" ] && contains "$stem"; then HIT="$HIT $p"; continue; fi
  # 複数形 (payment→payments, invoice→invoices) も捕捉。
  if contains "${p}s"; then HIT="$HIT $p"; fi
done

if [ -n "$HIT" ]; then
  # 重複を畳んで一意の語だけ出す。
  UNIQ="$(printf '%s\n' $HIT | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  echo "$UNIQ"
  exit 1
fi
exit 0
