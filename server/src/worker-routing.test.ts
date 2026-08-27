import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('Worker Static Assets / API routing contract', () => {
  it('API 走 Worker first，静态资源 asset-first 且 SPA fallback 不会吞 API 错误', () => {
    const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    const worker = readFileSync(join(ROOT, 'server', 'src', 'worker.ts'), 'utf8');
    const headers = readFileSync(join(ROOT, 'web', 'public', '_headers'), 'utf8');

    expect(wrangler).toContain('"not_found_handling": "single-page-application"');
    expect(wrangler).toMatch(/"run_worker_first"\s*:\s*\[\s*"\/api\/\*"\s*\]/);
    // /api/* 在 asset fallback 前返回 Hono JSON（包括 400 / NOT_FOUND），不会落 index.html。
    expect(worker).toContain("if (url.pathname.startsWith('/api/'))");
    expect(worker).toContain('return app.fetch(request)');
    // asset-first 后，静态响应安全头由 _headers 接管。
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).toContain('X-Frame-Options: DENY');
  });
});
