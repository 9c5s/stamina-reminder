import { verifyKey } from 'discord-interactions';
import { Hono } from 'hono';
import { dispatchInteraction, type Interaction } from './interactions';

export type Bindings = {
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
  const response = dispatchInteraction(interaction);
  return c.json(response);
});

app.get('/healthz', (c) => c.text('ok'));

export default app;
