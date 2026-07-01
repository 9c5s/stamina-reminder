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
      case 'add': {
        const title = String(opts.title ?? '').trim();
        if (!title) return new Response('タイトル名は必須です');
        const current = Number(opts.current);
        if (!Number.isFinite(current) || current < 0) {
          return new Response('現在のスタミナは0以上の数値を指定してください');
        }
        return this.add(title, current, payload.channel_id);
      }
      case 'list':
        return this.list();
      case 'cancel': {
        const title = String(opts.title ?? '').trim();
        if (!title) return new Response('タイトル名は必須です');
        return this.cancel(title);
      }
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
      // 既に満タンの場合、古いアラーム行が残っていれば削除してアラームを更新する
      this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, title);
      await this.refreshAlarm();
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
      ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'channel_id' | 'full_at_ms'>>(
        `SELECT title_name, channel_id, full_at_ms FROM stamina WHERE full_at_ms <= ?`,
        now,
      ),
    ];
    const userId = this.ctx.id.name ?? 'anon';

    for (const r of due) {
      let resp: Response;
      try {
        resp = await postChannelMessage({
          botToken: this.env.DISCORD_BOT_TOKEN,
          channelId: r.channel_id,
          content: `<@${userId}> ${r.title_name} のスタミナが満タンになった`,
          mentionUserId: userId,
        });
      } catch (err) {
        // ネットワークエラー (AbortSignal.timeout 等) が発生した場合は自前で再スケジュールして復帰する
        console.log(`network error for ${r.title_name}: ${err}, rescheduling in 60s`);
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
      if (!resp.ok) {
        if (resp.status === 429) {
          // Discord の Retry-After (秒) を尊重してアラームを再スケジュールし、リトライを無駄に消費しない
          // 行は削除しないため次回アラーム起動時に再処理される
          const retryAfterRaw = resp.headers.get('Retry-After');
          const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
          const retryMs =
            Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.ceil(retryAfterSec * 1000)
              : 5000;
          console.log(
            `rate limited for ${r.title_name}, retry-after=${retryAfterRaw}s, rescheduling in ${retryMs}ms`,
          );
          await this.ctx.storage.setAlarm(Date.now() + retryMs);
          return;
        }
        if (resp.status >= 500) {
          // 5xx は自前で再スケジュールし、CF の 6 回 retry cap でリマインダーが止まるのを防ぐ
          const fallbackMs = 60_000;
          console.log(
            `transient failure for ${r.title_name} (status=${resp.status}), rescheduling in ${fallbackMs}ms`,
          );
          await this.ctx.storage.setAlarm(Date.now() + fallbackMs);
          return;
        }
        // 永続エラー (4xx / 429 以外): 再試行しても成功しないため行を削除して続行
        // full_at_ms も WHERE に含め、通知中に再登録された新しい行を誤って削除しない
        console.error(`permanent error for ${r.title_name}: status=${resp.status}, deleting row`);
        this.sql.exec(
          `DELETE FROM stamina WHERE title_name = ? AND full_at_ms = ?`,
          r.title_name,
          r.full_at_ms,
        );
        continue;
      }
      // 通知成功 (2xx) を確認した後に行削除 -> at-least-once でも重複通知は 1 件まで
      // full_at_ms も WHERE に含め、通知中に再登録された新しい行を誤って削除しない
      this.sql.exec(
        `DELETE FROM stamina WHERE title_name = ? AND full_at_ms = ?`,
        r.title_name,
        r.full_at_ms,
      );
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
