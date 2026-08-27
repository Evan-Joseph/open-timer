import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { D1Storage, splitMigrationSql, type D1Database, type D1Statement } from './d1-storage.js';

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

  it('真实迁移文件：CREATE 语句可被正确拆分', () => {
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

describe('D1Storage migrations', () => {
  it('records a version and does not replay a non-idempotent ALTER', async () => {
    const executed: string[] = [];
    const applied = new Set<number>();
    const statement = (sql: string): D1Statement => ({
      bind(...values: unknown[]) {
        if (sql.startsWith('INSERT INTO schema_migrations')) applied.add(values[0] as number);
        return this;
      },
      async first() { return null; },
      async all<T = Record<string, unknown>>() {
        if (sql.startsWith('SELECT version')) return { results: [...applied].map((version) => ({ version })) as unknown as T[] };
        return { results: [] as T[] };
      },
      async run() { executed.push(sql); return { success: true }; },
    });
    const db: D1Database = {
      prepare: statement,
      async batch(stmts) {
        for (const stmt of stmts) {
          executed.push('batch');
          await stmt.run();
        }
        return [];
      },
    };
    const storage = new D1Storage(db, [{ version: 9, sql: 'ALTER TABLE subject ADD COLUMN archived_at_ms INTEGER;' }]);
    await storage.migrate();
    await storage.migrate();
    expect(executed.filter((entry) => entry.includes('ALTER TABLE'))).toHaveLength(1);
  });
});
