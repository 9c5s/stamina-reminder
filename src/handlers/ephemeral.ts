import { InteractionResponseType } from 'discord-interactions';
import type { Context } from 'hono';

/** Discord の ephemeral (本人のみ表示) 応答を返す共通ヘルパ */
export function ephemeral(c: Context, msg: string): Response {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}
