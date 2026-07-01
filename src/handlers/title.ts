import type { Context } from 'hono';
import type { Bindings } from '../index';
import { optionsToRecord } from '../lib/options';
import { deleteTitle, isValidTitleMaster, KEY_PREFIX, putTitle } from '../lib/titles';
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
      // Discord 側でも integer option だが、二重防御として handler でも整数判定する
      if (!Number.isInteger(max) || max <= 0) {
        return ephemeral(c, '最大スタミナは1以上の整数で指定してください');
      }
      if (max > 100000) {
        return ephemeral(c, '最大スタミナは 100000 以下で指定してください');
      }
      const regenMinutes = Number(opts.regen_minutes);
      if (!Number.isInteger(regenMinutes) || regenMinutes <= 0) {
        return ephemeral(c, '回復分数は1以上の整数で指定してください');
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
      // truncated は「LIMIT に達して打ち切った」場合のみ true にし、破損/欠落 skip とは区別する
      let truncated = false;
      let processed = 0;
      // 逐次 get してキャップ到達で打ち切り、キャップを超える KV read を発行しない
      for (const k of list.keys) {
        processed++;
        const raw = await c.env.TITLES.get(k.name);
        if (!raw) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          console.warn(`title KV entry corrupt (JSON parse failed): ${k.name}`, err);
          continue;
        }
        if (!isValidTitleMaster(parsed)) {
          console.warn(`title KV entry corrupt (schema mismatch): ${k.name}`);
          continue;
        }
        const line = `- ${parsed.name}: max=${parsed.max}, regen=${parsed.regen_minutes_per_point}min/pt`;
        const nextLen = content.length + (content ? 1 : 0) + line.length;
        if (nextLen > LIMIT - SUFFIX_RESERVE) {
          // この行は入りきらなかったので processed を巻き戻し、未処理件数として省略数へ加算する
          processed--;
          truncated = true;
          break;
        }
        content = content ? `${content}\n${line}` : line;
      }
      if (!content) return ephemeral(c, 'タイトル未登録');
      if (truncated) {
        content += `\n(他 ${list.keys.length - processed} 件は省略)`;
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
