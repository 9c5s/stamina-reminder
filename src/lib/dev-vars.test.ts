import { describe, expect, it } from 'vitest';
import { parseDevVars } from './dev-vars';

describe('parseDevVars', () => {
  it('parses simple key=value pairs', () => {
    const result = parseDevVars('FOO=bar\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores blank lines', () => {
    const result = parseDevVars('FOO=bar\n\n\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comment lines starting with #', () => {
    const result = parseDevVars('# this is comment\nFOO=bar\n# another\n');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('strips surrounding double quotes', () => {
    const result = parseDevVars('FOO="hello"\n');
    expect(result).toEqual({ FOO: 'hello' });
  });

  it('strips surrounding single quotes', () => {
    const result = parseDevVars("FOO='hello'\n");
    expect(result).toEqual({ FOO: 'hello' });
  });

  it('keeps = inside the value', () => {
    const result = parseDevVars('TOKEN=a=b=c\n');
    expect(result).toEqual({ TOKEN: 'a=b=c' });
  });

  it('trims whitespace around keys and values', () => {
    const result = parseDevVars('  FOO  =  bar  \n');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('returns empty object for empty input', () => {
    const result = parseDevVars('');
    expect(result).toEqual({});
  });
});
