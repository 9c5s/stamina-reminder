import type { Context } from 'hono';
import type { Bindings } from '../index';
import { getTitle, TITLE_LIMITS } from '../lib/titles';
import { ephemeral } from './ephemeral';

interface Interaction {
  data?: {
    options?: { name: string; options?: { name: string; value: string | number }[] }[];
  };
  member?: { user?: { id: string } };
  user?: { id: string };
  channel_id?: string;
  /** Discord の新しいペイロード形式では channel オブジェクトが存在する場合がある */
  channel?: { id: string };
}

export async function handleStamina(
  c: Context<{ Bindings: Bindings }>,
  interaction: Interaction,
): Promise<Response> {
  const sub = interaction.data?.options?.[0];
  if (!sub) return ephemeral(c, 'サブコマンド指定なし');

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  // 旧ペイロードは channel_id (フラット)、新ペイロードは channel.id (ネスト) を使う
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (!userId || !channelId) {
    return ephemeral(c, '不正な interaction: user_id または channel_id 欠落');
  }
  // titleOpt と titleVal は add/cancel の両ブロックで共用するため先頭で 1 回だけ抽出する
  const titleOpt = (sub.options ?? []).find((o) => o.name === 'title');
  const titleVal = String(titleOpt?.value ?? '').trim();

  // /stamina add と /stamina cancel は title を KV キーに使うため、送信前にバイト長を検証する
  if (sub.name === 'add' || sub.name === 'cancel') {
    // add は空白のみのタイトルを /title add と対称なエラーで弾く
    if (sub.name === 'add' && !titleVal) {
      return ephemeral(c, 'タイトル名は必須です');
    }
    const titleBytes = new TextEncoder().encode(titleVal).length;
    if (titleBytes > TITLE_LIMITS.NAME_MAX_BYTES) {
      return ephemeral(
        c,
        `タイトル名が長すぎます (UTF-8 で ${TITLE_LIMITS.NAME_MAX_BYTES} バイト以内)`,
      );
    }
  }

  // /stamina add はタイトルマスターを handler 層で解決し DO の外部 await を排除して race を防止する
  let titleMaster: { max: number; regen_minutes_per_point: number } | undefined;
  // ハンドラ層で採取した登録時刻を DO に渡し、古いリクエストを UPSERT の WHERE 節で弾く
  let registeredAtMs: number | undefined;
  // ハンドラ層で採取したキャンセル時刻を DO に渡し、tombstone と DELETE の時刻基準を add と対称にする
  let cancelAtMs: number | undefined;
  if (sub.name === 'add') {
    // titleOpt と titleVal は上で既に抽出済み
    registeredAtMs = Date.now();
    const t = await getTitle(c.env.TITLES, titleVal);
    if (!t) {
      return ephemeral(c, `未登録のタイトル: ${titleVal} (先に /title add で登録して)`);
    }
    titleMaster = { max: t.max, regen_minutes_per_point: t.regen_minutes_per_point };
  }
  if (sub.name === 'cancel') {
    // interaction 到着時刻を DO に渡し、add と同一の基準でキャンセルの前後関係を判定できるようにする
    cancelAtMs = Date.now();
  }

  const stub = c.env.USER_STATE.get(c.env.USER_STATE.idFromName(userId));

  const resp = await stub.fetch(
    new Request('https://do/stamina', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sub_name: sub.name,
        options: sub.options ?? [],
        channel_id: channelId,
        ...(titleMaster ? { title_master: titleMaster } : {}),
        ...(registeredAtMs !== undefined ? { registered_at_ms: registeredAtMs } : {}),
        ...(cancelAtMs !== undefined ? { cancel_at_ms: cancelAtMs } : {}),
      }),
    }),
  );

  if (!resp.ok) {
    console.error('DO returned non-2xx:', resp.status);
    return ephemeral(c, '処理中にエラーが発生しました');
  }
  const body = await resp.text();
  return ephemeral(c, body);
}
