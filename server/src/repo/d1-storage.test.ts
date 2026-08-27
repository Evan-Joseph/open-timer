import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { D1Storage, splitMigrationSql, type D1Database, type D1Statement } from './d1-storage.js';
import { SqliteStorage } from './sqlite-storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SubjectId } from '@clock/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');
const DAY = 86_400_000;

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

/** 用 better-sqlite3 模拟 D1 的 prepare/bind/all/batch，验证两 adapter 的查询形状一致。 */
class SqliteBackedD1 implements D1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): D1Statement {
    const db = this.db;
    let values: unknown[] = [];
    return {
      bind(...next: unknown[]) {
        values = next;
        return this;
      },
      async first<T = unknown>(columnName?: string) {
        const statement = db.prepare(query);
        const row = statement.get(...values) as Record<string, unknown> | undefined;
        return (columnName ? (row?.[columnName] ?? null) : (row ?? null)) as T | null;
      },
      async all<T = Record<string, unknown>>() {
        const statement = db.prepare(query);
        return { results: statement.all(...values) as T[] };
      },
      async run() {
        const statement = db.prepare(query);
        statement.run(...values);
        return { success: true };
      },
    };
  }

  async batch(statements: D1Statement[]) {
    for (const statement of statements) await statement.run();
    return [];
  }
}

describe('SQLite / D1 范围查询一致性', () => {
  it('sessionsOverlapping 含跨午夜、active、voided 时结果形状和稳定顺序一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clock-d1-parity-'));
    const sqlite = new SqliteStorage(join(dir, 'sqlite.db'));
    const d1Db = new Database(':memory:');
    const migrationSql = ['0001_init.sql', '0002_user_pref.sql', '0003_index_session_ended.sql', '0004_conch_revision.sql']
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
      .join('\n');
    const d1 = new D1Storage(new SqliteBackedD1(d1Db), migrationSql);
    await sqlite.migrate();
    await d1.migrate();

    const base = Date.UTC(2026, 7, 1, 15, 50);
    const create = async (
      storage: SqliteStorage | D1Storage,
      id: string,
      subjectId: SubjectId,
      startedAtMs: number,
      stoppedAtMs: number,
    ) => {
      await storage.createSession({ id, userId: 'owner', subjectId, intentNote: null, nowMs: startedAtMs, idempotencyKey: `${id}-start` });
      await storage.stopSession(id, stoppedAtMs, 'manual', `${id}-stop`);
    };
    for (const storage of [sqlite, d1]) {
      await create(storage, 'a-cross-midnight', 'math', base, base + 30 * 60_000);
      await create(storage, 'b-same-start', 'data-structures', base + 2 * DAY, base + 2 * DAY + 60_000);
      await create(storage, 'c-same-start', 'computer-organization', base + 2 * DAY, base + 2 * DAY + 120_000);
      await storage.voidSession('c-same-start', base + 2 * DAY + 180_000, '误记', 'c-void');
      await storage.createSession({ id: 'd-active', userId: 'owner', subjectId: 'english', intentNote: null, nowMs: base - DAY, idempotencyKey: 'd-start' });
      await storage.pauseSession('d-active', base - DAY + 60_000, 'd-pause');
    }

    const start = Date.UTC(2026, 7, 1, 16, 0);
    const end = start + 3 * DAY;
    const shape = (rows: Awaited<ReturnType<SqliteStorage['sessionsOverlapping']>>) =>
      rows.map((row) => ({ id: row.id, subjectId: row.subjectId, status: row.status, startedAtMs: row.startedAtMs, endedAtMs: row.endedAtMs }));

    await expect(sqlite.sessionsOverlapping(start, end)).resolves.toEqual(await d1.sessionsOverlapping(start, end));
    expect(shape(await sqlite.sessionsOverlapping(start, end))).toEqual(shape(await d1.sessionsOverlapping(start, end)));
    expect(shape(await sqlite.sessionsOverlapping(start, end, { includeVoided: true }))).toEqual(
      shape(await d1.sessionsOverlapping(start, end, { includeVoided: true })),
    );
    expect((await sqlite.sessionsOverlapping(start, end, { includeVoided: true })).map((r) => r.id)).toEqual([
      'd-active',
      'a-cross-midnight',
      'b-same-start',
      'c-same-start',
    ]);

    sqlite.close();
    d1Db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
