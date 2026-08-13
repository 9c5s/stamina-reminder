/**
 * Discord の Retry-After ヘッダ (秒) をミリ秒に変換する。
 * 解釈できない値や 0 以下の値は fallbackMs を返す。
 */
export function parseRetryAfterMs(header: string | null, fallbackMs = 5000): number {
  const sec = header ? Number(header) : NaN;
  return Number.isFinite(sec) && sec > 0 ? Math.ceil(sec * 1000) : fallbackMs;
}
