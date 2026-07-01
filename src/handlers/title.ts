import type { Context } from 'hono';
import type { Bindings } from '../index';
import { optionsToRecord } from '../lib/options';
import type { TitleMaster } from '../lib/titles';
import { deleteTitle, KEY_PREFIX, putTitle } from '../lib/titles';
import { ephemeral } from './ephemeral';

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
      const nameBytes = new TextEncoder().encode(name).length;
      if (nameBytes > 490) {
        return ephemeral(c, 'タイトル名が長すぎます (UTF-8 で 490 バイト以内)');
      }
      const max = Number(opts.max);
      if (!Number.isFinite(max) || max <= 0) {
        return ephemeral(c, '最大スタミナは1以上の数値を指定してください');
      }
      if (max > 100000) {
        return ephemeral(c, '最大スタミナは 100000 以下で指定してください');
      }
      const regenMinutes = Number(opts.regen_minutes);
      if (!Number.isFinite(regenMinutes) || regenMinutes <= 0) {
        return ephemeral(c, '回復分数は1以上の数値を指定してください');
      }
      if (regenMinutes > 1440) {
        return ephemeral(c, '回復分数は 1440 以下 (1 日) で指定してください');
      }
      await putTitle(c.env.TITLES, {
        name,
        max,
        regen_minutes_per_point: regenMinutes,
      });
      return ephemeral(c, `${name} を登録 (max=${max}, regen=${regenMinutes}min/pt)`);
    }
    case 'list': {
      const list = await c.env.TITLES.list({ prefix: KEY_PREFIX });
      if (!list.keys.length) return ephemeral(c, 'タイトル未登録');
      // Discord のメッセージ上限 (2000 文字) を超えないよう 1900 文字でキャップする
      const LIMIT = 1900;
      // 省略サフィックス "\n(他 N 件は省略)" のための余白
      const SUFFIX_RESERVE = 30;
      let content = '';
      let shown = 0;
      // 逐次 get してキャップ到達で打ち切り、キャップを超える KV read を発行しない
      for (const k of list.keys) {
        const raw = await c.env.TITLES.get(k.name);
        if (!raw) continue;
        const t = JSON.parse(raw) as TitleMaster;
        const line = `- ${t.name}: max=${t.max}, regen=${t.regen_minutes_per_point}min/pt`;
        const nextLen = content.length + (content ? 1 : 0) + line.length;
        if (nextLen > LIMIT - SUFFIX_RESERVE) break;
        content = content ? `${content}\n${line}` : line;
        shown++;
      }
      if (shown < list.keys.length) {
        content += `\n(他 ${list.keys.length - shown} 件は省略)`;
      }
      return ephemeral(c, content);
    }
    case 'remove': {
      const name = String(opts.name ?? '').trim();
      if (!name) return ephemeral(c, 'タイトル名は必須です');
      const nameBytes = new TextEncoder().encode(name).length;
      if (nameBytes > 490) {
        return ephemeral(c, 'タイトル名が長すぎます (UTF-8 で 490 バイト以内)');
      }
      await deleteTitle(c.env.TITLES, name);
      return ephemeral(c, `${name} を削除`);
    }
  }
  return ephemeral(c, '未対応のサブコマンド');
}
