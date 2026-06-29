# Codex レビューループ運用ガイド

最終更新: 2026-06-30 (実装計画書 3 ファイルを 8 round で PASS まで追加実走)

> このドキュメントは、設計仕様 / 実装計画書 / 設計判断を Codex (codex-companion ランタイム) に厳密レビューさせて **PASS** が出るまで反復改善する運用手順をまとめたものです。本リポジトリでは:
> - `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (CI/CD 設計仕様): round 13 PASS
> - `docs/superpowers/plans/2026-06-29-stamina-reminder-{bootstrap,stage1,stage2}.md` (実装計画書 3 ファイル一括): round 8 PASS
>
> の 2 回の実走で確立済み。後者の経験から「実装計画書を対象にする場合の追加観点」(§10) を別立てで補強している。

---

## 1. このループが解く課題

- 「自分で書いた設計仕様 / 実装計画は内部視点に閉じやすい」
- 「指摘されても都度の差分対応で全体整合が崩れる」
- 「HYPOTHESIS 系 (= 一次資料未確認) の指摘を鵜呑みにすると誤った設計を採用してしまう」
- 「複数ファイル (例: bootstrap → stage1 → stage2 の 3 計画書) を跨いだ整合性は機械的に検出しにくい」
- 「修正で生まれた新たな矛盾 (regression) や、Round N の修正が Round N-1 の確定事項を巻き戻す事故を見落とす」

→ **Codex を厳密な独立レビュアーとして使い、指摘→反映→再レビューを同一スレッドで継続し、毎回 HYPOTHESIS を独自検証する** ことで、最終的に一次資料との整合性まで verified な仕様 / 計画に収束させる。

---

## 2. 前提

- Claude Code 環境で `codex` プラグインがインストール済み (`codex:setup` で確認)
- `codex-companion.mjs` (`C:\Users\shun\.claude\plugins\cache\openai-codex\codex\1.0.4\scripts\codex-companion.mjs` 付近) が起動可能
- 一次資料を読める web fetch / mcp ツール (`mcp__claude_ai_Cloudflare_Developer_Platform__search_cloudflare_documentation`, `WebFetch`, `mcp__plugin_context7_context7__query-docs` 等)

---

## 3. 全体フロー

```
[Round N の入口]
   │
   ▼
[Codex に厳密レビューを依頼 (--resume で同一スレッド継続)]
   │
   ▼
[verdict を取得: PASS / ISSUES]
   │
   ├─ PASS → ループ終了、設計確定
   │
   └─ ISSUES
       │
       ▼
[critical / major / minor を分類]
       │
       ▼
[HYPOTHESIS タグ付き指摘を一次資料で検証]
       │
       ├─ 検証結果 OK → 仕様に反映
       └─ 検証結果 NG → 仕様を反映しない、根拠を記録
       │
       ▼
[反映内容を Codex に説明しつつ Round N+1 を起動]
       │
       └─ 入口へ戻る
```

---

## 4. 具体的なツール呼び出し

### 4.1 初回 (新スレッド)

```sh
# 既存の resumable thread の有無を確認 (available: false なら新スレッド扱い)
node "C:/Users/shun/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" task-resume-candidate --json
```

`codex:rescue` skill を Agent ツールで呼び、`subagent_type: "codex:codex-rescue"` を指定する。プロンプト本文には:
- レビュー対象の絶対パス (例: `D:\projects\...\2026-06-29-github-cicd-design.md`)
- 関連 context へのパス (例: `HANDOFF.md`, `docs/architecture.md`)
- レビュー観点の列挙 (セキュリティ / 整合性 / 実現可能性 / 抜け漏れ / 設計判断の妥当性 / ドキュメント可読性)
- 回答フォーマットの指定 (verdict 1 行 + critical/major/minor の優先度別箇条書き、HYPOTHESIS タグ付き)
- `--fresh` フラグ (新スレッド開始)

を含める。

### 4.2 2 回目以降 (--resume)

`codex:rescue` の subagent 経由でも動くが、本セッションでは subagent が再 resume を queue できないケースが観測されたので、**直接 `codex-companion.mjs task --background --resume` を叩く方法が確実**:

**round 2 以降のプロンプトに必ず含める観点**:
- 前 round で指摘された件数と分類 (Critical / Major / Minor) を明示
- 各指摘への対応を 1 行で要約 (HYPOTHESIS を verify した結果も含む)
- **「これまで確定した事項を覆す new evidence は必ず指摘してほしい」** (= 蓄積した判断が次 round で覆る事故を防ぐ)
- **「本 round の修正で新たな矛盾が生じていないか念入りに見てほしい」** (= regression 検出)
- Round 6 以降は「累積指摘がすべて解消されているか cross-check」も指示。実装計画書では Round 7〜8 で Critical / Major が 0 件に落ちてから PASS 判定が出やすい


```sh
node "C:/Users/shun/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" task --background --resume "$(cat <<'EOF'
round N で指摘された X 件 (critical/major/minor の内訳) に対応した:

(major 1) <一次資料で検証した結果と根拠 URL>
(major 2) ...
(minor 1) ...

spec は <絶対パス> に保存済み。round N+1 を厳しい観点でレビューしてくれ。verdict は冒頭に PASS または ISSUES、ISSUES なら critical/major/minor で具体指摘と対応方針を箇条書きで。HYPOTHESIS タグは引き続き付けてくれ。これまでの確定事項を確認 / 否定する new evidence があれば指摘してほしい。
EOF
)"
```

**注意 (本セッションで踏んだ罠)**:
- インラインでバッククォート `` ` `` を使うと bash の **command substitution** として実行されてしまう。`` `bunx wrangler login` `` のように code として書いたつもりが、実際に `bunx wrangler login` が走り CF OAuth ページがブラウザに開いた事故が発生した。**bash の heredoc は `<<'EOF'` (シングルクォート付き)** を使い、本文中はバッククォートを避ける、または `&#x60;` / 全角 ` 等で回避する
- 既に running な codex task がある状態で再 resume すると `Task <id> is still running. Use /codex:status before continuing it.` で fail する。前 round が完了するまで待つ

### 4.3 ポーリング (完了待ち)

```sh
script="C:/Users/shun/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs"
until [ "$(node "$script" status --json 2>/dev/null | grep -c '"status": "running"')" = "0" ]; do
  sleep 30
done
echo "Codex round finished"
```

このスクリプトを Bash の `run_in_background: true` で起動し、完了通知を待つ。

### 4.4 結果取得

```sh
node "C:/Users/shun/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" result <task-id> --json
```

`<task-id>` は task 投入時の stdout に出ている (`Codex Resume started in the background as task-xxxx-yyyy`)。`task-id` を省略すると **最後に finished した job** が返るが、複数 round 連続実行時は ID 指定が安全。

---

## 5. HYPOTHESIS の検証手順

Codex は不確実な指摘に **HYPOTHESIS タグ** を付けてくる。これを鵜呑みにせず、必ず一次資料で検証する。

### 検証パターン

- **Cloudflare 関連** (Workers / wrangler / Workers Builds / DO / KV):
  - 1st choice: `mcp__claude_ai_Cloudflare_Developer_Platform__search_cloudflare_documentation`
  - 2nd choice: WebFetch で `developers.cloudflare.com` の該当 URL を直接
  - Durable Object の base class API は `https://developers.cloudflare.com/durable-objects/api/base/` を見る (現行は `extends DurableObject<Env>` + `super(ctx, env)`、`implements DurableObject` は古い形)
- **GitHub Actions / Dependabot / REST API**:
  - WebFetch で `docs.github.com` の該当ページ。branch protection PUT のような required body 構造は `docs.github.com/en/rest/branches/branch-protection` を直接読む
- **GitHub Action の実装** (raven-actions/actionlint、zizmorcore/zizmor-action 等):
  - WebFetch で `https://raw.githubusercontent.com/<owner>/<repo>/main/action.yml` を読む
- **Bun docs**:
  - WebFetch で `https://bun.com/docs/...` を読む (`/typescript` ページに `@types/bun` と tsconfig `types` の指針あり)
- **Biome**:
  - 1st choice: WebFetch で `https://biomejs.dev/guides/upgrade-to-biome-v2/` (v1 → v2 の config 構造変更が網羅されている)
- **任意のライブラリ**:
  - `mcp__plugin_context7_context7__resolve-library-id` → `query-docs` (Context7)

### Codex の URL 提示と HYPOTHESIS タグの扱い

Codex は不確実な指摘に `[HYPOTHESIS]` タグを付ける建前だが、**自信ある形で URL だけ提示してきて HYPOTHESIS タグを付けないこともある**。その場合でも本ガイドの方針通り **独立に WebFetch / MCP で verify する** こと。Codex の主張が結果的に正しくても、確認の手間を省くと「Codex が誤った URL を引いた」「URL の内容が古い」事故を見落とす。

本セッションの実績では、Codex が URL 提示した指摘 (Bun typescript / KV consistency / Biome v2 / GitHub REST / Cloudflare DO base class) はすべて独立 verify で **正しかった**。ただし `[HYPOTHESIS]` タグなしで提示されても疑いを保ち、verify はスキップしないことを徹底する。

### 検証結果の取り扱い

- **検証で Codex が正しいと確認できた**: 仕様に反映、根拠 URL を本文に併記
- **検証で Codex が誤りと判明した**: 仕様には反映しない、その判断と根拠を仕様内に記録 (次回 round で誤適用しないように)
- **検証で明確な記述が見つからない (= CF/GH 公式が沈黙)**: 安全側解釈を採用し、その判断と根拠 (= 沈黙) を明記。将来公式が明文化したら本仕様を見直すと記す

### 本セッションで verify した代表例

本リポジトリの spec round 13 PASS および plans round 8 PASS までに以下が確認された (一次資料を読み直す手間を再発させないため記録):

#### spec round 13 PASS で verify

- **Bun は依存パッケージの lifecycle script を default で実行しない** (https://bun.com/docs/pm/cli/install)。`--ignore-scripts` は root package の scripts のみ抑止
- **`wrangler secret put` は新 Worker version を作成して即時 deploy する** (https://developers.cloudflare.com/workers/configuration/secrets/、https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret)
- **DO migration を含むデプロイ後の rollback はブロックされる** (CF 公式: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)。`new_sqlite_classes` も migration として扱われる
- **zizmor-action は default で `advanced-security: true`、その状態では findings が CI を fail させない** (https://github.com/zizmorcore/zizmor-action)
- **zizmor-action の `online-audits: false` でも `GHA_ZIZMOR_TOKEN` env var に github.token は渡される** (action.yml の挙動)
- **raven-actions/actionlint の `github-token` と `token` は `${{ inputs.github-token || inputs.token || env.GITHUB_TOKEN }}` の順で fallback** (両方明示空にする必要がある)
- **raven-actions/actionlint は内部で `npm install --no-save @actions/tool-cache@3.0.1` を叩く** (SHA pin で塞げない supply-chain 経路)
- **Dependabot は `package-ecosystem: bun` を `>=v1.2.5` で公式サポート** (https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)。`bun.lock` 対応は `>=v1.1.39` (https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)。`bun` ecosystem は **`dependency-type` グルーピングを非対応** (bundler/composer/mix/maven/npm/pip のみ)
- **Discord Ed25519 public key は Developer Portal に明示される公開鍵** で、Secret 扱いする必要はなく `[vars]` に置ける

#### plans round 8 PASS で追加 verify

- **Bun の TypeScript セットアップは `@types/bun` を devDependency に追加 + tsconfig `compilerOptions.types` に `"bun"` を含める** (https://bun.com/docs/typescript)。`Bun.file` や `import.meta.main` 等の Bun 専用 globals に必須。Cloudflare Workers (`@cloudflare/workers-types`) と同居させる場合は `types: ["@cloudflare/workers-types/<date>", "bun"]` で OK だが、衝突時は `tsconfig.scripts.json` 等を分離する
- **Cloudflare KV の write は同じグローバルネットワーク location からのリクエストには即時可視、他 location には最大 60 秒 (または `cacheTtl` 秒)** (https://developers.cloudflare.com/kv/api/write-key-value-pairs/)。`/title add` → `/stamina add` のような連鎖は同 region で問題ないが、検証手順に retry / 待機を入れる
- **Biome v2 は `organizeImports` を `assist.actions.source.organizeImports` に移動、`include` / `ignore` を `includes` 配列に統合** (https://biomejs.dev/guides/upgrade-to-biome-v2/)。`@biomejs/biome@latest` が v2 を返す前提で `biome.json` を書く。v1 系を pin する場合は `bun add -D @biomejs/biome@^1`
- **GitHub REST `PUT /repos/{owner}/{repo}/branches/{branch}/protection` は `required_status_checks` / `enforce_admins` / `required_pull_request_reviews` / `restrictions` の 4 フィールドがすべて required** (null 可だが省略不可、省略すると 422)。`gh api -F` の簡略書き換えは事故りやすいので JSON body フルか UI 推奨 (https://docs.github.com/en/rest/branches/branch-protection)
- **Cloudflare Durable Object の現行 base class API は `import { DurableObject } from 'cloudflare:workers'` + `class ... extends DurableObject<Env>` + `super(ctx, env)`** (https://developers.cloudflare.com/durable-objects/api/base/)。`this.ctx` / `this.env` は base class が readonly プロパティとして提供。`implements DurableObject` パターンは公式 docs から消えており、古い形。`noImplicitOverride: true` 環境では TS4114 / TS4113 を見て `override` キーワードを付けるかを判断する
- **Bun の `bun run <script> -- <flags>` で `--` 以降が script の `process.argv` に渡る** (https://bun.com/docs/runtime)。`bun run register-commands -- --clear-guild` は `process.argv.includes('--clear-guild')` で受けられる

---

## 6. round N の起こし方 (テンプレート)

### Round N 投入時のプロンプト構造

```
round <N-1> で指摘された <総数> 件 (critical/major/minor の内訳) に対応した。
HYPOTHESIS は一次資料で検証した上で反映 / 拒否した:

(critical 1) <検証結果と根拠 URL>
(major 1) ...
(minor 1) ...

(直前 round で否定された Codex 指摘があれば:)
(検証で誤りと判明) <Codex の主張> → <検証根拠> によりこの主張は反映しない、spec 内で <該当 section> に判断記録を残した

spec は <絶対パス> に保存済み。round <N> を厳しい観点でレビューしてくれ。
verdict は冒頭に PASS または ISSUES を 1 行、ISSUES なら critical/major/minor 区分けで具体指摘と対応方針を箇条書きで。
HYPOTHESIS タグは引き続き付けてくれ。
これまでの確定事項を確認 / 否定する new evidence が出たら必ず指摘してほしい。
```

### Round 完走の各タスクで追加すること

- spec 上端の状態行 (round カウンタ) を更新する
- 反映した major / minor は前回プロンプトに必ず明示し、Codex が同じ指摘を繰り返さないようにする
- 反映できなかった指摘は spec 内に判断記録 (棄却理由 + 根拠) を残す

---

## 7. 終了条件 (PASS)

Codex が verdict 行に `PASS` を返した時点でループ終了。

**PASS が出ても確認すべき点**:
- 直前 round の指摘で「HYPOTHESIS タグ」が残っていないか (= 残っている場合は実装後の運用で要観測項目)
- 一次資料との突合せが完了していない項目はないか (= 仕様内で「実地検証する」と書いた項目)
- 仕様内に未解決の `<placeholder>` が残っていないか (実装時に置換するのは別フェーズ、`scripts/check-pins.sh` で CI 強制)

---

## 8. ループ運用のメタな注意点

- **盲目的に Codex の指摘を反映しない**: 特に HYPOTHESIS タグ付きは検証必須。本セッションでは round 3 時点で「DO migration が rollback を阻害する」を一旦否定したが、round 7 で CF 公式仕様で明示されていることが判明、Codex が正しかった例もある。逆に「Bun の dependency lifecycle script が token を読む」は npm 前提の HYPOTHESIS で Bun では成立しなかった例もある
- **設計の本質的変更を Codex 指摘で受け入れる場合**: ユーザーに一度 Discord 等で確認する。本セッションでは「register-commands を Workers Builds から外して手動運用に戻す」変更 (Q3 の元決定 A → B) を Codex round 2 で勧められ、Discord でユーザーに確認した
- **Codex のセッションは codex-companion 側で管理されているスレッド**。Claude Code 側の会話履歴とは独立。`--resume` で同じ thread を継続できる
- **API トークン消費が大きい** (1 round あたり数千〜1 万 token)。費用感を意識して回数を抑える方向 (= 早めに HYPOTHESIS を verify して質を上げる)
- **Round n の修正が Round n-1 の確定事項を巻き戻す事故**: plans round 5 で私が secret-like scan に `DISCORD_PUBLIC_KEY` を追加したが、spec §9 (公開鍵で `[vars]` literal commit) と矛盾する regression を Codex に指摘されて撤回した例がある。**「同じ概念を複数ファイル / 複数 Task / 複数 Phase で触る場合、片方の修正が他方を巻き戻していないか」** を反映前に grep で確認する
- **`scan` 自身が `scan` 対象になる ouroboros 問題**: `check-pins.sh` のような自己参照 script は scan 除外 allowlist (`docs/` / `HANDOFF.md` / 自身) で対処。**ただし allowlist 内の placeholder / secret は CI で検出されない経路として残る**。二次防御として「placeholder allowlist より広い範囲を scan する secret-like literal scan」(allowlist は `docs/` + 自身のみ) を設けると HANDOFF.md への誤コミットも捕まる
- **`git grep` は untracked file を見ない**: 新規ファイル create 直後に check を走らせる plan は、`git add` を前に挟むか、recovery 経路で再 `git add` を冗長化する設計にする
- **Discord で毎 round 報告する運用**: ループは時間がかかるため、ユーザーは別作業と並行している。毎 round 完了時に verdict / 件数 / 次アクションを Discord で報告する ([[feedback-codex-loop-report-per-round]])。Discord はテーブル非対応なので箇条書きで投稿 ([[feedback-discord-no-tables]])
- **PASS が近付くと Critical / Major が 0 になり Minor だけが残る** (plans round 7 → 8 の流れ)。文言整合や cross-check の数値合わせなど、本質的でない指摘に収束したら PASS まで 1〜2 round

---

## 9. このループを他プロジェクトで再利用する場合

1. 設計仕様 / 実装計画を `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` または `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` 等に書く
2. 本ガイドの §4 のコマンド (`codex-companion.mjs task --background --resume`) で round 1 を起動
3. verdict を見て §5 の検証手順で HYPOTHESIS を verify
4. 反映 → round 2 → ...
5. PASS まで繰り返す
6. 一次資料で得た知見は仕様 / 計画内に根拠 URL 付きで記録 (将来の自分と他セッションのため)
7. 実装計画書を対象にする場合は §10 の追加観点も適用

本ガイド自体も新プロジェクトで使い回す想定。各プロジェクト固有の検証蓄積 (§5 の代表例ブロック) はプロジェクト spec 内に残す。

---

## 10. 実装計画書 (Plan) を対象にする場合の追加観点

設計仕様 (spec) より一段下の実装計画書 (Plan) を Codex レビューに掛ける場合、spec とは異なる失敗モードが出やすい。以下を Round 1 のプロンプトのレビュー観点に含める:

### 10.1 Plan 間整合

複数 Plan (例: bootstrap → stage1 → stage2 の 3 ファイル) に分かれた場合、以下の整合性が崩れやすい:

- **識別子の表記揺れ** (binding 名 `USER_STATE` / `TITLES`、型 `Bindings`、ファイル名)
- **Interface の signature 互換性** (Phase 5 で `dispatchInteraction(): { type, data }` だったものを Phase 6 で kind-based に refactor、等の破壊的変更が次 Phase の Plan に明示されているか)
- **同じ概念を複数 Phase で触る箇所** (例: tsconfig types を bootstrap で `["@cloudflare/workers-types/<date>", "bun"]` に書いたが、stage1 で `["@cloudflare/workers-types/<実装日 YYYY-MM-DD>"]` に書き換える → Bun 型が巻き戻る事故)

### 10.2 Task 順序と prerequisite

- **前提を後で作る順序** (例: Task 5 で型 `Bindings` が拡張前提のコードを書くが、Bindings 拡張が Task 10 → typecheck が Task 5 で失敗)
- **register-commands と deploy の順序** (= deploy 完了前に Discord 側にコマンドを登録すると 404)
- **DO migration を含む deploy の rollback ブロック影響** (= migration deploy 前に動作確認を完了する)
- **branch protection の有効化タイミング** (= 一般設定と branch protection 前段は同 Task でまとめる、`Require status checks` だけ CI 完走後)

### 10.3 Task 番号変更時の参照更新

新規 Task を挿入する場合 (例: Task 4 と Task 5 の間に Task 4.5):

- Self-Review 内の Task 番号参照 (`Task 5, 6, 7 ...`) を grep で全箇所確認
- 別 Plan からの参照 (`stage2 Task N`) も grep
- 本 Plan の他 Task 内参照 (例: Task 11 内の「Task 18 Step 3」) も grep

### 10.4 commit 境界の整合

各 Task の `git add` / `git commit` が **その Task 内で変更したファイルすべて** を含むか:

- Task 5 Step 0 で `src/index.ts` を編集、Step 1〜2 で `src/durable-objects/user-state.ts` を作成 → Step 3 の `git add` に両方含めないと、Step 0 の変更が次 Task まで持ち越されて「赤→緑→commit」の Task 境界が壊れる

### 10.5 TDD 約束と実装の同期

Plan の Interfaces セクションで「純粋関数 X を export して TDD」と約束したら、**実 Task に X の独立 Task / Step として残っているか確認**:

- Interfaces で `parseStaminaAddOptions` を約束したが、handler 内 inline parse になっている → 約束違反
- 「`buildRegisterRequest` を export」と書いたら Task 11 で `buildRegisterRequest` の test 5 件を書く

### 10.6 自己参照ファイルの scan 除外設計

`scripts/check-pins.sh` のような placeholder / secret 検出 script は自分自身の中に検出対象の literal を持つため、scan 除外設計が必要:

- placeholder scan の除外 allowlist: `docs/` + 永続ドキュメント (`HANDOFF.md` 等) + 自分自身 (`scripts/check-pins.sh` / `scripts/check-pins.test.ts`)
- 二次防御の secret-like literal scan: `docs/` + 自分自身のみ除外 (= `HANDOFF.md` も対象)。token 風 literal を別パターンで検出
- `docs/` 配下への実 token / 実 ID コミットは **scan の責務外、手動レビュー責務** と Plan / HANDOFF / architecture に明記

### 10.7 HANDOFF / spec / architecture との整合

Plan の修正が HANDOFF.md / spec / architecture.md の前提を覆していないか、Round 6 以降は cross-check する:

- spec で `DISCORD_PUBLIC_KEY` を公開値と決めたなら、Plan の secret-like scan に含めない
- architecture で「bot token は Runtime secret のみ」と書くなら、Plan / HANDOFF も同じ表記で揃える
- 修正が他文書に影響するなら、本セッションのように HANDOFF.md / architecture.md も直接編集する

### 10.8 checkbox 消化型 agent への配慮

`superpowers:executing-plans` のような checkbox 消化型 agent は Step を機械的に叩くため、**「条件分岐で skip する Step」は見出しに `(... の場合のみ)` を付けて明示**、`Note` で skip 指示を agent に伝える。例:

```markdown
- [ ] **Step 4 (cleanup する場合のみ): cleanup 用に `.dev.vars` を一時復元**
```

「Step 3 で 'しない' を選んだ場合、Step 4-6 はチェックせず Step 7 へ進む」を Step 3 の本文に書き、agent が判断できる形にする。
