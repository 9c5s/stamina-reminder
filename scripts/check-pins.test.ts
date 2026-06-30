import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function runCheckPins(repoRoot: string) {
  return spawnSync('bash', ['scripts/check-pins.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-pins-test-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  // テスト対象の本物のスクリプトを Node fs API でコピー (Windows でも PATH 依存なし)
  const scriptSrc = join(process.cwd(), 'scripts', 'check-pins.sh');
  const scriptDst = join(dir, 'scripts', 'check-pins.sh');
  copyFileSync(scriptSrc, scriptDst);
  chmodSync(scriptDst, 0o755);
  // git init して staging だけ揃える
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  // 開発者のグローバル設定 (commit.gpgsign=true 等) の影響を受けないようローカルで隔離する
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  return dir;
}

function commitAll(dir: string) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'test'], { cwd: dir });
}

describe('check-pins.sh', () => {
  it('exits 0 when no placeholders remain', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'package.json'), '{"name":"x","packageManager":"bun@1.2.20"}\n');
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <SHA> placeholder remains outside docs/', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'foo.txt'), 'value <SHA>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<SHA>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when <SHA> only appears under docs/', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'spec.md'), 'value <SHA>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <BUN_VERSION_PIN> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'package.json'), '{"packageManager":"bun@<BUN_VERSION_PIN>"}\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/_PIN/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <KV_NAMESPACE_ID> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'wrangler.toml'), 'id = "<KV_NAMESPACE_ID>"\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<KV_NAMESPACE_ID>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <BOT_TOKEN> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'scripts.md'), 'token: <BOT_TOKEN>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<BOT_TOKEN>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <subdomain> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'README.md'), 'url: https://x.<subdomain>.workers.dev\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<subdomain>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when workflow uses a tag reference instead of full SHA', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Non-SHA uses/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when workflow uses a 40-char hex SHA', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows local action references (./action) without SHA', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/local\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN appears as a real-looking literal (not placeholder)', () => {
    const dir = makeTempRepo();
    // 20 文字以上の token 風文字列 (Discord bot token は 70 文字程度、最低 20 文字で detect)
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      'DISCORD_BOT_TOKEN=AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has Bot prefix with a real-looking literal', () => {
    const dir = makeTempRepo();
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      'DISCORD_BOT_TOKEN=Bot AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has Bearer prefix with a real-looking literal', () => {
    const dir = makeTempRepo();
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      'DISCORD_BOT_TOKEN=Bearer AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when DISCORD_BOT_TOKEN value is the <BOT_TOKEN> placeholder form', () => {
    const dir = makeTempRepo();
    // HANDOFF.md は placeholder 表記 (<>) なら secret scan で検出されない
    writeFileSync(join(dir, 'HANDOFF.md'), 'DISCORD_BOT_TOKEN=<BOT_TOKEN>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    // <BOT_TOKEN> 自体は placeholder scan で検出されるが、allowlist で HANDOFF.md は除外、
    // かつ secret scan も `<` 始まりは除外するため、本ケースは exit 0
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has colon-style assignment (YAML) with a real-looking literal', () => {
    const dir = makeTempRepo();
    // YAML や設定ファイル中で colon 区切りで誤って commit された場合も検出する
    writeFileSync(
      join(dir, 'config.yml'),
      'env:\n  DISCORD_BOT_TOKEN: AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when DISCORD_BOT_TOKEN colon-style value is the <BOT_TOKEN> placeholder form', () => {
    const dir = makeTempRepo();
    // HANDOFF.md は placeholder 表記 (<>) なら secret scan で検出されない (colon 区切りでも同様)
    writeFileSync(join(dir, 'HANDOFF.md'), 'DISCORD_BOT_TOKEN: <BOT_TOKEN>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has a quoted key (JSON/TOML) with a real-looking literal', () => {
    const dir = makeTempRepo();
    // JSON や TOML 形式で key を quote して書かれていても検出する
    writeFileSync(
      join(dir, 'config.json'),
      '{"DISCORD_BOT_TOKEN": "AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789"}\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('redacts the token value in the output when a real-looking literal is detected', () => {
    const dir = makeTempRepo();
    const fakeToken = 'AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789';
    writeFileSync(join(dir, 'HANDOFF.md'), `DISCORD_BOT_TOKEN=${fakeToken}\n`);
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    const output = r.stdout + r.stderr;
    // [REDACTED] が出力に含まれる
    expect(output).toMatch(/\[REDACTED\]/);
    // 生の token は出力に含まれない (CI ログへの 2 次漏出を防ぐ)
    expect(output).not.toContain(fakeToken);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has single-quoted key (YAML/JS) with a real-looking literal', () => {
    const dir = makeTempRepo();
    // JS/YAML 等で key を single quote した形でも検出する
    writeFileSync(
      join(dir, 'config.js'),
      "const env = { 'DISCORD_BOT_TOKEN': 'AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789' };\n",
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when workflow uses key has space before colon (uses : action@tag)', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses : actions/checkout@v4\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Non-SHA uses/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when workflow uses key is quoted ("uses": action@tag)', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - "uses": actions/checkout@v4\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Non-SHA uses/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when workflow uses a quoted 40-char hex SHA value (uses: "...@<sha>")', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: "actions/checkout@0123456789abcdef0123456789abcdef01234567"\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when workflow uses a quoted local action value (uses: "./...")', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: "./.github/actions/local"\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when DISCORD_PUBLIC_KEY is committed as a 64-hex literal (public value, allowed)', () => {
    const dir = makeTempRepo();
    // wrangler.toml に実 64 hex の Ed25519 公開鍵を [vars] で commit するのが正式仕様 (spec §9)。
    // secret-like scan は DISCORD_BOT_TOKEN のみ対象なので、この commit は exit 0 になるべき。
    writeFileSync(
      join(dir, 'wrangler.toml'),
      'DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
