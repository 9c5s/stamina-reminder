export interface PostChannelMessageArgs {
  botToken: string;
  channelId: string;
  content: string;
  /** メンション解決を許可する Discord ユーザー ID (owner のみに限定して誤 mention を防ぐ) */
  mentionUserId: string;
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
