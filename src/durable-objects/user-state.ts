import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from '../index';
import { postChannelMessage } from '../lib/discord-rest';
import { optionsToRecord } from '../lib/options';
import { calculateFullAtMs } from '../lib/stamina-calc';

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
  /** add サブコマンド用: handler 層で解決済みのタイトルマスター */
  title_master?: { max: number; regen_seconds_per_point: number };
  /** add サブコマンド用: ハンドラ層で採取した登録時刻 (競合判定に使用、add 時必須) */
  registered_at_ms?: number;
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
        // title_master は handler 層で KV から解決済みのため DO 内で外部 await 不要
        if (!payload.title_master) return new Response('title_master が未指定です');
        if (payload.registered_at_ms === undefined)
          return new Response('registered_at_ms が未指定です');
        return this.add(
          title,
          current,
          payload.channel_id,
          payload.title_master,
          payload.registered_at_ms,
        );
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

  private async add(
    title: string,
    current: number,
    channelId: string,
    titleMaster: { max: number; regen_seconds_per_point: number },
    registeredAtMs: number,
  ): Promise<Response> {
    // titleMaster は handler 層で解決済みのため DO 内に外部 await が存在せず、並行 add による競合を防止できる
    const t = titleMaster;
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

    // UPSERT: 既存行の registered_at_ms より新しいリクエストのみ上書きし、古い後着リクエストを排除する
    this.sql.exec(
      `INSERT INTO stamina (title_name, current, full_at_ms, channel_id, registered_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(title_name) DO UPDATE SET
         current = excluded.current,
         full_at_ms = excluded.full_at_ms,
         channel_id = excluded.channel_id,
         registered_at_ms = excluded.registered_at_ms
       WHERE excluded.registered_at_ms > stamina.registered_at_ms`,
      title,
      current,
      fullAtMs,
      channelId,
      registeredAtMs,
    );

    // 書き込みが成功したか確認する (古いリクエストは UPSERT の WHERE 節で弾かれ行は更新されない)
    const written = [
      ...this.sql.exec<{ registered_at_ms: number }>(
        `SELECT registered_at_ms FROM stamina WHERE title_name = ?`,
        title,
      ),
    ];
    if (written[0]?.registered_at_ms !== registeredAtMs) {
      return new Response('より新しい登録が既にあるため無視しました');
    }

    await this.refreshAlarm();
    const at = new Date(fullAtMs).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
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
        `- ${r.title_name}: 現在 ${r.current} -> 満タン ${new Date(r.full_at_ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    );
    // Discord のメッセージ上限 2000 字に対し 1900 字でキャップし、省略件数を末尾に付加する
    const LIMIT = 1900;
    const SUFFIX_RESERVE = 30;
    let content = '';
    let shown = 0;
    for (const line of lines) {
      const nextLen = content.length + (content ? 1 : 0) + line.length;
      if (nextLen > LIMIT - SUFFIX_RESERVE && shown < lines.length) break;
      content = content ? `${content}\n${line}` : line;
      shown++;
    }
    if (shown < lines.length) {
      content += `\n(他 ${lines.length - shown} 件は省略)`;
    }
    return new Response(content);
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
        await this.scheduleRetry(60_000, r.title_name);
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
          await this.scheduleRetry(retryMs, r.title_name);
          return;
        }
        // 回復可能な認証/権限エラー: トークンローテーション中やボット権限設定中は行を保持して再スケジュールする
        if (resp.status === 401 || resp.status === 403) {
          const fallbackMs = 60_000;
          console.log(
            `auth/permission error for ${r.title_name} (status=${resp.status}), rescheduling in ${fallbackMs}ms`,
          );
          await this.scheduleRetry(fallbackMs, r.title_name);
          return;
        }
        // 真に永続的なクライアントエラー (400/404 等): チャンネル削除や不正ペイロードのため行を削除して続行
        // full_at_ms も WHERE に含め、通知中に再登録された新しい行を誤って削除しない
        if (resp.status >= 400 && resp.status < 500) {
          console.error(`permanent failure for ${r.title_name} (status=${resp.status}), deleting`);
          this.sql.exec(
            `DELETE FROM stamina WHERE title_name = ? AND full_at_ms = ?`,
            r.title_name,
            r.full_at_ms,
          );
          continue;
        }
        // 5xx は自前で再スケジュールし、CF の 6 回 retry cap でリマインダーが止まるのを防ぐ
        {
          const fallbackMs = 60_000;
          console.log(
            `transient failure for ${r.title_name} (status=${resp.status}), rescheduling in ${fallbackMs}ms`,
          );
          await this.scheduleRetry(fallbackMs, r.title_name);
          return;
        }
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

  /**
   * リトライ用アラームをスケジュールする。
   * DO の alarm スロットは 1 つのみのため、既存の pending 行の最小 full_at_ms と比較し、
   * 早い方をセットすることで無関係なリマインダーの遅延を防ぐ。
   * excludeTitle を指定すると、その行を MIN 集計から除外する。
   * 失敗した due 行自体は過去時刻のため、除外しないと Math.min が即時再発火を選んでしまう。
   */
  private async scheduleRetry(retryMs: number, excludeTitle?: string): Promise<void> {
    const retryAt = Date.now() + retryMs;
    const rows = excludeTitle
      ? [
          ...this.sql.exec<{ next_at: number | null }>(
            `SELECT MIN(full_at_ms) AS next_at FROM stamina WHERE title_name != ?`,
            excludeTitle,
          ),
        ]
      : [
          ...this.sql.exec<{ next_at: number | null }>(
            `SELECT MIN(full_at_ms) AS next_at FROM stamina`,
          ),
        ];
    const nextPending = rows[0]?.next_at ?? null;
    const target = nextPending !== null ? Math.min(retryAt, nextPending) : retryAt;
    await this.ctx.storage.setAlarm(target);
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
