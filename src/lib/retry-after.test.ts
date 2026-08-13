import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from './retry-after';

describe('parseRetryAfterMs', () => {
  it('数値秒の Retry-After をミリ秒に変換する', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
  });

  it('小数秒は切り上げてミリ秒にする', () => {
    expect(parseRetryAfterMs('1.5')).toBe(1500);
  });

  it('ヘッダが null の場合はフォールバック値を返す', () => {
    expect(parseRetryAfterMs(null)).toBe(5000);
  });

  it('数値として解釈できない場合はフォールバック値を返す', () => {
    expect(parseRetryAfterMs('abc')).toBe(5000);
  });

  it('0 以下の場合はフォールバック値を返す', () => {
    expect(parseRetryAfterMs('0')).toBe(5000);
    expect(parseRetryAfterMs('-1')).toBe(5000);
  });

  it('フォールバック値を指定できる', () => {
    expect(parseRetryAfterMs(null, 60_000)).toBe(60_000);
  });
});
