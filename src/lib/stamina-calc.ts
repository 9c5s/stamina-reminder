export interface CalcArgs {
  current: number;
  max: number;
  regenSecondsPerPoint: number;
  nowMs: number;
}

export function calculateFullAtMs(args: CalcArgs): number | null {
  const remain = args.max - args.current;
  if (remain <= 0) return null;
  return args.nowMs + remain * args.regenSecondsPerPoint * 1000;
}
