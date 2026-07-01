import { InteractionResponseType } from 'discord-interactions';
import type { Context } from 'hono';
import type { Bindings } from '../index';

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
  // /stamina add と /stamina cancel は title を KV キーに使うため、送信前にバイト長を検証する
  if (sub.name === 'add' || sub.name === 'cancel') {
    const titleOpt = (sub.options ?? []).find((o) => o.name === 'title');
    if (titleOpt) {
      const titleVal = String(titleOpt.value ?? '').trim();
      const titleBytes = new TextEncoder().encode(titleVal).length;
      if (titleBytes > 490) {
        return ephemeral(c, 'タイトル名が長すぎます (UTF-8 で 490 バイト以内)');
      }
    }
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
      }),
    }),
  );

  const body = await resp.text();
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: body, flags: 64 },
  });
}

function ephemeral(c: Context, msg: string) {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}
