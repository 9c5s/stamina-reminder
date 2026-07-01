export interface PostChannelMessageArgs {
  botToken: string;
  channelId: string;
  content: string;
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
      allowed_mentions: { parse: ['users'] },
    }),
  });
}
