import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
} from 'discord-interactions';

type Interaction = {
  type: number;
  data?: { name?: string };
};

type InteractionResponse =
  | { type: InteractionResponseType.PONG }
  | {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE;
      data: { content: string; flags: number };
    };

export function dispatchInteraction(interaction: Interaction): InteractionResponse {
  if (interaction.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未対応のコマンド', flags: InteractionResponseFlags.EPHEMERAL },
  };
}
