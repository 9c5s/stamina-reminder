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
secret_lines=$(git grep -nE $'["\047]?DISCORD_BOT_TOKEN["\047]?[[:space:]]*[=:][[:space:]]*["\047]?((Bot|Bearer)[[:space:]]+)?[^<[:space:]"\047]{20,}' \
  -- "${SECRET_EXCLUDE[@]}" 2>/dev/null || true)
if [ -n "$secret_lines" ]; then
  echo "✗ Secret-like literal found (DISCORD_BOT_TOKEN not in <PLACEHOLDER> form):"
  # 検出された token 値はログに残さず redact する。file:line までは出力して特定に困らないようにする。
  echo "$secret_lines" | sed -E $'s#(["\047]?DISCORD_BOT_TOKEN["\047]?[[:space:]]*[=:][[:space:]]*["\047]?((Bot|Bearer)[[:space:]]+)?)[^[:space:]"\047]+#\\1[REDACTED]#g'
  fail=1
fi

uses_lines=$(git grep -nE $'^[[:space:]]*-?[[:space:]]*["\047]?uses["\047]?[[:space:]]*:[[:space:]]+[^[:space:]]+' \
  -- '.github/workflows/*.yml' '.github/workflows/*.yaml' 2>/dev/null || true)
# `uses:` の key 部分は "uses": / 'uses': / uses : / uses: のいずれも YAML 仕様で valid のため、
# どの form でも ref を抜き出して 40 hex SHA pin になっているか確認する。
bad_lines=$(echo "$uses_lines" | awk $'
  {
    line = $0
    if (match(line, /["\047]?uses["\047]?[[:space:]]*:[[:space:]]+/)) {
      ref = substr(line, RSTART + RLENGTH)
      sub(/[[:space:]].*$/, "", ref)
      # ref を quote した形 (uses: "actions/foo@<sha>") も valid YAML なので外側 quote を剥がす
      sub(/^["\047]/, "", ref)
      sub(/["\047]$/, "", ref)
      if (ref ~ /^\\.\\.?\\//) next
      if (ref !~ /@[0-9a-f]{40}$/) {
        print line
      }
    }
  }
')

if [ -n "$bad_lines" ]; then
  echo "✗ Non-SHA uses: ref found in workflow"
  echo "$bad_lines"
  fail=1
fi

exit $fail
