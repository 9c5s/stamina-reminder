import { describe, expect, it } from 'vitest';
import { dispatchInteraction } from './interactions';

describe('dispatchInteraction', () => {
  it('returns pong for PING interaction', () => {
    const result = dispatchInteraction({ type: 1 });
    expect(result).toEqual({ kind: 'pong' });
  });

  it('routes /stamina to stamina handler', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'stamina', options: [{ name: 'list', options: [] }] },
    });
    expect(result).toEqual({ kind: 'route', name: 'stamina' });
  });

  it('routes /title to title handler', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'title', options: [{ name: 'list', options: [] }] },
    });
    expect(result).toEqual({ kind: 'route', name: 'title' });
  });

  it('returns unknown for application command with unknown name', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'mystery' },
    });
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('returns unknown for unsupported interaction type', () => {
    const result = dispatchInteraction({ type: 99 });
    expect(result).toEqual({ kind: 'unknown' });
  });
});
