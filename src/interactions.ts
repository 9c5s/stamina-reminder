type Interaction = {
  type: number;
  data?: { name?: string };
};

type InteractionResponse = { type: 1 } | { type: 4; data: { content: string; flags: number } };

export function dispatchInteraction(interaction: Interaction): InteractionResponse {
  if (interaction.type === 1) {
    return { type: 1 };
  }
  return {
    type: 4,
    data: { content: '未対応のコマンド', flags: 64 },
  };
}
