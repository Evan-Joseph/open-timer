import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { SqliteStorage } from './repo/sqlite-storage.js';
import type { AppConfig } from './config.js';

const dirs: string[] = [];
const config = (dbPath: string, aiEncryptionKey: string | null = 'test-encryption-key') : AppConfig => ({
  dbPath, port: 0, baseUrl: 'http://127.0.0.1:0', isProduction: false, cookieSecure: false,
  sessionTtlMs: 60_000, minSegmentMs: 0, conch: null, aiEncryptionKey, version: 'test',
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'open-timer-test-'));
  dirs.push(dir);
  const storage = new SqliteStorage(join(dir, 'timer.sqlite'));
  await storage.migrate();
  const app = createApp({ storage, config: config(join(dir, 'timer.sqlite')) });
  const response = await app.request('/api/v1/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '246813' }) });
  expect(response.headers.get('set-cookie')).not.toContain('Secure');
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { app, storage, cookie };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('private projects and AI configuration', () => {
  it('does not allow a production first visitor to claim an unbootstrapped instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-timer-prod-test-'));
    dirs.push(dir);
    const storage = new SqliteStorage(join(dir, 'timer.sqlite'));
    await storage.migrate();
    const app = createApp({ storage, config: { ...config(join(dir, 'timer.sqlite')), isProduction: true, cookieSecure: true } });
    const me = await app.request('/api/v1/auth/me');
    expect(await me.json()).toEqual({ authenticated: false, setup_done: false, bootstrap_required: true });
    const response = await app.request('/api/v1/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '246813' }) });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('OWNER_BOOTSTRAP_REQUIRED');
  });

  it('keeps data owner-only and safely archives a project with history', async () => {
    const { app, cookie } = await harness();
    expect((await app.request('/api/v1/projects')).status).toBe(401);
    const create = await app.request('/api/v1/projects', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Client delivery', color_id: 'teal', sort_order: 10 }),
    });
    expect(create.status).toBe(201);
    const project = await create.json() as { subject_id: string; archived_at: string | null };
    const start = await app.request('/api/v1/sessions', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'project-start-001' },
      body: JSON.stringify({ subject_id: project.subject_id }),
    });
    expect(start.status).toBe(201);
    const activeArchive = await app.request(`/api/v1/projects/${project.subject_id}`, { method: 'DELETE', headers: { cookie } });
    expect(activeArchive.status).toBe(409);
    const session = await start.json() as { session_id: string };
    await app.request(`/api/v1/sessions/${session.session_id}/stop`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'project-stop-001' }, body: '{}' });
    expect((await app.request(`/api/v1/projects/${project.subject_id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(200);
    const all = await app.request('/api/v1/projects?include_archived=true', { headers: { cookie } });
    expect((await all.json() as Array<{ subject_id: string; archived_at: string | null }>).find((p) => p.subject_id === project.subject_id)?.archived_at).not.toBeNull();
  });

  it('only accepts project colors represented by the UI palette', async () => {
    const { app, cookie } = await harness();
    const response = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Invalid color', color_id: 'unrendered-purple' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_BODY' });
  });

  it('never returns an AI API key', async () => {
    const { app, cookie } = await harness();
    expect((await app.request('/api/v1/ai-config')).status).toBe(401);
    const saved = await app.request('/api/v1/ai-config', {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'siliconflow', api_base: 'https://api.siliconflow.cn/v1', model: 'test-model', api_key: 'secret-value-not-returned' }),
    });
    expect(saved.status).toBe(200);
    const body = await (await app.request('/api/v1/ai-config', { headers: { cookie } })).text();
    expect(body).not.toContain('secret-value-not-returned');
    expect(body).toContain('test-model');
    expect(body).not.toContain('api_key');
  });

  it('normalizes unreadable persisted AI secrets', async () => {
    const { app, storage, cookie } = await harness();
    await storage.setAiConfig({
      provider: 'openai-compatible',
      apiBase: 'https://api.example.test/v1',
      model: 'test-model',
      encryptedApiKey: 'tampered.payload',
      updatedAtMs: Date.now(),
    });
    const response = await app.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ window: '7d' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AI_CONFIG_UNREADABLE' });
  });
});
