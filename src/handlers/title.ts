import { InteractionResponseType } from 'discord-interactions';
import type { Context } from 'hono';
import type { Bindings } from '../index';
import { optionsToRecord } from '../lib/options';
import { deleteTitle, listTitles, putTitle } from '../lib/titles';

interface Interaction {
  data?: {
    options?: { name: string; options?: { name: string; value: string | number }[] }[];
  };
}

export async function handleTitle(
  c: Context<{ Bindings: Bindings }>,
  interaction: Interaction,
): Promise<Response> {
  const sub = interaction.data?.options?.[0];
  if (!sub) return ephemeral(c, 'サブコマンド指定なし');

  const opts = optionsToRecord(sub.options);

  switch (sub.name) {
    case 'add': {
      const name = String(opts.name ?? '').trim();
      if (!name) return ephemeral(c, 'タイトル名は必須です');
      const max = Number(opts.max);
      if (!Number.isFinite(max) || max <= 0) {
        return ephemeral(c, '最大スタミナは1以上の数値を指定してください');
      }
      const regen = Number(opts.regen_seconds);
      if (!Number.isFinite(regen) || regen <= 0) {
        return ephemeral(c, '回復秒数は1以上の数値を指定してください');
      }
      await putTitle(c.env.TITLES, {
        name,
        max,
        regen_seconds_per_point: regen,
      });
      return ephemeral(c, `${name} を登録 (max=${max}, regen=${regen}s/pt)`);
    }
    case 'list': {
      const titles = await listTitles(c.env.TITLES);
      if (!titles.length) return ephemeral(c, 'タイトル未登録');
      const lines = titles.map(
        (t) => `- ${t.name}: max=${t.max}, regen=${t.regen_seconds_per_point}s/pt`,
      );
      return ephemeral(c, lines.join('\n'));
    }
    case 'remove': {
      const name = String(opts.name ?? '').trim();
      if (!name) return ephemeral(c, 'タイトル名は必須です');
      await deleteTitle(c.env.TITLES, name);
      return ephemeral(c, `${name} を削除`);
    }
  }
  return ephemeral(c, '未対応のサブコマンド');
}

function ephemeral(c: Context, msg: string) {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}
