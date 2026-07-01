import { commands } from '../src/commands';
import { parseDevVars } from '../src/lib/dev-vars';

export function buildRegisterCommandsUrl(args: { appId: string; guildId?: string }): string {
  if (args.guildId && args.guildId.length > 0) {
    return `https://discord.com/api/v10/applications/${args.appId}/guilds/${args.guildId}/commands`;
  }
  return `https://discord.com/api/v10/applications/${args.appId}/commands`;
}

export interface RegisterRequest {
  url: string;
  body: string;
}

export function buildRegisterRequest(args: {
  appId: string;
  guildId?: string;
  clearGuild?: boolean;
  commands: unknown[];
}): RegisterRequest {
  if (args.clearGuild) {
    if (!args.guildId || args.guildId.length === 0) {
      throw new Error('--clear-guild requires guildId');
    }
    return {
      url: buildRegisterCommandsUrl({ appId: args.appId, guildId: args.guildId }),
      body: '[]',
    };
  }
  return {
    url: buildRegisterCommandsUrl({ appId: args.appId, guildId: args.guildId }),
    body: JSON.stringify(args.commands),
  };
}

async function main() {
  const text = await Bun.file('.dev.vars').text();
  const env = parseDevVars(text);

  const appId = env.DISCORD_APPLICATION_ID;
  const token = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const clearGuild = process.argv.includes('--clear-guild');

  if (!appId || !token) {
    console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required in .dev.vars');
    process.exit(1);
  }

  let req: RegisterRequest;
  try {
    req = buildRegisterRequest({ appId, guildId, clearGuild, commands });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const resp = await fetch(req.url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
    body: req.body,
  });

  console.log(resp.status, await resp.text());
}

if (import.meta.main) {
  await main();
}
