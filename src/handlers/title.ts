import type { Context } from 'hono';
import type { Bindings } from '../index';
import { optionsToRecord } from '../lib/options';
import { deleteTitle, isValidTitleMaster, KEY_PREFIX, putTitle, TITLE_LIMITS } from '../lib/titles';
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
      if (nameBytes > TITLE_LIMITS.NAME_MAX_BYTES) {
        return ephemeral(
          c,
          `タイトル名が長すぎます (UTF-8 で ${TITLE_LIMITS.NAME_MAX_BYTES} バイト以内)`,
        );
      }
      const max = Number(opts.max);
      // Discord 側でも integer option だが、二重防御として handler でも整数判定する
      if (!Number.isInteger(max) || max < TITLE_LIMITS.MAX_MIN) {
        return ephemeral(c, `最大スタミナは ${TITLE_LIMITS.MAX_MIN} 以上の整数で指定してください`);
      }
      if (max > TITLE_LIMITS.MAX_MAX) {
        return ephemeral(c, `最大スタミナは ${TITLE_LIMITS.MAX_MAX} 以下で指定してください`);
      }
      const regenMinutes = Number(opts.regen_minutes);
      if (!Number.isInteger(regenMinutes) || regenMinutes < TITLE_LIMITS.REGEN_MINUTES_MIN) {
        return ephemeral(
          c,
          `回復分数は ${TITLE_LIMITS.REGEN_MINUTES_MIN} 以上の整数で指定してください`,
        );
      }
      if (regenMinutes > TITLE_LIMITS.REGEN_MINUTES_MAX) {
        return ephemeral(
          c,
          `回復分数は ${TITLE_LIMITS.REGEN_MINUTES_MAX} 以下 (1 日) で指定してください`,
        );
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
      let shown = 0;
      // 逐次 get してキャップ到達で打ち切り、キャップを超える KV read を発行しない
      for (const k of list.keys) {
        const raw = await c.env.TITLES.get(k.name);
        // 未登録 (null) は list と実 KV の同時変更でしか起きない稀ケースなので静かに skip
        if (raw === null) continue;
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
          truncated = true;
          break;
        }
        content = content ? `${content}\n${line}` : line;
        shown++;
      }
      if (!content) return ephemeral(c, 'タイトル未登録');
      if (truncated) {
        // shown ベースなので「表示件数 + 未表示件数 = list.keys.length」の不変式が成立する。
        // 未表示分には LIMIT 超過分と破損 skip 分の両方が含まれ得るが、ユーザ視点では
        // どちらも「見えていない」ので一括で伝える方が数字が合う。
        content += `\n(他 ${list.keys.length - shown} 件は未表示)`;
      }
      return ephemeral(c, content);
    }
    case 'remove': {
      const name = String(opts.name ?? '').trim();
      if (!name) return ephemeral(c, 'タイトル名は必須です');
      const nameBytes = new TextEncoder().encode(name).length;
      if (nameBytes > TITLE_LIMITS.NAME_MAX_BYTES) {
        return ephemeral(
          c,
          `タイトル名が長すぎます (UTF-8 で ${TITLE_LIMITS.NAME_MAX_BYTES} バイト以内)`,
        );
      }
      await deleteTitle(c.env.TITLES, name);
      return ephemeral(c, `${name} を削除`);
    }
  }
  return ephemeral(c, '未対応のサブコマンド');
}
