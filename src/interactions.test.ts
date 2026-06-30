import { describe, expect, it } from 'vitest';
import { dispatchInteraction } from './interactions';

describe('dispatchInteraction', () => {
  it('returns PONG for PING interaction', () => {
    const result = dispatchInteraction({ type: 1 });
    expect(result).toEqual({ type: 1 });
  });

  it('returns ephemeral fallback for unknown application command', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'unknown' },
    });
    expect(result).toEqual({
      type: 4,
      data: { content: '未対応のコマンド', flags: 64 },
    });
  });

  it('returns ephemeral fallback for unknown interaction type', () => {
    const result = dispatchInteraction({ type: 99 });
    expect(result).toEqual({
      type: 4,
      data: { content: '未対応のコマンド', flags: 64 },
    });
  });
});
