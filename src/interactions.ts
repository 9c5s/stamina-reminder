import { InteractionType } from 'discord-interactions';

export type Interaction = {
  type: number;
  data?: {
    name?: string;
    options?: { name: string; options?: { name: string; value: string | number }[] }[];
  };
  member?: { user?: { id: string } };
  user?: { id: string };
  channel_id?: string;
  /** Discord の新しいペイロード形式では channel オブジェクトが存在する場合がある */
  channel?: { id: string };
};

export type DispatchResult =
  | { kind: 'pong' }
  | { kind: 'route'; name: 'stamina' | 'title' }
  | { kind: 'unknown' };

export function dispatchInteraction(interaction: Interaction): DispatchResult {
  if (interaction.type === InteractionType.PING) {
    return { kind: 'pong' };
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const name = interaction.data?.name;
    if (name === 'stamina' || name === 'title') {
      return { kind: 'route', name };
    }
  }
  return { kind: 'unknown' };
}
