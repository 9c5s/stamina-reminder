#!/usr/bin/env bash
set -euo pipefail

fail=0
# 検査対象から除外するパス:
# - docs/: 計画書・仕様書本文の placeholder は意図的に残す
# - HANDOFF.md: 永続的な引き継ぎ書、placeholder 表記をそのまま残す (repo root にあり docs/ 配下ではない)
# - scripts/check-pins.sh / scripts/check-pins.test.ts: 自身が placeholder 文字列を literal で扱うため自己マッチを避ける
EXCLUDE=(
  ':!docs/'
  ':!HANDOFF.md'
  ':!scripts/check-pins.sh'
  ':!scripts/check-pins.test.ts'
)

scan() {
  if git grep -nE "$1" -- "${EXCLUDE[@]}" >/dev/null 2>&1; then
    echo "✗ Placeholder found: $1"
    git grep -nE "$1" -- "${EXCLUDE[@]}" || true
    fail=1
  fi
}

scan '<SHA>'
scan '<[A-Z_]+_PIN>'
scan '<APPLICATION_ID>'
scan '<APP_ID>'
scan '<PUBLIC_KEY>'
scan '<BOT_TOKEN>'
scan '<KV_NAMESPACE_ID>'
scan '<GUILD_ID>'
scan '<subdomain>'
scan '<実装日 YYYY-MM-DD>'

# Secret-like literal scan: HANDOFF.md も含めて (= placeholder allowlist より広い対象)
# DISCORD_BOT_TOKEN の右辺が `<...>` placeholder ではなく 20 文字以上の英数記号列の場合に検出
# (Bot / Bearer のような認証 prefix を挟んでも検出する)
# 注意: DISCORD_PUBLIC_KEY は公開値 (Ed25519 公開鍵、spec §9 / architecture §7) のため scan 対象に含めない。
# wrangler.toml [vars] に 64 hex の literal で commit する設計を妨げないようにする。
SECRET_EXCLUDE=(
  ':!docs/'
  ':!scripts/check-pins.sh'
  ':!scripts/check-pins.test.ts'
)
secret_lines=$(git grep -nE 'DISCORD_BOT_TOKEN[[:space:]]*=[[:space:]]*"?((Bot|Bearer)[[:space:]]+)?[^<[:space:]"]{20,}' \
  -- "${SECRET_EXCLUDE[@]}" || true)
if [ -n "$secret_lines" ]; then
  echo "✗ Secret-like literal found (DISCORD_BOT_TOKEN not in <PLACEHOLDER> form):"
  echo "$secret_lines"
  fail=1
fi

uses_lines=$(git grep -nE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]+\S+' \
  -- '.github/workflows/*.yml' '.github/workflows/*.yaml' || true)
bad_lines=$(echo "$uses_lines" | awk -F'uses:[[:space:]]+' '
  NF > 1 {
    ref = $2
    sub(/[[:space:]].*$/, "", ref)
    if (ref ~ /^\.\.?\//) next
    if (ref !~ /@[0-9a-f]{40}$/) {
      print $0
    }
  }')

if [ -n "$bad_lines" ]; then
  echo "✗ Non-SHA uses: ref found in workflow"
  echo "$bad_lines"
  fail=1
fi

exit $fail
