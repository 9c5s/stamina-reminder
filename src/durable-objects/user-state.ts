import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from '../index';
import { postChannelMessage } from '../lib/discord-rest';
import { optionsToRecord } from '../lib/options';
import { calculateFullAtMs } from '../lib/stamina-calc';
import { getTitle } from '../lib/titles';

interface StaminaRow {
  title_name: string;
  current: number;
  full_at_ms: number;
  channel_id: string;
  registered_at_ms: number;
}

interface DispatchPayload {
  sub_name: 'add' | 'list' | 'cancel';
  options: { name: string; value: string | number }[];
  channel_id: string;
}

export class UserState extends DurableObject<Bindings> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/stamina' && req.method === 'POST') {
      const payload = (await req.json()) as DispatchPayload;
      return this.handleStamina(payload);
    }
    return new Response('not found', { status: 404 });
  }

  private async handleStamina(payload: DispatchPayload): Promise<Response> {
    const opts = optionsToRecord(payload.options);
    switch (payload.sub_name) {
      case 'add':
        return this.add(String(opts.title), Number(opts.current), payload.channel_id);
      case 'list':
        return this.list();
      case 'cancel':
        return this.cancel(String(opts.title));
    }
    return new Response('未対応のサブコマンド');
  }

  private async add(title: string, current: number, channelId: string): Promise<Response> {
    const t = await getTitle(this.env.TITLES, title);
    if (!t) {
      return new Response(`未登録のタイトル: ${title} (先に /title add で登録して)`);
    }
    const nowMs = Date.now();
    const fullAtMs = calculateFullAtMs({
      current,
      max: t.max,
      regenSecondsPerPoint: t.regen_seconds_per_point,
      nowMs,
    });
    if (fullAtMs === null) {
      return new Response(`${title} は既に満タン`);
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO stamina
       (title_name, current, full_at_ms, channel_id, registered_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      title,
      current,
      fullAtMs,
      channelId,
      nowMs,
    );

    await this.refreshAlarm();
    const at = new Date(fullAtMs).toLocaleString('ja-JP');
    return new Response(`${title}: ${current}/${t.max} 登録、満タン予定 ${at}`);
  }

  private async list(): Promise<Response> {
    const rows = [
      ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'current' | 'full_at_ms'>>(
        `SELECT title_name, current, full_at_ms FROM stamina ORDER BY full_at_ms`,
      ),
    ];
    if (!rows.length) return new Response('登録なし');
    const lines = rows.map(
      (r) =>
        `- ${r.title_name}: 現在 ${r.current} -> 満タン ${new Date(r.full_at_ms).toLocaleString('ja-JP')}`,
    );
    return new Response(lines.join('\n'));
  }

  private async cancel(title: string): Promise<Response> {
    this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, title);
    await this.refreshAlarm();
    return new Response(`${title} をキャンセル`);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = [
      ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'channel_id'>>(
        `SELECT title_name, channel_id FROM stamina WHERE full_at_ms <= ?`,
        now,
      ),
    ];
    const userId = (this.ctx.id.name as string | undefined) ?? 'anon';

    for (const r of due) {
      const resp = await postChannelMessage({
        botToken: this.env.DISCORD_BOT_TOKEN,
        channelId: r.channel_id,
        content: `<@${userId}> ${r.title_name} のスタミナが満タンになった`,
      });
      if (!resp.ok) {
        // 2xx 以外は行を削除せず例外 throw -> DO 再試行 (最大 6 回、2 秒スタート指数バックオフ)
        // 通知失敗時にリマインダが消えるのを防ぐ (token 不正 / 5xx / 429 すべて該当)
        if (resp.status === 429) {
          const retryAfter = resp.headers.get('Retry-After') ?? 'unknown';
          console.log(`rate limited for ${r.title_name}, retry-after=${retryAfter}`);
        }
        throw new Error(`postChannelMessage failed for ${r.title_name}: status=${resp.status}`);
      }
      // 通知成功 (2xx) を確認した後に行削除 -> at-least-once でも重複通知は 1 件まで
      this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, r.title_name);
    }

    await this.refreshAlarm();
  }

  private async refreshAlarm(): Promise<void> {
    const rows = [
      ...this.sql.exec<{ next_at: number | null }>(
        `SELECT MIN(full_at_ms) AS next_at FROM stamina`,
      ),
    ];
    const nextAt = rows[0]?.next_at;
    if (nextAt) {
      await this.ctx.storage.setAlarm(nextAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
