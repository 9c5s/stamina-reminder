import { describe, expect, it } from 'vitest';
import { buildRegisterCommandsUrl, buildRegisterRequest } from './register-commands';

describe('buildRegisterCommandsUrl', () => {
  it('builds global commands URL when guildId is undefined', () => {
    const url = buildRegisterCommandsUrl({ appId: '12345' });
    expect(url).toBe('https://discord.com/api/v10/applications/12345/commands');
  });

  it('builds guild commands URL when guildId is provided', () => {
    const url = buildRegisterCommandsUrl({
      appId: '12345',
      guildId: '67890',
    });
    expect(url).toBe('https://discord.com/api/v10/applications/12345/guilds/67890/commands');
  });

  it('treats empty string guildId as global', () => {
    const url = buildRegisterCommandsUrl({ appId: '12345', guildId: '' });
    expect(url).toBe('https://discord.com/api/v10/applications/12345/commands');
  });
});

describe('buildRegisterRequest', () => {
  const fakeCommands = [{ name: 'stamina', description: 'test' }];

  it('returns global URL and command body when no guildId / no clearGuild', () => {
    const req = buildRegisterRequest({
      appId: '12345',
      commands: fakeCommands,
    });
    expect(req.url).toBe('https://discord.com/api/v10/applications/12345/commands');
    expect(req.body).toBe(JSON.stringify(fakeCommands));
  });

  it('returns guild URL and command body when guildId set', () => {
    const req = buildRegisterRequest({
      appId: '12345',
      guildId: '67890',
      commands: fakeCommands,
    });
    expect(req.url).toBe('https://discord.com/api/v10/applications/12345/guilds/67890/commands');
    expect(req.body).toBe(JSON.stringify(fakeCommands));
  });

  it('returns guild URL and empty array body when clearGuild + guildId set', () => {
    const req = buildRegisterRequest({
      appId: '12345',
      guildId: '67890',
      clearGuild: true,
      commands: fakeCommands,
    });
    expect(req.url).toBe('https://discord.com/api/v10/applications/12345/guilds/67890/commands');
    expect(req.body).toBe('[]');
  });

  it('throws when clearGuild is true but guildId is missing', () => {
    expect(() =>
      buildRegisterRequest({
        appId: '12345',
        clearGuild: true,
        commands: fakeCommands,
      }),
    ).toThrow(/guildId/);
  });

  it('throws when clearGuild is true but guildId is empty string', () => {
    expect(() =>
      buildRegisterRequest({
        appId: '12345',
        guildId: '',
        clearGuild: true,
        commands: fakeCommands,
      }),
    ).toThrow(/guildId/);
  });
});
