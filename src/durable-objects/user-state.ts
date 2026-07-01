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
    // cancel 後に古い add が到着してもゾンビ復活しないよう tombstone を照合する
    const cancelledAt = await this.ctx.storage.get<number>(`cancel:${title}`);
    if (typeof cancelledAt === 'number' && cancelledAt >= registeredAtMs) {
      return new Response(`${title} はキャンセル済みのため無視しました`);
    }

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
      // 既に満タンの場合、自分の registered_at_ms 以下の行のみ削除してアラームを更新する
      // registered_at_ms > registeredAtMs の行 (より新しい登録) は保護する
      this.sql.exec(
        `DELETE FROM stamina WHERE title_name = ? AND registered_at_ms <= ?`,
        title,
        registeredAtMs,
      );
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
    return new Response(
      `${title}: ${current}/${t.max} 登録、満タン予定 ${this.formatJst(fullAtMs)}`,
    );
  }

  private async list(): Promise<Response> {
    const rows = [
      ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'current' | 'full_at_ms'>>(
        `SELECT title_name, current, full_at_ms FROM stamina ORDER BY full_at_ms`,
      ),
    ];
    if (!rows.length) return new Response('登録なし');
    const lines = rows.map(
      (r) => `- ${r.title_name}: 現在 ${r.current} -> 満タン ${this.formatJst(r.full_at_ms)}`,
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
    // tombstone を保持し、キャンセル後に古い add が到着しても再挿入されないようにする
    await this.ctx.storage.put(`cancel:${title}`, Date.now());
    // retry が予約されていてもキャンセルされたので不要になるため削除する
    await this.ctx.storage.delete(`retry:${title}`);
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
      // retry_until_ms が now より未来なら、まだリトライ待ちのためこの回は skip する
      const retryUntilMs = await this.ctx.storage.get<number>(`retry:${r.title_name}`);
      if (typeof retryUntilMs === 'number' && retryUntilMs > now) {
        continue;
      }

      let resp: Response;
      try {
        resp = await postChannelMessage({
          botToken: this.env.DISCORD_BOT_TOKEN,
          channelId: r.channel_id,
          content: `<@${userId}> ${r.title_name} のスタミナが満タンになった`,
          mentionUserId: userId,
        });
      } catch (err) {
        // ネットワークエラー (AbortSignal.timeout 等): 60 秒後にリトライする
        console.log(`network error for ${r.title_name}: ${err}, rescheduling in 60s`);
        await this.ctx.storage.put(`retry:${r.title_name}`, Date.now() + 60_000);
        continue;
      }

      if (resp.ok) {
        // 通知成功 (2xx): 行を削除し retry エントリも削除する
        // full_at_ms も WHERE に含め、通知中に再登録された新しい行を誤って削除しない
        this.sql.exec(
          `DELETE FROM stamina WHERE title_name = ? AND full_at_ms = ?`,
          r.title_name,
          r.full_at_ms,
        );
        await this.ctx.storage.delete(`retry:${r.title_name}`);
        continue;
      }

      if (resp.status === 429) {
        // Discord の Retry-After (秒) を尊重してリトライ期限を保存し、レート制限を消費しない
        const retryAfterRaw = resp.headers.get('Retry-After');
        const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
        const retryMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.ceil(retryAfterSec * 1000)
            : 5000;
        console.log(
          `rate limited for ${r.title_name}, retry-after=${retryAfterRaw}s, rescheduling in ${retryMs}ms`,
        );
        await this.ctx.storage.put(`retry:${r.title_name}`, Date.now() + retryMs);
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        // 回復可能な認証/権限エラー: トークンローテーション中やボット権限設定中は 60 秒後にリトライする
        console.log(
          `auth/permission error for ${r.title_name} (status=${resp.status}), rescheduling in 60s`,
        );
        await this.ctx.storage.put(`retry:${r.title_name}`, Date.now() + 60_000);
        continue;
      }

      if (resp.status >= 400 && resp.status < 500) {
        // 真に永続的なクライアントエラー (400/404 等): チャンネル削除や不正ペイロードのため行を削除して続行する
        // full_at_ms も WHERE に含め、通知中に再登録された新しい行を誤って削除しない
        console.error(`permanent failure for ${r.title_name} (status=${resp.status}), deleting`);
        this.sql.exec(
          `DELETE FROM stamina WHERE title_name = ? AND full_at_ms = ?`,
          r.title_name,
          r.full_at_ms,
        );
        continue;
      }

      // 5xx / その他: CF の 6 回 retry cap でリマインダーが止まるのを防ぐため 60 秒後にリトライする
      console.log(
        `transient failure for ${r.title_name} (status=${resp.status}), rescheduling in 60s`,
      );
      await this.ctx.storage.put(`retry:${r.title_name}`, Date.now() + 60_000);
    }

    await this.refreshAlarm();
  }

  /** ミリ秒タイムスタンプを JST の日時文字列に変換する */
  private formatJst(ms: number): string {
    return new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  }

  /**
   * 次のアラーム時刻を再計算してセットする。
   * stamina テーブルの MIN(full_at_ms) と、storage に保存された retry:* エントリの最小値を比較し、
   * 両者の小さい方をセットする。どちらも存在しない場合はアラームを削除する。
   */
  private async refreshAlarm(): Promise<void> {
    const rows = [
      ...this.sql.exec<{ next_at: number | null }>(
        `SELECT MIN(full_at_ms) AS next_at FROM stamina`,
      ),
    ];
    const nextPending = rows[0]?.next_at ?? null;
    const now = Date.now();
    const retryEntries = await this.ctx.storage.list<number>({ prefix: 'retry:' });
    let minRetry: number | null = null;
    for (const ts of retryEntries.values()) {
      if (ts > now && (minRetry === null || ts < minRetry)) minRetry = ts;
    }
    const candidates: number[] = [];
    if (nextPending !== null) candidates.push(nextPending);
    if (minRetry !== null) candidates.push(minRetry);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...candidates));
    }
  }
}
