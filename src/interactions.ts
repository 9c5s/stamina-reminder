export type Interaction = {
  type: number;
  data?: { name?: string; [key: string]: any };
};

export type DispatchResult =
  | { kind: 'pong' }
  | { kind: 'route'; name: 'stamina' | 'title' }
  | { kind: 'unknown' };

export function dispatchInteraction(interaction: Interaction): DispatchResult {
  if (interaction.type === 1) {
    return { kind: 'pong' };
  }
  if (interaction.type === 2) {
    const name = interaction.data?.name;
    if (name === 'stamina' || name === 'title') {
      return { kind: 'route', name };
    }
  }
  return { kind: 'unknown' };
}
