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
  /** cancel サブコマンド用: ハンドラ層で採取したキャンセル時刻 (tombstone と DELETE の時刻基準) */
  cancel_at_ms?: number;
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
        // handler 層で採取した時刻を優先し、欠落時は現在時刻でフォールバックする
        return this.cancel(title, payload.cancel_at_ms ?? Date.now());
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
    // nowMs に registered_at_ms を使い、interaction 到着時刻を満タン計算の起点にする
    // DO 処理遅延分がずれを生じさせないよう、handler 採取時刻を一貫して使う
    const fullAtMs = calculateFullAtMs({
      current,
      max: t.max,
      regenSecondsPerPoint: t.regen_seconds_per_point,
      nowMs: registeredAtMs,
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

  private async cancel(title: string, cancelAtMs: number): Promise<Response> {
    // cancelAtMs より前に登録された行のみ削除し、後着の add (registered_at_ms > cancelAtMs) を保護する
    this.sql.exec(
      `DELETE FROM stamina WHERE title_name = ? AND registered_at_ms <= ?`,
      title,
      cancelAtMs,
    );
    // tombstone には handler 採取の cancelAtMs を使い、add との前後関係を interaction 到着順で決定する
    await this.ctx.storage.put(`cancel:${title}`, cancelAtMs);
    // retry が予約されていてもキャンセルされたので不要になるため削除する
    await this.ctx.storage.delete(`retry:${title}`);
    await this.refreshAlarm();
    return new Response(`${title} をキャンセル`);
  }

  override async alarm(): Promise<void> {
    // retry:* エントリを事前に全件読み込み、期限が未来のものを除外リストに入れる
    // これにより各イテレーションで storage を都度読まずに済み、期限未来の行を SELECT から除外できる
    const retryEntries = await this.ctx.storage.list<number>({ prefix: 'retry:' });
    const now = Date.now();
    const excludedTitles: string[] = [];
    for (const [key, ts] of retryEntries) {
      if (ts > now) excludedTitles.push(key.slice('retry:'.length));
    }

    const userId = this.ctx.id.name ?? 'anon';

    while (true) {
      const nowInner = Date.now();
      // 各イテレーションで最古の due 行を 1 件だけ再 SELECT し、cancel や re-add の interleave を反映する
      let due: Pick<StaminaRow, 'title_name' | 'channel_id' | 'full_at_ms'> | undefined;
      if (excludedTitles.length === 0) {
        const rows = [
          ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'channel_id' | 'full_at_ms'>>(
            `SELECT title_name, channel_id, full_at_ms FROM stamina
             WHERE full_at_ms <= ?
             ORDER BY full_at_ms
             LIMIT 1`,
            nowInner,
          ),
        ];
        due = rows[0];
      } else {
        // retry 待ち中のタイトルを NOT IN で除外して最古の due を取得する
        // SQLite の bind limit は 999 だが単一ユーザ用途では超過しない
        const placeholders = excludedTitles.map(() => '?').join(',');
        const rows = [
          ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'channel_id' | 'full_at_ms'>>(
            `SELECT title_name, channel_id, full_at_ms FROM stamina
             WHERE full_at_ms <= ? AND title_name NOT IN (${placeholders})
             ORDER BY full_at_ms
             LIMIT 1`,
            nowInner,
            ...excludedTitles,
          ),
        ];
        due = rows[0];
      }
      if (!due) break;

      const r = due;

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
        excludedTitles.push(r.title_name);
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
        excludedTitles.push(r.title_name);
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        // 回復可能な認証/権限エラー: トークンローテーション中やボット権限設定中は 60 秒後にリトライする
        console.log(
          `auth/permission error for ${r.title_name} (status=${resp.status}), rescheduling in 60s`,
        );
        await this.ctx.storage.put(`retry:${r.title_name}`, Date.now() + 60_000);
        excludedTitles.push(r.title_name);
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
      excludedTitles.push(r.title_name);
    }

    await this.refreshAlarm();
  }

  /** ミリ秒タイムスタンプを JST の日時文字列に変換する */
  private formatJst(ms: number): string {
    return new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  }

  /**
   * 次のアラーム時刻を再計算してセットする。
   * retry-deferred な title (retry:* エントリが未来のもの) を stamina クエリから除外し、
   * 過去の full_at_ms が候補に混入して即時発火ループが起きるのを防ぐ。
   * retry deadline 自体は別 candidate として保持し、期限通りに再通知する。
   * どちらの candidate も存在しない場合はアラームを削除する。
   */
  private async refreshAlarm(): Promise<void> {
    const now = Date.now();
    const retryEntries = await this.ctx.storage.list<number>({ prefix: 'retry:' });
    const deferredTitles: string[] = [];
    let minRetry: number | null = null;
    for (const [key, ts] of retryEntries) {
      if (ts > now) {
        deferredTitles.push(key.slice('retry:'.length));
        if (minRetry === null || ts < minRetry) minRetry = ts;
      }
    }
    let nextPending: number | null = null;
    if (deferredTitles.length === 0) {
      const rows = [
        ...this.sql.exec<{ next_at: number | null }>(
          `SELECT MIN(full_at_ms) AS next_at FROM stamina`,
        ),
      ];
      nextPending = rows[0]?.next_at ?? null;
    } else {
      // SQLite の bind limit は 999 だが単一ユーザ用途では超過しない
      const placeholders = deferredTitles.map(() => '?').join(',');
      const rows = [
        ...this.sql.exec<{ next_at: number | null }>(
          `SELECT MIN(full_at_ms) AS next_at FROM stamina WHERE title_name NOT IN (${placeholders})`,
          ...deferredTitles,
        ),
      ];
      nextPending = rows[0]?.next_at ?? null;
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
