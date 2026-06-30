# Stamina Reminder Stage 1 (Phase 4〜5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisites:** `2026-06-29-stamina-reminder-bootstrap.md` 完了 (bun run check green、CI workflow green、main branch protection 前段 ON、Discord App 作成済、3 値控え済)。

**Goal:** Cloudflare Workers Builds の OAuth 連携・Build/Deploy command を設定し、Ed25519 verify + PING/PONG だけの最小 Worker を Production deploy する。Discord Interactions Endpoint URL の登録に成功した状態で完了。

**Architecture:** `src/index.ts` は Hono の最小エントリ。`/interactions` で Ed25519 verify ミドルウェア → JSON parse → PING を判定して PONG を返す。Stage1 のコードからは **DO / KV / Bot Token を一切参照しない** (= 第 2 段階で実装)。ただし `wrangler.toml` には Stage2 の前提として `[[kv_namespaces]]` (TITLES) を先に書く (Task 2、namespace ID は Stage2 でも使い回すので Stage1 deploy 時点で binding 自体は存在しても無害)。DO binding と `[[migrations]]` のみ Stage2 で初投入する (rollback ブロックの境界を Stage2 deploy に揃える)。

**Tech Stack:** Hono v4、discord-interactions (`verifyKey`, `InteractionType`, `InteractionResponseType`)、Cloudflare Workers Builds、wrangler。

## Global Constraints

- `wrangler.toml` の `compatibility_date` と `tsconfig.json` の `@cloudflare/workers-types/<date>` を同じ日付に揃える (本計画書では `<実装日 YYYY-MM-DD>` と書く、実装時に同日に置換)。
- `DISCORD_PUBLIC_KEY` は **Ed25519 公開鍵**。Secret 扱いしない → `wrangler.toml [vars]` に書く。Runtime secret として `wrangler secret put DISCORD_PUBLIC_KEY` を実行しない (spec §9 / architecture.md §7)。
- `DISCORD_BOT_TOKEN` は Phase 5 では投入しない。第 2 段階 (`stage2` 計画書) で投入する (最小特権原則、spec §12 step 22)。
- Workers Builds の Non-production branch builds: **無効**。
- Workers Builds の Build Secrets: 0 個。Build Variables は `BUN_VERSION` と `SKIP_DEPENDENCY_INSTALL` のみ Plain text。
- Cloudflare account_id: `b40fdc1cf09112832597f6e05f829cae`、custom API Token は auto-generated を使わず scope を絞って手動発行 (spec §8)。
- Workers Builds は Production branch (`main`) push でのみ自動デプロイ。preview build はオフ。
- branch protection の `Require status checks` を有効化するのは Phase 5 完了時 (CI workflow が一度走った後)。
- 本 Phase で `[[migrations]]` を含む deploy は **行わない**。第 2 段階で `tag = "v1" new_sqlite_classes = ["UserState"]` を初投入する (rollback 不可になるため第 1 段階では避ける)。

## Files

このフェーズで作成/変更するファイル:

- Create: `wrangler.toml` (第 1 段階版、DO/migrations なし)
- Create: `.dev.vars` (ローカルのみ、`.gitignore` 対象)
- Modify: `src/index.ts` (bootstrap 計画 Task 5 で雛形配置済み → 完全書き換え)
- Create: `src/interactions.ts` (PING/PONG dispatch の純粋ロジック)
- Create: `src/interactions.test.ts` (TDD でこれを先に書く)

このフェーズで作成しない (Phase 6 で作成):
- `src/handlers/**`, `src/durable-objects/**`, `src/lib/**`, `src/commands.ts`, `scripts/register-commands.ts`

## Interfaces

- Consumes (bootstrap 計画から):
  - `package.json` の `deploy` script (`wrangler deploy`)
  - `bun.lock`、`tsconfig.json`、`biome.json`、`vitest.config.ts`
  - `.github/workflows/ci.yml` の `Check` job
  - `scripts/check-pins.sh`
- Produces (stage2 計画へ):
  - `wrangler.toml` (DO binding と migrations は stage2 で追記)
  - `src/index.ts` から export: `default app` (Hono app)
  - `src/interactions.ts` から export: `dispatchInteraction(interaction)` 関数。**Phase 6 (stage2 Task 9) で戻り値型を kind-based discriminated union (`{ kind: 'pong' } | { kind: 'route'; name: 'stamina' | 'title' } | { kind: 'unknown' }`) に破壊的 refactor する** (env 依存を持つ handler を Hono context 側で呼ぶ設計に切替えるため)。Phase 5 のテストも Phase 6 で書き換える
  - `Bindings` type を `src/index.ts` から export (Phase 5 では `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` のみ、Phase 6 で `USER_STATE`, `TITLES`, `DISCORD_BOT_TOKEN` を追加)
  - Workers Builds の Production deployment URL (`https://stamina-reminder.<subdomain>.workers.dev`)

---

### Task 1: wrangler.toml 第 1 段階を作成

**Files:**
- Create: `wrangler.toml`

**Interfaces:**
- Consumes: Discord App の `APPLICATION ID` と `PUBLIC KEY` (bootstrap Task 2 で控えた値)
- Produces: `wrangler deploy` の対象設定 (DO 抜き)

- [ ] **Step 1: feature branch を作成**

```sh
git checkout main
git pull --rebase origin main
git checkout -b feat/stage1-wrangler-and-pingpong
```

期待: `feat/stage1-wrangler-and-pingpong` ブランチに居る。

- [ ] **Step 2: 実装日 (今日の日付) を控える**

Git Bash / Linux / macOS:

```sh
date +%Y-%m-%d
```

Windows PowerShell:

```powershell
Get-Date -Format 'yyyy-MM-dd'
```

期待: `2026-06-29` のような YYYY-MM-DD 形式。これを以下 Step 3 の `<実装日 YYYY-MM-DD>` 各位置と、`tsconfig.json` の `types: ["@cloudflare/workers-types/<date>", "bun"]` の date 部分に書き込む (`bun` は保持する、bootstrap Task 6 で同居設定済)。

- [ ] **Step 3: wrangler.toml を新規作成**

`Write` で以下を作成。`<実装日 YYYY-MM-DD>`、`<APPLICATION_ID>`、`<PUBLIC_KEY>` を実値に置換する:

```toml
name = "stamina-reminder"
main = "src/index.ts"
compatibility_date = "<実装日 YYYY-MM-DD>"
compatibility_flags = ["nodejs_compat"]
preview_urls = false
account_id = "b40fdc1cf09112832597f6e05f829cae"

[observability]
enabled = true

[vars]
DISCORD_APPLICATION_ID = "<APPLICATION_ID>"
DISCORD_PUBLIC_KEY = "<PUBLIC_KEY>"
```

注意:
- DO binding と `[[migrations]]` は **書かない** (Phase 6 で追加)
- `[[kv_namespaces]]` は Task 2 で追記
- `DISCORD_PUBLIC_KEY` は Ed25519 公開鍵 (Discord Developer Portal の General Information に明示される値)。`wrangler secret put DISCORD_PUBLIC_KEY` は **やらない**

- [ ] **Step 4: tsconfig.json の types 日付を一致させる (Bun 型は保持)**

`bootstrap` 計画 Task 6 で `"types": ["@cloudflare/workers-types/2026-06-01", "bun"]` と書いた場合、本 Task の `compatibility_date` と同じ日付に書き換える。**`"bun"` は引き続き保持する** (Stage2 の `scripts/register-commands.ts` が `Bun.file` / `import.meta.main` を使うため必須)。

`Edit` で `tsconfig.json` の対応行を `"types": ["@cloudflare/workers-types/<実装日 YYYY-MM-DD>", "bun"]` の実値に書き換える (例: `"types": ["@cloudflare/workers-types/2026-06-29", "bun"]`)。

確認:

```sh
bun run typecheck
```

期待: exit 0。`@cloudflare/workers-types` の該当日付パッケージが見つからない場合は `bun info @cloudflare/workers-types` で正しい日付に近い publish 履歴を確認し、`tsconfig.json` の値を最新の安定 dated subpath に合わせる。`bun` 型と `@cloudflare/workers-types` の同居で型衝突が出た場合は bootstrap Task 6 Step 1 の分離手順 (tsconfig.scripts.json を別途用意) に進む。

- [ ] **Step 5: tsconfig.json の Edit を確認 + 新規ファイルを stage して check-pins を実行**

Step 4 で `tsconfig.json` を Edit したことをまず確認 (`git diff tsconfig.json` で `compatibility_date` の日付が反映されている、`"bun"` が保持されていること)。

`scripts/check-pins.sh` は内部で `git grep` を使うため、`git add` していない untracked ファイルは scan 対象に入らない。新規 `wrangler.toml` と Edit 済の `tsconfig.json` の両方を先に stage してから check する:

```sh
git add wrangler.toml tsconfig.json
bun run check-pins
```

期待: exit 0。`<実装日 YYYY-MM-DD>` などの placeholder が全て置換済み。

万一 placeholder 検出で exit 1 が出たら、出力箇所を実値で置換 → **必ず `git add wrangler.toml tsconfig.json` を再実行** してから `bun run check-pins` を再走させる (index が古いままだと commit 時に古い内容が入る経路がある)。green になってから Step 6 に進む。

- [ ] **Step 6: commit (まだ KV namespace 未作成のため [[kv_namespaces]] は次タスクで追加)**

```sh
git add wrangler.toml tsconfig.json
git commit -m "feat: add wrangler config for stage 1 (no DO yet)"
```

`git add` を冗長に再実行することで、Step 5 の recovery で再 stage 漏れがあっても commit が確実に最新内容を含むようにする。

---

### Task 2: KV namespace TITLES を作成して wrangler.toml に追記

**Files:**
- Modify: `wrangler.toml` (`[[kv_namespaces]]` ブロック追加)

**Interfaces:**
- Consumes: `bunx wrangler kv namespace create` (要 Cloudflare 認証)
- Produces: namespace `TITLES` の id、`wrangler.toml` 内の binding `TITLES`

- [ ] **Step 1: KV namespace を作成**

```sh
bunx wrangler kv namespace create TITLES
```

期待: 出力例:

```
🌀 Creating namespace with title "stamina-reminder-TITLES"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "TITLES"
id = "abcdef0123456789abcdef0123456789"
```

`id` の値を控える。

- [ ] **Step 2: wrangler.toml に `[[kv_namespaces]]` を追記**

`Edit` で `wrangler.toml` の末尾 (`[vars]` ブロックの後) に以下を追加:

```toml

[[kv_namespaces]]
binding = "TITLES"
id = "<KV_NAMESPACE_ID>"
```

`<KV_NAMESPACE_ID>` を Step 1 出力の id に置換。

- [ ] **Step 3: wrangler dev の sanity check (実 deploy はしない)**

```sh
bunx wrangler dev --once
```

期待: `wrangler dev` が起動し、`Ready on http://localhost:8787`、KV TITLES binding が登録される (ローカル状態)。`Ctrl+C` で停止。

`--once` フラグが効かない wrangler バージョンの場合は単に `bunx wrangler dev` を実行し、起動メッセージを確認したら停止する。

- [ ] **Step 4: check-pins で `<KV_NAMESPACE_ID>` 残存をローカルで検出**

```sh
bun run check-pins
```

期待: exit 0。`<KV_NAMESPACE_ID>` が Step 2 で実 ID に置換されているはず。万一「✗ Placeholder found: <KV_NAMESPACE_ID>」が出たら Step 2 に戻って実 ID を書き直す。CI まで持ち越すと PR で初めて失敗する。

- [ ] **Step 5: commit**

```sh
git add wrangler.toml
git commit -m "feat: bind kv namespace titles to worker config"
```

---

### Task 3: src/interactions.ts と src/interactions.test.ts を TDD で作成

**Files:**
- Create: `src/interactions.test.ts`
- Create: `src/interactions.ts`

**Interfaces:**
- Consumes: なし (純粋関数)
- Produces:
  - `dispatchInteraction(interaction: { type: number }): { type: number; data?: { content: string; flags: number } }` を export
  - `interaction.type === 1` (PING) → `{ type: 1 }` (PONG)
  - `interaction.type === 2` (APPLICATION_COMMAND) → 一時的に「未対応のコマンド」と返す (Phase 6 で `/stamina` `/title` に分岐させる)
  - その他の type → 「未対応」と返す

- [ ] **Step 1: テストを書く (失敗する状態)**

`src/interactions.test.ts` を以下で作成:

```ts
import { describe, expect, it } from 'vitest';
import { dispatchInteraction } from './interactions';

describe('dispatchInteraction', () => {
  it('returns PONG for PING interaction', () => {
    const result = dispatchInteraction({ type: 1 });
    expect(result).toEqual({ type: 1 });
  });

  it('returns ephemeral fallback for unknown application command', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'unknown' },
    });
    expect(result).toEqual({
      type: 4,
      data: { content: '未対応のコマンド', flags: 64 },
    });
  });

  it('returns ephemeral fallback for unknown interaction type', () => {
    const result = dispatchInteraction({ type: 99 });
    expect(result).toEqual({
      type: 4,
      data: { content: '未対応のコマンド', flags: 64 },
    });
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

```sh
bun run test
```

期待: `src/interactions.test.ts` の 3 テストすべて fail (`./interactions` 未作成)。

- [ ] **Step 3: src/interactions.ts を最小実装**

`Write` で以下を作成:

```ts
type Interaction = {
  type: number;
  data?: { name?: string };
};

type InteractionResponse =
  | { type: 1 }
  | { type: 4; data: { content: string; flags: number } };

export function dispatchInteraction(interaction: Interaction): InteractionResponse {
  if (interaction.type === 1) {
    return { type: 1 };
  }
  return {
    type: 4,
    data: { content: '未対応のコマンド', flags: 64 },
  };
}
```

注意: Phase 6 で `interaction.type === 2 && interaction.data.name === 'stamina'` 等の分岐を追加する。Phase 5 ではあらゆる APPLICATION_COMMAND を fallback に流す。

- [ ] **Step 4: テスト pass を確認**

```sh
bun run test
```

期待: `dispatchInteraction` の 3 テストすべて pass。Phase 0〜3 で書いた `scripts/check-pins.test.ts` も引き続き pass。

- [ ] **Step 5: commit**

```sh
git add src/interactions.ts src/interactions.test.ts
git commit -m "feat: add interaction dispatch logic with ping/pong tests"
```

---

### Task 4: src/index.ts を Ed25519 verify + dispatchInteraction で実装

**Files:**
- Modify: `src/index.ts` (bootstrap Task 5 で置いた hono 雛形を完全に書き換え)

**Interfaces:**
- Consumes:
  - `hono` から `Hono`
  - `discord-interactions` から `verifyKey`
  - `./interactions` から `dispatchInteraction`
- Produces:
  - `export default app: Hono`
  - `Bindings` type (`DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` を含む)
  - POST `/interactions` の handler (Ed25519 verify → JSON parse → dispatchInteraction → JSON response)
  - GET `/healthz` の handler (`'ok'` を返す)

- [ ] **Step 1: src/index.ts を書く**

`Write` で完全に上書き:

```ts
import { Hono } from 'hono';
import { verifyKey } from 'discord-interactions';
import { dispatchInteraction } from './interactions';

export type Bindings = {
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.post('/interactions', async (c) => {
  const sig = c.req.header('x-signature-ed25519') ?? '';
  const ts = c.req.header('x-signature-timestamp') ?? '';
  const body = await c.req.text();

  const valid = await verifyKey(body, sig, ts, c.env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return c.text('invalid signature', 401);
  }

  const interaction = JSON.parse(body) as { type: number; data?: { name?: string } };
  const response = dispatchInteraction(interaction);
  return c.json(response);
});

app.get('/healthz', (c) => c.text('ok'));

export default app;
```

注意:
- `verifyKey` は discord-interactions v4 で **async**。必ず `await`。
- `c.req.text()` で raw body を取得してから JSON.parse する (Hono の自動 parser に渡すと署名検証用の raw body が失われるため)。
- Phase 6 で `Bindings` に `USER_STATE: DurableObjectNamespace`、`TITLES: KVNamespace`、`DISCORD_BOT_TOKEN: string` を追加し、`export { UserState } from './durable-objects/user-state'` も加える。

- [ ] **Step 2: typecheck と lint を通す**

```sh
bun run typecheck
bun run lint:code
```

期待: 両方 exit 0。

- [ ] **Step 3: bun run check 全体 green**

```sh
bun run check
```

期待: `lint:code` / `typecheck` / `test` がすべて pass。

- [ ] **Step 4: commit**

```sh
git add src/index.ts
git commit -m "feat: implement hono entry with ed25519 verify and ping handler"
```

---

### Task 5: .dev.vars を作成 (ローカルのみ)

**Files:**
- Create: `.dev.vars` (`.gitignore` 済、commit しない)

**Interfaces:**
- Consumes: bootstrap Task 2 で控えた `DISCORD_APPLICATION_ID` / `DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN`
- Produces: `wrangler dev` および (Phase 6 の) `bun run register-commands` が読むローカル env

- [ ] **Step 1: .dev.vars を新規作成**

`Write` で `.dev.vars` を作成:

```
DISCORD_APPLICATION_ID=<APPLICATION_ID>
DISCORD_PUBLIC_KEY=<PUBLIC_KEY>
DISCORD_BOT_TOKEN=<BOT_TOKEN>
# 開発中に guild scope に登録したい時のみ設定 (Phase 6 の register-commands で参照)
# DISCORD_GUILD_ID=
```

`<APPLICATION_ID>` / `<PUBLIC_KEY>` / `<BOT_TOKEN>` を bootstrap Task 2 で控えた実値に置換。

- [ ] **Step 2: .gitignore に含まれているか確認**

```sh
git check-ignore .dev.vars
```

期待: `.dev.vars` が出力される (= ignored、commit 対象外)。

万一 `git check-ignore` が無出力で `git status` に .dev.vars が候補として上がる場合は、bootstrap Task 11 の `.gitignore` が壊れていないか確認 (`.dev.vars` と `.dev.vars.*` の両エントリが残っている必要)。

- [ ] **Step 3: wrangler dev で .dev.vars が読まれることを確認**

```sh
bunx wrangler dev --once
```

または:

```sh
bunx wrangler dev
```

期待: `Ready on http://localhost:8787` と表示され、`Vars`/`Secrets` セクション (起動ログ) に `DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY`、`DISCORD_BOT_TOKEN` が現れる (`wrangler dev` は `.dev.vars` を自動読込)。`Ctrl+C` で停止。

- [ ] **Step 4: ローカルで /healthz を叩く**

`wrangler dev` を起動しておく:

```sh
bunx wrangler dev
```

別ターミナルから:

```sh
curl -s http://127.0.0.1:8787/healthz
```

期待: `ok`。

- [ ] **Step 5: ローカルで /interactions に invalid signature を投げて 401 を確認**

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8787/interactions \
  -H "content-type: application/json" \
  -H "x-signature-ed25519: 00" \
  -H "x-signature-timestamp: 0" \
  -d '{"type":1}'
```

期待: `401`。

`wrangler dev` を `Ctrl+C` で停止。

- [ ] **Step 6: commit はしない (.dev.vars は ignored)**

`git status` で `.dev.vars` が出てこないことを確認:

```sh
git status
```

期待: `.dev.vars` がリストに無い (= ignored で正常)。

---

### Task 6: Cloudflare 側 - custom API Token を発行

**Files:**
- なし (Cloudflare ダッシュボード上の作業のみ)

**Interfaces:**
- Consumes: Cloudflare アカウント (`9c5s`, account_id `b40fdc1cf09112832597f6e05f829cae`)
- Produces: scope を絞った custom API Token (Workers Builds で使用)

- [ ] **Step 1: API Tokens ページを開く**

`https://dash.cloudflare.com/profile/api-tokens` を開く → `Create Token` → `Get started` (Custom token)。

- [ ] **Step 2: Permissions を設定 (spec §8 と一致)**

以下 4 つを追加:
- Account → **Workers Scripts: Edit**
- Account → **Workers KV Storage: Read**
- Account → **Account Settings: Read**
- User → **User Details: Read** (CF の API Token UI 上は User スコープ。category dropdown を `User` に切り替えてから選ぶ)

Account Resources: `Include → Specific account → 9c5s (b40fdc1cf09112832597f6e05f829cae)`。

Client IP Address Filtering / TTL は空 (デフォルト)。

`Continue to summary` → `Create Token`。

- [ ] **Step 3: token を安全に控える**

token は再表示されない。`D:\projects\cloudflare\.secrets\stamina-reminder-builds-token` 等のローカル secrets ファイル、またはパスワードマネージャに保存。

注意: GitHub / Discord / 本リポジトリの commit には絶対に含めない。

---

### Task 7: Cloudflare Workers Builds で GitHub OAuth 連携と API Token 差し替え

**Files:**
- なし (Cloudflare ダッシュボード上の作業のみ)

**Interfaces:**
- Consumes: GitHub repo `9c5s/stamina-reminder`、Task 6 で発行した custom API Token
- Produces: Workers Builds が `main` push で自動デプロイする状態 (build/deploy command 設定済)

- [ ] **Step 1: Worker プロジェクトを Cloudflare 側で作る (まだ無ければ)**

ダッシュボード → `Workers & Pages` → `Create` → `Create Worker` → 名前 `stamina-reminder` → `Deploy` (空のテンプレを 1 回 deploy して Worker を出現させる)。

注意: この時点で deploy された worker は空テンプレで OK。Task 9 以降で `main` push 経由の deploy に置き換わる。

- [ ] **Step 2: Git Integration を有効化**

`Workers & Pages → stamina-reminder → Settings → Build` → `Git Integration` → `Connect to Git provider` → GitHub → OAuth 承認 → リポジトリ `9c5s/stamina-reminder` を選択。

- [ ] **Step 3: API Token を custom token に差し替え**

同 `Settings → Build` 画面の `API Token` セクションで、auto-generated token を削除して **Task 6 で発行した custom token** に貼り替える。

- [ ] **Step 4: Build command と Deploy command を設定**

- Branch (Production branch): `main`
- Build command: `bun install --frozen-lockfile --ignore-scripts`
- Deploy command: `bun run deploy`
- Root directory: `/` (空欄でも OK、`/` 明示が確実)

- [ ] **Step 5: Non-production branch builds を OFF**

同画面の `Non-production branch builds` (または `Preview deployments`) を **無効**。チームでなく 1 人運用のため preview の利点が薄く、Secret 露出回避を優先する。

- [ ] **Step 6: 保存して設定完了を確認**

`Save` を押下し、`Settings → Build` 画面に保存された値が表示されることを確認。

---

### Task 8: Workers Builds の Build Variables に BUN_VERSION と SKIP_DEPENDENCY_INSTALL を登録

**Files:**
- なし (Cloudflare ダッシュボード上の作業のみ)

**Interfaces:**
- Consumes: bootstrap Task 1 Step 2 で控えた Bun バージョン
- Produces: build image が Bun を当該 version に切り替える状態、`SKIP_DEPENDENCY_INSTALL=1` で CF 自動 install を抑止

- [ ] **Step 1: Build Variables 画面を開く**

`Workers & Pages → stamina-reminder → Settings → Variables and Secrets → Build Variables and Secrets`。

- [ ] **Step 2: BUN_VERSION を追加**

- Name: `BUN_VERSION`
- Type: **Plain text**
- Value: `<BUN_VERSION_PIN>` (bootstrap Task 5 の `package.json` `packageManager` と同値)

- [ ] **Step 3: SKIP_DEPENDENCY_INSTALL を追加**

- Name: `SKIP_DEPENDENCY_INSTALL`
- Type: **Plain text**
- Value: `1`

- [ ] **Step 4: 保存して両 var が表示されることを確認**

注意: Discord 関連の値は **ここ (Build Variables) には置かない**。
- **Secret** (`DISCORD_BOT_TOKEN`) は Phase 6 (stage2 Task 15) で Cloudflare Runtime secrets に `wrangler secret put` で投入する
- **公開値** (`DISCORD_APPLICATION_ID` / `DISCORD_PUBLIC_KEY`) は `wrangler.toml [vars]` (worker config 経由) に literal で commit する (Ed25519 公開鍵は secret 扱いしない、spec §9)

---

### Task 9: PR を作成して main にマージ → Workers Builds が自動 deploy

**Files:**
- なし (GitHub / Cloudflare 側の動作確認)

**Interfaces:**
- Consumes: feature branch `feat/stage1-wrangler-and-pingpong` (Task 1 〜 4 の commit を含む)
- Produces: `main` 上に Phase 5 のコード、Cloudflare 上に Production deployment

- [ ] **Step 1: feature branch を push**

```sh
git push -u origin feat/stage1-wrangler-and-pingpong
```

- [ ] **Step 2: PR 作成**

```sh
gh pr create \
  --base main \
  --head feat/stage1-wrangler-and-pingpong \
  --title "feat: stage 1 worker with ping/pong" \
  --body "$(cat <<'EOF'
## Summary
- `wrangler.toml` 第 1 段階 (`[vars]` と KV TITLES、DO migrations 抜き)
- `src/interactions.ts` を TDD で実装 (PING -> PONG dispatch)
- `src/index.ts` を Hono + Ed25519 verify + dispatchInteraction で実装
- `.dev.vars` をローカル作成 (commit せず)
- Cloudflare Workers Builds の OAuth 連携 / custom API Token 差し替え / Build/Deploy command / Build Variables (BUN_VERSION + SKIP_DEPENDENCY_INSTALL) を設定

## Test plan
- [x] `bun run check` green (lint:code, typecheck, test)
- [x] `bun run check-pins` green
- [x] `bunx wrangler dev` でローカル起動、`/healthz` が `ok` を返す
- [x] `bunx wrangler dev` で `/interactions` に invalid signature を投げて 401
- [ ] CI workflow が PR で green
- [ ] PR merge 後、Workers Builds が `main` push を検知して deploy 開始
- [ ] Discord Developer Portal の Interactions Endpoint URL 登録に成功

## Related
- `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (round 13 PASS)
- `docs/superpowers/plans/2026-06-29-stamina-reminder-stage1.md` (本計画)
EOF
)"
```

期待: PR URL が出力。

- [ ] **Step 3: CI workflow が green になるまで watch**

```sh
gh pr checks --watch
```

期待: `Check` job が green になる。

- [ ] **Step 4: PR を rebase merge**

```sh
gh pr merge --rebase --delete-branch
```

期待: PR が rebase merge され、feature branch が削除される。

- [ ] **Step 5: Workers Builds がトリガーされたか確認**

ブラウザ: `Workers & Pages → stamina-reminder → Deployments` を開き、新しい build が走り始めたか確認 (Status: `In progress` → 数分で `Success` または `Failed`)。

CLI:

```sh
bunx wrangler deployments list --name stamina-reminder
```

期待: 最新行に `Trigger: builds.cloudflare.com` 等のエントリが現れる。

- [ ] **Step 6: deploy 失敗時のリカバリ**

失敗ログを Cloudflare dashboard で確認:
- `bun install --frozen-lockfile --ignore-scripts` で `EBADLOCKFILE` 系のエラー → bootstrap Task 5 Step 6 に戻り、ローカルで `bun install --ignore-scripts` を再実行して bun.lock を再生成、commit して push
- `bun run deploy` で `wrangler` 未インストール → `package.json` の `devDependencies.wrangler` の pin が解決できているか、`bun.lock` が古くないか確認
- `wrangler deploy` の認証エラー → Task 6/7 の custom API Token のスコープを再確認 (Account Workers Scripts Edit / Workers KV Storage Read / Account Settings Read / User Details Read)
- `KVNamespace not found` → Task 2 で `bunx wrangler kv namespace create TITLES` の出力 id を `wrangler.toml` に書き戻したか確認

- [ ] **Step 7: deploy 成功後、Worker URL を控える**

dashboard の `Workers & Pages → stamina-reminder` 上部に `https://stamina-reminder.<subdomain>.workers.dev` のような URL が出る (= `*.workers.dev` の subdomain は Cloudflare アカウントごとに固定)。これを Task 11 で Discord に登録する。

ローカルからも確認可:

```sh
curl -s https://stamina-reminder.<subdomain>.workers.dev/healthz
```

期待: `ok`。

---

### Task 10: branch protection の後段 (Require status checks = Check) を有効化

**Files:**
- なし (GitHub UI または gh CLI 経由の設定のみ)

**Interfaces:**
- Consumes: Task 9 で完走した `Check` job (= status check 名 `Check` が GitHub に登録される)
- Produces: `main` への直接 push と `Check` 失敗時の merge をブロックする状態

- [ ] **Step 1: GitHub UI で branch protection ルールを編集**

`Settings → Branches → main → Edit` を開く:

- `Require status checks to pass before merging`: **ON**
  - `Status checks that are required` で `Check` を検索して追加 (= `.github/workflows/ci.yml` の job 名)
  - `Require branches to be up to date before merging`: **ON** (linear history と相性が良い)

`Save changes`。

注意: GitHub REST API `PUT /repos/{owner}/{repo}/branches/{branch}/protection` は `required_status_checks` / `enforce_admins` / `required_pull_request_reviews` / `restrictions` の 4 フィールドがすべて required で、省略すると 422 を返す (https://docs.github.com/en/rest/branches/branch-protection)。`gh api` で書き換えたい場合は以下のように JSON body をフルで指定する (UI 経由が無難):

```sh
gh api -X PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  repos/9c5s/stamina-reminder/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Check"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
```

`restrictions: null` は「push 制限なし (= protection は PR 経由のみ強制)」を意味する。`enforce_admins: true` は admin にも保護を適用する (1 人運用なら admin = 自分なので、必要なら一時的に false にしてバイパスできる)。bootstrap Task 4 Step 2 で前段を入れたのと同じ rule を上書きする扱いになるため、bootstrap で入れた他フィールド (PR 必須・linear history 等) も上記 JSON body に含めて upsert する必要がある。漏れがあると bootstrap の前段保護まで剥がれる。**よって UI 経由 (上記 Save changes) が確実**。

- [ ] **Step 2: 設定確認**

```sh
gh api repos/9c5s/stamina-reminder/branches/main/protection --jq '.required_status_checks'
```

期待: `{"strict": true, "contexts": ["Check"], ...}`。

---

### Task 11: Discord Interactions Endpoint URL を登録 (Stage 1 検証)

**Files:**
- なし (Discord Developer Portal 上の作業)

**Interfaces:**
- Consumes: Task 9 Step 7 で控えた Worker URL
- Produces: Discord 側に署名済 PING を Worker が PONG で返した状態

- [ ] **Step 1: wrangler tail を起動 (Stage 1 検証用)**

別ターミナルで:

```sh
bunx wrangler tail stamina-reminder --format pretty
```

期待: `Connected to stamina-reminder, waiting for logs...`。このまま待機。

- [ ] **Step 2: Discord Developer Portal で Endpoint URL を設定**

`https://discord.com/developers/applications/<APPLICATION_ID>/information` (bootstrap Task 2 で作った Application) を開く。

`General Information` セクションの `Interactions Endpoint URL` 欄に:

```
https://stamina-reminder.<subdomain>.workers.dev/interactions
```

を入力 → `Save Changes`。

期待: Discord 側が署名付き PING を Worker に送信 → Worker が Ed25519 verify → 200 で `{type:1}` を返す → Discord 画面に **「成功」** と表示される。

- [ ] **Step 3: wrangler tail のログを確認**

Step 1 のターミナルに POST `/interactions` のログ行が現れる。

期待:
- `POST /interactions` 200 (1 行以上)
- error / Ed25519 関連の警告なし

- [ ] **Step 4: 失敗時のリカバリ**

Discord 画面に「失敗」が出る場合:

(a) Worker URL が間違っている → `Workers & Pages → stamina-reminder` のドメイン名を再確認、URL に `/interactions` パスが付いているか確認

(b) Ed25519 verify が落ちている → `wrangler tail` のログに `invalid signature` の 401 行が出る → `wrangler.toml` の `[vars] DISCORD_PUBLIC_KEY` と Discord Developer Portal の `Public Key` 値が一致しているか確認。差し替えるなら:

```sh
git checkout main
git pull --rebase origin main
git checkout -b fix/stage1-public-key
# wrangler.toml の DISCORD_PUBLIC_KEY を正しい値に Edit
git add wrangler.toml
git commit -m "fix: correct discord public key in vars"
git push -u origin fix/stage1-public-key
gh pr create --base main --head fix/stage1-public-key --title "fix: correct discord public key" --body "stage 1 endpoint url 登録失敗の修正"
# CI green → rebase merge → Workers Builds 自動 deploy → 再度 Endpoint URL 登録試行
```

(c) Worker がそもそも応答していない → `curl -s https://stamina-reminder.<subdomain>.workers.dev/healthz` で `ok` が返るか確認、CF dashboard の Deployments で最新 build が `Success` か確認

- [ ] **Step 5: wrangler tail を停止して Stage 1 完了**

ターミナルで `Ctrl+C`。

Stage 1 検証 (spec §13.3 Stage 1) のチェック項目:
- [x] Workers Builds の最新 deploy が Success
- [x] `/healthz` が 200 `ok`
- [x] Endpoint URL 登録に成功
- [x] tail に Ed25519 関連 error なし

すべて green であれば Phase 5 完了。次は `2026-06-29-stamina-reminder-stage2.md` (Phase 6) へ進む。

---

## Self-Review (writer 用)

**1. Spec coverage:**
- HANDOFF.md Phase 4 (wrangler.toml と Cloudflare 設定): Task 1, 2, 6, 7, 8 で網羅
- HANDOFF.md Phase 5 (第 1 段階デプロイ): Task 3, 4, 5, 9, 10, 11 で網羅
- spec §12 step 12 (wrangler.toml 第 1 段階): Task 1, 2
- spec §12 step 13 (custom API Token): Task 6
- spec §12 step 14 (OAuth 連携 + API Token 差し替え): Task 7
- spec §12 step 15 (Build/Deploy command + Production branch + Non-prod off): Task 7 Step 4-5
- spec §12 step 16 (Build Variables BUN_VERSION + SKIP_DEPENDENCY_INSTALL): Task 8
- spec §12 step 17 (.dev.vars 作成): Task 5
- spec §12 step 18 (第 1 段階 src/index.ts + PR + deploy): Task 3, 4, 9
- spec §12 step 19 (branch protection 後段): Task 10
- spec §12 step 20 (Discord Endpoint URL 登録 + 検証): Task 11
- spec §13.3 Stage 1 検証: Task 11 Step 5 のチェックリスト

**2. Placeholder scan:**
本計画書内で意図的に残している placeholder:
- `<BUN_VERSION_PIN>` (Task 8 Step 2、bootstrap Task 1 Step 2 でメモした値で置換)
- `<実装日 YYYY-MM-DD>` (Task 1 Step 2 で `date` 取得 → Step 3 で置換)
- `<APPLICATION_ID>` (bootstrap Task 2 で控えた値、Task 1 Step 3 と Task 5 Step 1 で置換)
- `<PUBLIC_KEY>` (同上、Task 1 Step 3 と Task 5 Step 1 で置換)
- `<BOT_TOKEN>` (bootstrap Task 2 で控えた値、Task 5 Step 1 で置換、commit はしない)
- `<KV_NAMESPACE_ID>` (Task 2 Step 1 の `bunx wrangler kv namespace create` 出力で置換、Task 2 Step 4 の `bun run check-pins` で残存チェック)
- `<subdomain>` (Task 9 Step 7 で Worker URL から取得して、Task 11 Step 2 / 4 / 5、Task 9 Step 7 自身、Task 5 Step 5 以外の手順内 URL に置換)
- `<APP_ID>` は Task 11 Step 2 の URL 内の Discord Application ID を指す

これらは本計画書が `docs/superpowers/plans/` 配下に置かれるため `scripts/check-pins.sh` の placeholder scan 除外 allowlist に含まれ scan されない。リポジトリ実体 (`wrangler.toml` / `.dev.vars`) に書く時に必ず実値に置換すること。`.dev.vars` は ignored で commit されないため check-pins.sh が走らないファイル。`wrangler.toml` は commit される → check-pins.sh が走る → `<APPLICATION_ID>` / `<PUBLIC_KEY>` / `<KV_NAMESPACE_ID>` / `<実装日 YYYY-MM-DD>` が残っていたら検出される (bootstrap Task 10 の scan rule)。Task 1 Step 5 / Task 2 Step 4 でローカルに先回り検出する手順を入れた。

secret-like literal scan (Round 4 + Round 5 反映、bootstrap Task 10):
- 検出対象: `DISCORD_BOT_TOKEN` の右辺が `<...>` placeholder でなく 20 文字以上の英数記号列 (`Bot ` / `Bearer ` prefix 可)
- 検出対象外: `DISCORD_PUBLIC_KEY` は Ed25519 **公開鍵** のため、`wrangler.toml [vars]` に 64 hex literal で commit するのが正式仕様 (spec §9 / architecture §7)。secret-like scan からは除外する
- scan 範囲: `docs/` と `scripts/check-pins.*` のみ除外、`HANDOFF.md` も含めて全範囲を scan

writer / 実装者は本仕様を踏まえて、`wrangler.toml` の `DISCORD_PUBLIC_KEY` には実 64 hex を書いて OK だが、`DISCORD_BOT_TOKEN` は絶対に literal を書かないこと (Cloudflare Runtime secret + `.dev.vars` のみ)。

placeholder 以外の禁止表現 ("TBD", "TODO", "実装は後で", "適切なエラーハンドリング", "Task N と同様") は使っていない。

**3. Type consistency:**
- `Bindings` type (`src/index.ts` で export): Phase 5 では `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` のみ。Phase 6 で `USER_STATE`, `TITLES`, `DISCORD_BOT_TOKEN` を追加することを Interfaces セクションで明示済。stage2 計画書側で `Bindings` を拡張する際に同じ綴りで参照する。
- `dispatchInteraction` (`src/interactions.ts` で export): Phase 5 では引数 `{ type: number; data?: { name?: string } }`、戻り値 `{ type: 1 } | { type: 4; data: ... }`。**Phase 6 (stage2 計画書 Task 9) で kind-based discriminated union (`{ kind: 'pong' } | { kind: 'route'; name: 'stamina' | 'title' } | { kind: 'unknown' }`) に refactor 予定**。理由: Phase 6 で `/stamina` `/title` の handler 呼出が env (Bindings) 依存になるため、純粋関数の `dispatchInteraction` では Hono context を扱えず、kind だけ返して `src/index.ts` 側で副作用 (handler 呼出) を行う設計が綺麗になるため。Phase 5 のテストは Phase 6 Task 9 で書き換える。
- KV binding 名 `TITLES` は本計画書 Task 2 と Phase 6 で同綴り。
- ファイル名 `wrangler.toml`、`src/index.ts`、`src/interactions.ts`、`src/interactions.test.ts`、`.dev.vars` は本計画書内で表記揺れなし。
- branch protection の status check 名 `Check` は bootstrap Task 14 Step 7 / 本計画 Task 10 で同綴り (= `.github/workflows/ci.yml` の `jobs.check.name: Check`)。
