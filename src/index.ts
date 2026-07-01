import { InteractionResponseType, verifyKey } from 'discord-interactions';
import { Hono } from 'hono';
import { handleStamina } from './handlers/stamina';
import { handleTitle } from './handlers/title';
import { dispatchInteraction, type Interaction } from './interactions';

export { UserState } from './durable-objects/user-state';

export type Bindings = {
  USER_STATE: DurableObjectNamespace;
  TITLES: KVNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.post('/interactions', async (c) => {
  const sig = c.req.header('x-signature-ed25519') ?? '';
  const ts = c.req.header('x-signature-timestamp') ?? '';
  const body = await c.req.text();

  const valid = await verifyKey(body, sig, ts, c.env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return c.text('invalid signature', 401);
  }

  const interaction = JSON.parse(body) as Interaction;
  const result = dispatchInteraction(interaction);

  if (result.kind === 'pong') {
    return c.json({ type: 1 });
  }
  if (result.kind === 'route') {
    if (result.name === 'stamina') return handleStamina(c, interaction);
    if (result.name === 'title') return handleTitle(c, interaction);
  }
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未対応のコマンド', flags: 64 },
  });
});

app.get('/healthz', (c) => c.text('ok'));

export default app;
