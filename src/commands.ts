import { TITLE_LIMITS } from './lib/titles';

interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  max_length?: number;
  min_value?: number;
  max_value?: number;
  options?: CommandOption[];
}

interface Command {
  name: string;
  description: string;
  /** Discord パーミッションビット文字列。"8" = MANAGE_GUILD (管理者) のみ表示 */
  default_member_permissions?: string;
  options?: CommandOption[];
}

export const commands: Command[] = [
  {
    name: 'stamina',
    description: 'スタミナ通知の管理',
    default_member_permissions: '8',
    options: [
      {
        name: 'add',
        description: '現在のスタミナを登録',
        type: 1,
        options: [
          {
            name: 'title',
            description: 'タイトル名',
            type: 3,
            required: true,
            max_length: TITLE_LIMITS.NAME_MAX_CHARS,
          },
          { name: 'current', description: '現在のスタミナ', type: 4, required: true },
        ],
      },
      { name: 'list', description: '登録中のスタミナ一覧', type: 1 },
      {
        name: 'cancel',
        description: '指定タイトルをキャンセル',
        type: 1,
        options: [
          {
            name: 'title',
            description: 'タイトル名',
            type: 3,
            required: true,
            max_length: TITLE_LIMITS.NAME_MAX_CHARS,
          },
        ],
      },
    ],
  },
  {
    name: 'title',
    description: 'タイトルマスタの管理',
    default_member_permissions: '8',
    options: [
      {
        name: 'add',
        description: 'タイトルを追加',
        type: 1,
        options: [
          {
            name: 'name',
            description: 'タイトル名',
            type: 3,
            required: true,
            max_length: TITLE_LIMITS.NAME_MAX_CHARS,
          },
          {
            name: 'max',
            description: '最大スタミナ',
            type: 4,
            required: true,
            min_value: TITLE_LIMITS.MAX_MIN,
            max_value: TITLE_LIMITS.MAX_MAX,
          },
          {
            name: 'regen_minutes',
            description: '1ポイント回復に必要な分数',
            type: 4,
            required: true,
            min_value: TITLE_LIMITS.REGEN_MINUTES_MIN,
            max_value: TITLE_LIMITS.REGEN_MINUTES_MAX,
          },
        ],
      },
      { name: 'list', description: 'タイトル一覧', type: 1 },
      {
        name: 'remove',
        description: 'タイトルを削除',
        type: 1,
        options: [
          {
            name: 'name',
            description: 'タイトル名',
            type: 3,
            required: true,
            max_length: TITLE_LIMITS.NAME_MAX_CHARS,
          },
        ],
      },
    ],
  },
];
