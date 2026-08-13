import { parseRetryAfterMs } from './retry-after';

export interface PostChannelMessageArgs {
  botToken: string;
  channelId: string;
  content: string;
  /** メンション解決を許可する Discord ユーザー ID (owner のみに限定して誤 mention を防ぐ) */
  mentionUserId: string;
}

/** メッセージ削除レスポンスの後続アクション */
export type DeleteResponseAction =
  | { kind: 'done' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'give_up' };

/**
 * メッセージ削除 API のレスポンスステータスから後続アクションを判定する。
 * 404 は対象が既に存在しないため完了扱いとする。
 * 401/403 はトークンローテーションや権限設定中の可能性があるため再試行する。
 */
export function classifyDeleteResponse(
  status: number,
  retryAfterHeader: string | null,
): DeleteResponseAction {
  if ((status >= 200 && status < 300) || status === 404) return { kind: 'done' };
  if (status === 429) return { kind: 'retry', delayMs: parseRetryAfterMs(retryAfterHeader) };
  if (status === 401 || status === 403) return { kind: 'retry', delayMs: 60_000 };
  if (status >= 400 && status < 500) return { kind: 'give_up' };
  return { kind: 'retry', delayMs: 60_000 };
}

export interface DeleteChannelMessageArgs {
  botToken: string;
  channelId: string;
  messageId: string;
}

/** チャンネルメッセージを削除する (満タン通知の期限切れ自動削除に使用) */
export async function deleteChannelMessage(args: DeleteChannelMessageArgs): Promise<Response> {
  const url = `https://discord.com/api/v10/channels/${args.channelId}/messages/${args.messageId}`;
  return fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bot ${args.botToken}`,
    },
    // Discord が応答しない場合に alarm() が無期限にブロックされることを防ぐ
    signal: AbortSignal.timeout(10_000),
  });
}

export async function postChannelMessage(args: PostChannelMessageArgs): Promise<Response> {
  const url = `https://discord.com/api/v10/channels/${args.channelId}/messages`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${args.botToken}`,
    },
    body: JSON.stringify({
      content: args.content,
      // parse: ['users'] は全ユーザーへの mention を許可してしまうため、owner のみを明示する
      allowed_mentions: { users: [args.mentionUserId] },
    }),
    // Discord が応答しない場合に alarm() が無期限にブロックされることを防ぐ
    signal: AbortSignal.timeout(10_000),
  });
}
