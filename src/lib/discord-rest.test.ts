import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyDeleteResponse, deleteChannelMessage } from './discord-rest';

describe('deleteChannelMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('DELETE リクエストを正しい URL と認証ヘッダで送信する', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });

    const resp = await deleteChannelMessage({
      botToken: 'tok',
      channelId: 'ch1',
      messageId: 'msg1',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('fetch が呼び出されていない');
    expect(call.url).toBe('https://discord.com/api/v10/channels/ch1/messages/msg1');
    expect(call.init.method).toBe('DELETE');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bot tok');
    expect(resp.status).toBe(204);
  });

  it('タイムアウト用の AbortSignal を設定する', async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Response(null, { status: 204 });
    });

    await deleteChannelMessage({ botToken: 'tok', channelId: 'ch1', messageId: 'msg1' });

    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('classifyDeleteResponse', () => {
  it('2xx は完了と判定する', () => {
    expect(classifyDeleteResponse(204, null)).toEqual({ kind: 'done' });
  });

  it('404 は削除済みとして完了と判定する', () => {
    expect(classifyDeleteResponse(404, null)).toEqual({ kind: 'done' });
  });

  it('429 は Retry-After に従って再試行と判定する', () => {
    expect(classifyDeleteResponse(429, '2')).toEqual({ kind: 'retry', delayMs: 2000 });
  });

  it('429 で Retry-After がない場合は 5 秒後に再試行と判定する', () => {
    expect(classifyDeleteResponse(429, null)).toEqual({ kind: 'retry', delayMs: 5000 });
  });

  it('401/403 は 60 秒後に再試行と判定する', () => {
    expect(classifyDeleteResponse(401, null)).toEqual({ kind: 'retry', delayMs: 60_000 });
    expect(classifyDeleteResponse(403, null)).toEqual({ kind: 'retry', delayMs: 60_000 });
  });

  it('その他の 4xx は断念と判定する', () => {
    expect(classifyDeleteResponse(400, null)).toEqual({ kind: 'give_up' });
  });

  it('5xx は 60 秒後に再試行と判定する', () => {
    expect(classifyDeleteResponse(500, null)).toEqual({ kind: 'retry', delayMs: 60_000 });
  });
});
