interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  options?: CommandOption[];
}

interface Command {
  name: string;
  description: string;
  options?: CommandOption[];
}

export const commands: Command[] = [
  {
    name: 'stamina',
    description: 'スタミナ通知の管理',
    options: [
      {
        name: 'add',
        description: '現在のスタミナを登録',
        type: 1,
        options: [
          { name: 'title', description: 'タイトル名', type: 3, required: true },
          { name: 'current', description: '現在のスタミナ', type: 4, required: true },
        ],
      },
      { name: 'list', description: '登録中のスタミナ一覧', type: 1 },
      {
        name: 'cancel',
        description: '指定タイトルをキャンセル',
        type: 1,
        options: [{ name: 'title', description: 'タイトル名', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'title',
    description: 'タイトルマスタの管理',
    options: [
      {
        name: 'add',
        description: 'タイトルを追加',
        type: 1,
        options: [
          { name: 'name', description: 'タイトル名', type: 3, required: true },
          { name: 'max', description: '最大スタミナ', type: 4, required: true },
          {
            name: 'regen_seconds',
            description: '1ポイント回復に必要な秒数',
            type: 4,
            required: true,
          },
        ],
      },
      { name: 'list', description: 'タイトル一覧', type: 1 },
      {
        name: 'remove',
        description: 'タイトルを削除',
        type: 1,
        options: [{ name: 'name', description: 'タイトル名', type: 3, required: true }],
      },
    ],
  },
];
