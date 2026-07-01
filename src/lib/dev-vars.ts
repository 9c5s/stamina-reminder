export function parseDevVars(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .replace(/^﻿/, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [k, ...v] = line.split('=');
        return [
          k?.trim(),
          v
            .join('=')
            .trim()
            .replace(/^['"]|['"]$/g, ''),
        ];
      }),
  );
}
