import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { splitMigrationSql } from './d1-storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');

describe('splitMigrationSql', () => {
  it('剔除整行注释并按分号拆分（兼容单行/多行语句）', () => {
    const sql = [
      '-- 注释行',
      'CREATE TABLE IF NOT EXISTS a (id INTEGER PRIMARY KEY);',
      'CREATE TABLE IF NOT EXISTS b (',
      '  id INTEGER PRIMARY KEY,',
      '  name TEXT NOT NULL',
      ');',
      '',
      '-- 又一条注释',
    ].join('\n');
    const statements = splitMigrationSql(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('CREATE TABLE IF NOT EXISTS a (id INTEGER PRIMARY KEY)');
    expect(statements[1].startsWith('CREATE TABLE IF NOT EXISTS b')).toBe(true);
    expect(statements[1].endsWith(')')).toBe(true);
    expect(statements.every((s) => !s.includes('--'))).toBe(true);
  });

  it('真实迁移文件：全部语句以 CREATE 开头、无空语句、无注释残留', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8')
      + '\n' + readFileSync(join(MIGRATIONS_DIR, '0002_user_pref.sql'), 'utf8');
    const statements = splitMigrationSql(sql);
    expect(statements.length).toBeGreaterThanOrEqual(16);
    for (const s of statements) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.startsWith('CREATE')).toBe(true);
      expect(s.includes('--')).toBe(false);
    }
  });
});
