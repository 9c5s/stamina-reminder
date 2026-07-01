# Stamina Reminder - Architecture (Hono + Workers)

最終更新: 2026-06-29

> **CI/CD 部分は本書に優先する確定仕様あり**: `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (Codex 13 round で一次資料突合せ済み、PASS)。本書のうち `wrangler.toml` / `register-commands.ts` / セットアップ手順 / `.dev.vars` / secrets 管理に関する記述は CI/CD spec が真。本書はアプリケーション層の設計とコード雛形を主目的とする。

## 1. 用途・要件

Discord 上の個人用スタミナ管理 bot。

- ユーザーが Slash コマンドで現在のスタミナを登録
- bot 側はタイトル別の最大値・回復速度を保持
- 満タン時刻になったら同じチャンネルでリプライ通知
- スケール: ユーザー数 1、投稿/通知ともに 1 日数回

## 2. アーキテクチャ概要

```
Discord                              Cloudflare
  ┌─────────────────┐                 ┌──────────────────────────────────────────┐
  │ HTTP POST       │  Interaction    │ Hono App (Worker fetch handler)           │
  │ /interactions   ├────────────────►│   ├─ Ed25519 verify middleware            │
  │                 │                 │   ├─ PING -> PONG                         │
  │                 │◄────────────────│   ├─ /stamina add/list/cancel             │
  └─────────────────┘                 │   └─ /title add/list/remove               │
                                      │            │                              │
                                      │            └─RPC─► UserState DO           │
                                      │                      (idFromName=user_id) │
                                      │                      ├─ SQLite (stamina)  │
  ┌─────────────────┐  REST POST      │                      ├─ setAlarm(満タン時刻)│
  │ Discord REST    │◄────────────────│ ─◄──── alarm() ──────┤                    │
  └─────────────────┘                 │                      └─ KV(TITLES) 読み込み│
                                      │                                           │
                                      │ KV (TITLES) タイトルマスタ                  │
                                      └──────────────────────────────────────────┘
```

設計の柱:
- Worker は Hono で薄く、Interactions Endpoint だけを受ける
- ユーザー状態は per-user の Durable Object に置く (`idFromName(user_id)` で 1 ユーザー 1 個)
- 通知スケジュールは DO の `alarm()` API (1 ミリ秒粒度、at-least-once、指数バックオフ最大 6 回)
- タイトルマスタは KV (動的に追加可能)
- GatewayShard / Cron Triggers / Message Content Intent はすべて不要

## 3. 採用技術スタック

| レイヤ | 採用 | 備考 |
|---|---|---|
| ランタイム | Cloudflare Workers | エッジ実行 |
| Webフレームワーク | Hono v4 | Workers デファクト |
| 状態管理 | Durable Objects (SQLite backend) | per-user、alarm 連携 |
| マスタ管理 | KV | エッジキャッシュで読み高速 |
| 言語 | TypeScript | |
| Discord SDK | `discord-interactions` (verifyKey, type enum) | async API |
| Discord 型 | `discord-api-types` | TypeScript 型 (必要に応じて) |
| デプロイ | wrangler | |

## 4. スラッシュコマンド設計 (フル)

| コマンド | 引数 | 動作 |
|---|---|---|
| `/stamina add` | `title:string` `current:integer` | 現在スタミナを記録、満タン時刻を計算して setAlarm |
| `/stamina list` | (なし) | 自分の登録中スタミナ一覧 (満タン時刻付き) |
| `/stamina cancel` | `title:string` | 指定タイトルのスケジュールを取り消し |
| `/title add` | `name:string` `max:integer` `regen_minutes:integer` | タイトルマスタを KV に登録 (内部は秒に変換して保持) |
| `/title list` | (なし) | KV のタイトルマスタ一覧 |
| `/title remove` | `name:string` | KV からタイトル削除 |

オプション: `/stamina add` の `title` を choice (Discord の autocomplete 機能) にすると入力ミスが減る。ただし choices は最大 25 件・固定なので、Autocomplete Interaction (Type 4) で動的に KV を引いて返すのが理想 (実装難易度は中)。最初はプレーンな string 引数で十分。

## 5. データ層

### KV (TITLES) - タイトルマスタ
- key: `title:<name>` (例: `title:プリコネ`)
- value: JSON `{ "name": "プリコネ", "max": 99, "regen_minutes_per_point": 6 }`
- 読み: スタミナ登録時 / list 時
- 書き: `/title add`, `/title remove` 時

### UserState DO 内蔵 SQLite
```sql
CREATE TABLE IF NOT EXISTS stamina (
  title_name  TEXT NOT NULL,
  current     INTEGER NOT NULL,
  full_at_ms  INTEGER NOT NULL,
  channel_id  TEXT NOT NULL,
  registered_at_ms INTEGER NOT NULL,
  PRIMARY KEY (title_name)
);
```
- `user_id` は DO ID (`state.id.name`) で持つので column 不要
- `channel_id` は通知先 (登録時に Interaction の `channel_id` を入れる)
- `registered_at_ms` は表示や at-least-once での重複判定に使う

`alarm()` が走ったら `full_at_ms <= now` の行を取り出して通知、行は削除、残行があれば次の最小 `full_at_ms` で再 `setAlarm`。

## 6. ファイル構成

```
D:\projects\stamina-reminder\
├── HANDOFF.md                     # 引き継ぎ書 (リポジトリの README 兼用)
├── docs\
│   ├── architecture.md            # この文書 (アプリ層の設計)
│   └── superpowers\
│       └── specs\
│           └── 2026-06-29-github-cicd-design.md  # CI/CD 確定仕様
├── .github\
│   ├── workflows\
│   │   └── ci.yml                 # GitHub Actions check job
│   └── dependabot.yml             # bun + github-actions の週次更新
├── src\
│   ├── index.ts                   # Hono entry + Ed25519 middleware
│   ├── commands.ts                # スラッシュコマンド JSON 定義
│   ├── handlers\
│   │   ├── stamina.ts             # /stamina の処理
│   │   └── title.ts               # /title の処理
│   ├── durable-objects\
│   │   └── user-state.ts          # UserState DO
│   └── lib\
│       ├── discord-rest.ts        # Discord REST 共通クライアント
│       └── titles.ts              # KV からタイトル取得
├── scripts\
│   ├── register-commands.ts       # コマンド一括登録 (Bun.file + .dev.vars)
│   └── check-pins.sh              # SHA / placeholder の残存検出
├── wrangler.toml
├── package.json
├── bun.lock                       # 必ず commit する
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── lefthook.yml
├── commitlint.config.ts
├── .gitignore
└── .dev.vars                      # ローカル開発用 (.gitignore 対象)
```

## 7. wrangler.toml サンプル

CI/CD spec §12 のフェーズ分割に従い、**第 1 段階 (PING/PONG のみ)** では DO binding と `[[migrations]]` を入れず、第 2 段階 (UserState 実装と同じ PR) で追加する。

第 1 段階の完成形:

```toml
name = "stamina-reminder"
main = "src/index.ts"
compatibility_date = "<実装日 YYYY-MM-DD>"
compatibility_flags = ["nodejs_compat"]
preview_urls = false                     # preview build 無効化 (CI/CD spec §8 と整合)
account_id = "b40fdc1cf09112832597f6e05f829cae"  # 9c5s、複数アカウントから迷わないように明示

[observability]
enabled = true

# ---------- Public な値は [vars] (Secret ではない) ----------
[vars]
DISCORD_APPLICATION_ID = "<APPLICATION_ID>"
DISCORD_PUBLIC_KEY = "<PUBLIC_KEY>"   # Ed25519 公開鍵、Secret 扱いしない

# ---------- KV ----------
[[kv_namespaces]]
binding = "TITLES"
id = "<bunx wrangler kv namespace create TITLES の出力 ID>"
```

第 2 段階で追加するブロック:

```toml
# ---------- Durable Objects ----------
[[durable_objects.bindings]]
name = "USER_STATE"
class_name = "UserState"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserState"]
```

シークレット (= 真に秘密な値だけ) は `bunx wrangler secret put` で投入:
- `DISCORD_BOT_TOKEN` (alarm() の通知 REST 認証用、**第 2 段階 deploy 後**に投入して最小特権を維持)

`DISCORD_APPLICATION_ID` と `DISCORD_PUBLIC_KEY` は **Secret ではなく `[vars]`** に置く (旧版で `wrangler secret put` の対象としていた記述は撤回)。`DISCORD_PUBLIC_KEY` は Ed25519 検証用の公開鍵で、Discord Developer Portal にも明示される情報のため。

## 8. コード雛形

### 8.1 `src/index.ts` (Hono entry)
```ts
import { Hono } from 'hono';
import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from 'discord-interactions';
import { handleStamina } from './handlers/stamina';
import { handleTitle } from './handlers/title';

export { UserState } from './durable-objects/user-state';

export type Bindings = {
  USER_STATE: DurableObjectNamespace;
  TITLES: KVNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
};

type Variables = {
  interaction: any;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Ed25519 検証 + JSON parse をミドルウェアに集約
app.use('/interactions', async (c, next) => {
  const sig = c.req.header('x-signature-ed25519') ?? '';
  const ts = c.req.header('x-signature-timestamp') ?? '';
  const body = await c.req.text();
  const valid = await verifyKey(body, sig, ts, c.env.DISCORD_PUBLIC_KEY);
  if (!valid) return c.text('invalid signature', 401);
  c.set('interaction', JSON.parse(body));
  await next();
});

app.post('/interactions', async (c) => {
  const interaction = c.get('interaction');

  if (interaction.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const name = interaction.data?.name as string;
    if (name === 'stamina') return handleStamina(c, interaction);
    if (name === 'title') return handleTitle(c, interaction);
  }

  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未対応のコマンド', flags: 64 }, // EPHEMERAL
  });
});

app.get('/healthz', (c) => c.text('ok'));

export default app;
```

### 8.2 `src/handlers/stamina.ts`
```ts
import type { Context } from 'hono';
import { InteractionResponseType } from 'discord-interactions';
import type { Bindings } from '../index';

export async function handleStamina(c: Context<{ Bindings: Bindings }>, interaction: any) {
  const sub = interaction.data.options?.[0];
  if (!sub) return errorReply(c, 'サブコマンド指定なし');

  const userId =
    interaction.member?.user?.id ?? interaction.user?.id ?? 'anon';
  const stub = c.env.USER_STATE.get(c.env.USER_STATE.idFromName(userId));

  // Hono の Service Binding と違い、DO は fetch で呼ぶ
  const resp = await stub.fetch(
    new Request('https://do/stamina', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sub_name: sub.name,
        options: sub.options ?? [],
        channel_id: interaction.channel_id,
      }),
    }),
  );

  const body = await resp.text();
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: body, flags: 64 },
  });
}

function errorReply(c: Context, msg: string) {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}
```

### 8.3 `src/handlers/title.ts`
```ts
import type { Context } from 'hono';
import { InteractionResponseType } from 'discord-interactions';
import type { Bindings } from '../index';

export async function handleTitle(c: Context<{ Bindings: Bindings }>, interaction: any) {
  const sub = interaction.data.options?.[0];
  if (!sub) return errorReply(c, 'サブコマンド指定なし');

  const opts: Record<string, any> = {};
  for (const opt of sub.options ?? []) opts[opt.name] = opt.value;

  switch (sub.name) {
    case 'add': {
      const name = opts.name as string;
      const max = opts.max as number;
      const regen = opts.regen_minutes as number;
      await c.env.TITLES.put(
        `title:${name}`,
        JSON.stringify({ name, max, regen_minutes_per_point: regen }),
      );
      return ok(c, `${name} を登録 (max=${max}, regen=${regen}min/pt)`);
    }
    case 'list': {
      const list = await c.env.TITLES.list({ prefix: 'title:' });
      if (!list.keys.length) return ok(c, 'タイトル未登録');
      const lines: string[] = [];
      for (const k of list.keys) {
        const raw = await c.env.TITLES.get(k.name);
        if (raw) {
          const t = JSON.parse(raw);
          lines.push(`- ${t.name}: max=${t.max}, regen=${t.regen_minutes_per_point}min/pt`);
        }
      }
      return ok(c, lines.join('\n'));
    }
    case 'remove': {
      const name = opts.name as string;
      await c.env.TITLES.delete(`title:${name}`);
      return ok(c, `${name} を削除`);
    }
  }
  return errorReply(c, '未対応のサブコマンド');
}

function ok(c: Context, msg: string) {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}

function errorReply(c: Context, msg: string) {
  return ok(c, msg);
}
```

### 8.4 `src/durable-objects/user-state.ts`
```ts
import type { Bindings } from '../index';

interface TitleMaster {
  name: string;
  max: number;
  regen_minutes_per_point: number;
}

export class UserState implements DurableObject {
  private state: DurableObjectState;
  private env: Bindings;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stamina (
        title_name        TEXT NOT NULL,
        current           INTEGER NOT NULL,
        full_at_ms        INTEGER NOT NULL,
        channel_id        TEXT NOT NULL,
        registered_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (title_name)
      )
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/stamina') {
      const payload = await req.json<{
        sub_name: string;
        options: { name: string; value: any }[];
        channel_id: string;
      }>();
      return this.handleStamina(payload);
    }
    return new Response('not found', { status: 404 });
  }

  private async handleStamina(payload: {
    sub_name: string;
    options: { name: string; value: any }[];
    channel_id: string;
  }): Promise<Response> {
    const opts: Record<string, any> = {};
    for (const o of payload.options) opts[o.name] = o.value;

    switch (payload.sub_name) {
      case 'add':
        return this.add(opts.title as string, opts.current as number, payload.channel_id);
      case 'list':
        return this.list();
      case 'cancel':
        return this.cancel(opts.title as string);
    }
    return new Response('未対応');
  }

  private async add(title: string, current: number, channelId: string): Promise<Response> {
    const t = await this.lookupTitle(title);
    if (!t) return new Response(`未登録のタイトル: ${title} (先に /title add で登録して)`);
    if (current >= t.max) return new Response(`${title} は既に満タン`);

    const remain = t.max - current;
    const fullAtMs = Date.now() + remain * t.regen_minutes_per_point * 60 * 1000;

    this.sql.exec(
      `INSERT OR REPLACE INTO stamina
       (title_name, current, full_at_ms, channel_id, registered_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      title,
      current,
      fullAtMs,
      channelId,
      Date.now(),
    );

    await this.refreshAlarm();
    const at = new Date(fullAtMs).toLocaleString('ja-JP');
    return new Response(`${title}: ${current}/${t.max} 登録、満タン予定 ${at}`);
  }

  private async list(): Promise<Response> {
    const rows = [
      ...this.sql.exec<{
        title_name: string;
        current: number;
        full_at_ms: number;
      }>(`SELECT title_name, current, full_at_ms FROM stamina ORDER BY full_at_ms`),
    ];
    if (!rows.length) return new Response('登録なし');
    const lines = rows.map(
      (r) => `- ${r.title_name}: 現在 ${r.current} -> 満タン ${new Date(r.full_at_ms).toLocaleString('ja-JP')}`,
    );
    return new Response(lines.join('\n'));
  }

  private async cancel(title: string): Promise<Response> {
    this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, title);
    await this.refreshAlarm();
    return new Response(`${title} をキャンセル`);
  }

  async alarm() {
    const now = Date.now();
    const due = [
      ...this.sql.exec<{
        title_name: string;
        channel_id: string;
      }>(`SELECT title_name, channel_id FROM stamina WHERE full_at_ms <= ?`, now),
    ];
    const userId = (this.state.id.name as string) ?? 'anon';

    for (const r of due) {
      await this.postReply(r.channel_id, `<@${userId}> ${r.title_name} のスタミナが満タンになった`);
      this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, r.title_name);
    }

    await this.refreshAlarm();
  }

  private async refreshAlarm() {
    const next = [
      ...this.sql.exec<{ next_at: number | null }>(`SELECT MIN(full_at_ms) AS next_at FROM stamina`),
    ][0];
    if (next?.next_at) {
      await this.state.storage.setAlarm(next.next_at);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  private async lookupTitle(name: string): Promise<TitleMaster | null> {
    const raw = await this.env.TITLES.get(`title:${name}`);
    return raw ? (JSON.parse(raw) as TitleMaster) : null;
  }

  private async postReply(channelId: string, content: string) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: ['users'] },
      }),
    });
  }
}
```

### 8.5 `src/commands.ts` (Slash コマンド定義)
```ts
export const commands = [
  {
    name: 'stamina',
    description: 'スタミナ通知の管理',
    options: [
      {
        name: 'add',
        description: '現在のスタミナを登録',
        type: 1, // SUB_COMMAND
        options: [
          { name: 'title', description: 'タイトル名', type: 3, required: true },
          { name: 'current', description: '現在のスタミナ', type: 4, required: true },
        ],
      },
      {
        name: 'list',
        description: '登録中のスタミナ一覧',
        type: 1,
      },
      {
        name: 'cancel',
        description: '指定タイトルをキャンセル',
        type: 1,
        options: [{ name: 'title', description: 'タイトル名', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'title',
    description: 'タイトルマスタの管理',
    options: [
      {
        name: 'add',
        description: 'タイトルを追加',
        type: 1,
        options: [
          { name: 'name', description: 'タイトル名', type: 3, required: true },
          { name: 'max', description: '最大スタミナ', type: 4, required: true },
          { name: 'regen_minutes', description: '1ポイント回復に必要な分数', type: 4, required: true },
        ],
      },
      { name: 'list', description: 'タイトル一覧', type: 1 },
      {
        name: 'remove',
        description: 'タイトルを削除',
        type: 1,
        options: [{ name: 'name', description: 'タイトル名', type: 3, required: true }],
      },
    ],
  },
];
```

### 8.6 `scripts/register-commands.ts`

`.dev.vars` から Bun ネイティブに読み込む。CI/CD spec §9 の最小 parser を採用、`dotenv` パッケージや `process.env` 経路は使わない (Bun ネイティブ実行に揃え、Worker の `.dev.vars` と二重管理しない)。

```ts
import { commands } from '../src/commands';

const text = await Bun.file('.dev.vars').text();
const env = Object.fromEntries(
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [k, ...v] = line.split('=');
      return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')];
    }),
);

const appId = env.DISCORD_APPLICATION_ID;
const token = env.DISCORD_BOT_TOKEN;
const guildId = env.DISCORD_GUILD_ID; // optional、設定されていれば guild scope へ即反映、未設定なら global コマンド登録

if (!appId || !token) {
  console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required in .dev.vars');
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const resp = await fetch(url, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bot ${token}`,
  },
  body: JSON.stringify(commands),
});

console.log(resp.status, await resp.text());
```

ローカル実行は `bun scripts/register-commands.ts` (または `bun run register-commands`、`package.json` の scripts 経由)。secrets は `.dev.vars` から読む。**GitHub Actions / Workers Builds では実行しない**。

## 9. デプロイ手順骨子

CI/CD spec の Phase 化と整合する。**詳細手順は `docs/superpowers/specs/2026-06-29-github-cicd-design.md` §12 の 24 step に従う**。本書では概要のみ示す。

要点:

- パッケージマネージャは Bun (npm/npx ではない)、`bun install --frozen-lockfile --ignore-scripts` をローカル/CI/Workers Builds で統一
- デプロイは Cloudflare Workers Builds で `main` push 自動 (GitHub Actions では deploy しない)
- secrets:
  - `DISCORD_APPLICATION_ID` / `DISCORD_PUBLIC_KEY` は **`[vars]` に書く** (Secret ではない)
  - `DISCORD_BOT_TOKEN` のみ Runtime Secret (`bunx wrangler secret put DISCORD_BOT_TOKEN`)
- Slash コマンド登録 (`bun run register-commands`) はローカル手動運用、Workers Builds に同居させない (Build 環境内での token 露出回避)
- デプロイは 2 フェーズ:
  - **第 1 段階**: 最小 `src/index.ts` (Ed25519 verify + PING/PONG だけ) を deploy → Discord Endpoint URL 登録 → PING/PONG 動作確認
  - **第 2 段階**: UserState DO + 全 handler を実装、`wrangler.toml` に DO binding と `[[migrations]]` を追加して deploy。これ以降は migration 前への rollback 不可 (CF 公式仕様)
- `BUN_VERSION` と `SKIP_DEPENDENCY_INSTALL=1` だけは Workers Builds の Build Variables に登録、Discord 系 secret は置かない

## 10. 運用上の注意点

### 10.1 Slash コマンドの伝搬遅延
- Global コマンドは最大 1 時間反映遅延
- 開発中は Guild コマンドで PUT する → 即反映
- 本番化したら Global に切替 (`DISCORD_GUILD_ID` を空に)

### 10.2 alarm() の at-least-once
- DO の alarm は失敗時に最大 6 回 (2 秒スタート指数バックオフ) 再試行
- 重複通知を避けるため、alarm 内で DB 状態を必ず読み、未送のものだけ通知する設計
- 通知後即 DELETE することで再試行されても重複しない (DELETE が完了する前に alarm が再実行されたら最大 1 件重複するが、現実的にはほぼ起きない)

### 10.3 Discord REST レートリミット
- 429 受領時は `Retry-After` 秒数だけ待ってリトライ
- 個人 bot で通知頻度が低いので通常は問題なし
- alarm() ハンドラ内で fetch が 429 を返した場合は、行を削除せず例外を throw すれば 6 回まで自動再試行される

### 10.4 KV の eventual consistency
- KV は eventual consistency で書き込みが全 region に伝搬するのに最大 60 秒
- `/title add` 直後の `/stamina add` で見つからない可能性は微小だが存在する
- 個人用なので無視可能、気になるなら DO storage にコピーを置く

### 10.5 .dev.vars / .gitignore
- ローカル secret は **`.dev.vars` のみ** (`.env` 系は使わない、二重管理回避)
- `.gitignore` に `.dev.vars*`, `.env*`, `node_modules/`, `.wrangler/`, `dist/`, `*.tsbuildinfo` を必ず追加
- **`bun.lock` は `.gitignore` に含めない** (=必ず commit)。再現性のため CI/Workers Builds/ローカルで `bun install --frozen-lockfile --ignore-scripts` を使う前提
- 具体的な `.gitignore` 雛形は CI/CD spec §16.4 を参照

### 10.6 secret 値はチャネルに流さない
- **bot token** (`DISCORD_BOT_TOKEN`) は Cloudflare Runtime secret (`bunx wrangler secret put`) または `.dev.vars` (`.gitignore` 対象) のみ。HANDOFF/docs/git commit に literal で書かない (CI/CD spec §9)。検出補助: `scripts/check-pins.sh` の secret-like literal scan が **`HANDOFF.md` 含む tracked file の `DISCORD_BOT_TOKEN=<literal>`** を検出する。ただし scan は `docs/` 配下と `scripts/check-pins.*` を除外するため、**`docs/` 配下への誤コミットは手動レビュー責務**
- **application id** (`DISCORD_APPLICATION_ID`) と **public key** (`DISCORD_PUBLIC_KEY`) は公開値 (Ed25519 公開鍵は Discord Developer Portal にも明示される)、`wrangler.toml [vars]` に literal で commit する。secret 扱いしない (spec §9 / 本書 §7)、secret-like scan の対象外
- Discord チャネル / コミット履歴に **bot token を絶対残さない**

## 11. 料金見積もり (Free プラン前提)

| 項目 | Free 上限 | 試算 |
|---|---|---|
| Daily requests | 100,000/日 | 数十/日 (Slash command + alarm) |
| CPU time/invocation | 10 ms | 全 handler 1ms 以下 |
| DO duration | 13,000 GB-s/日 | alarm 実行時のみ wake、数 GB-s/日 |
| DO storage | 5 GB | 数 KB |
| KV read | 100,000/日 (Free) | 数十/日 |
| KV write | 1,000/日 (Free) | 数件/日 |
| Subrequests | 50/req | Interactions 内で DO 1回 + Discord REST 1回 = 2 |

**完全に Free プラン枠内で運用可能**。実測超過時のみ Paid 移行を検討。

## 12. 参考資料

### Hono
- https://hono.dev/docs/getting-started/cloudflare-workers
- https://hono.dev/docs/concepts/middleware
- https://hono.dev/docs/api/context

### Discord
- https://discord.com/developers/docs/interactions/overview
- https://discord.com/developers/docs/interactions/application-commands
- https://discord.com/developers/docs/tutorials/hosting-on-cloudflare-workers
- https://github.com/discord/discord-interactions-js

### Cloudflare
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/wrangler/configuration/

### 前段の調査経緯 (A 方針を含む比較)
- `D:\projects\cloudflare\docs\discord-bot-hosting.md` (24 ソース・118 claims 検証の元レポート)
