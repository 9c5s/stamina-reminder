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
}

export async function handleStamina(
  c: Context<{ Bindings: Bindings }>,
  interaction: Interaction,
): Promise<Response> {
  const sub = interaction.data?.options?.[0];
  if (!sub) return ephemeral(c, 'サブコマンド指定なし');

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const channelId = interaction.channel_id;
  if (!userId || !channelId) {
    return ephemeral(c, '不正な interaction: user_id または channel_id 欠落');
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
