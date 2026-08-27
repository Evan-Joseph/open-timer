import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from './sqlite-storage.js';

describe('SqliteStorage project migration', () => {
  it('creates a fresh database with neutral default projects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-timer-'));
    const storage = new SqliteStorage(join(directory, 'timer.sqlite'));
    try {
      await storage.migrate();
      const projects = await storage.listProjects();
      expect(projects.map((p) => p.id)).toEqual(['deep-work', 'planning', 'meetings']);
      expect(projects.every((p) => p.aggregateGroup === 'General')).toBe(true);
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
