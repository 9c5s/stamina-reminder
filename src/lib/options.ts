export interface DiscordOption {
  name: string;
  value: string | number;
}

export function optionsToRecord(
  opts: DiscordOption[] | undefined | null,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (!opts) return result;
  for (const o of opts) {
    result[o.name] = o.value;
  }
  return result;
}
