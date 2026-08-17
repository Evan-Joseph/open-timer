# Responsive Alert UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 迁移成熟计时器的固定视口骨架、窗口尺寸分档和全局状态层，并确保 7 天泳道永远不把开放段延伸到 `22:30`。

**Architecture:** 休息等级仍由 `ClockFace` 唯一计算，应用根用 CSS `:has()` 消费现有 `data-away-level`，不复制状态机。页面采用 Super Productivity 式固定骨架、Pomotroid 式视口锁定、FocusTide 式全局状态层和 Tomato 式窗口尺寸分档。

**Tech Stack:** React 18, TypeScript, CSS, Motion, Playwright, Hono/Cloudflare Workers.

---

## File Map

- Modify: `e2e/flow.spec.ts` - 补充运行/暂停开放段的 7 天泳道回归。
- Create: `e2e/responsive.spec.ts` - 多视口、文档溢出、全屏抽屉和全局告警回归。
- Modify: `web/src/styles.css` - 视口骨架、尺寸 token、告警状态层和响应式密度的唯一实现位置。
- Verify only: `web/src/components/Timeline.tsx` - 保留 `if (!segment.ended_at) return []`，不新增时间回退。
- Verify only: `web/src/components/ClockFace.tsx` - 保留 `data-away-level`、静默时段和休息等级的单一计算权。

### Task 1: Lock the weekly-lane open-segment contract

**Files:**
- Modify: `e2e/flow.spec.ts:334`
- Verify: `web/src/components/Timeline.tsx:485`

- [ ] **Step 1: Extend the existing session mock with explicit running and paused open states**

Add a mutable status next to `todayHasUnfinished`:

```ts
let todayOpenStatus: 'running' | 'paused' = 'running';
```

Use it when constructing the open session:

```ts
status: unfinished ? todayOpenStatus : 'stopped',
end_reason: unfinished ? null : 'manual',
segments: [{ started_at: segmentStartedAt, ended_at: segmentEndedAt }],
```

- [ ] **Step 2: Assert that neither running nor paused open segments are rendered**

Insert after the current running-open assertion:

```ts
await page.getByTestId('history-toggle').click();
await expect(report).toHaveCount(0);
todayOpenStatus = 'paused';
await page.getByTestId('history-toggle').click();
await expect(report.locator('.history-lane').last().locator('.history-lane-segment')).toHaveCount(1);
await expect(report.locator('.history-lane-segment')).toHaveCount(7);
```

Then retain the existing final transition to `todayHasUnfinished = false` and expect 8 segments.

- [ ] **Step 3: Run the focused contract test**

Run:

```bash
npm run build -w web
npx playwright test --project=desktop-light -g '近 7 天执行回顾'
```

Expected: `1 passed`. The public screenshot is the failing production evidence; current local source should already pass because commit `7169eb5` filters `ended_at: null`.

- [ ] **Step 4: Verify there is no fallback for open history segments**

Run:

```bash
rg -n "segment\.ended_at.*dayEnd|segment\.ended_at.*nowMs|!segment\.ended_at" web/src/components/Timeline.tsx
```

Expected: one guard `if (!segment.ended_at) return [];` and no null-to-`dayEnd` or null-to-`nowMs` fallback in `historyLanes`.

- [ ] **Step 5: Commit the regression**

```bash
git add e2e/flow.spec.ts
git commit -m "test: cover paused open segments in weekly review"
```

### Task 2: Add viewport and alert-state regression tests

**Files:**
- Create: `e2e/responsive.spec.ts`

- [ ] **Step 1: Create a local setup helper inside the new spec**

Use the existing PIN flow without importing another test file:

```ts
import { test, expect, type Page } from '@playwright/test';
import { isQuietMinute } from '@clock/shared';

const PASSWORD = '123456';

async function enterReadyState(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(300);
  if (await page.locator('.pin-dots').count()) {
    await page.keyboard.type(PASSWORD);
    await page.waitForTimeout(500);
    if (await page.getByText('再输入一次以确认').count()) {
      await page.keyboard.type(PASSWORD);
      await page.waitForTimeout(700);
    }
  }
  await expect(page.getByTestId('idle-clock')).toBeVisible();
}

async function expectDocumentFits(page: Page) {
  const dimensions = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}
```

- [ ] **Step 2: Add the idle multi-viewport no-scroll test**

```ts
test('横屏标准视口一屏容纳主时钟与时间轴', async ({ page }) => {
  await enterReadyState(page);
  for (const viewport of [
    { width: 1024, height: 640 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectDocumentFits(page);
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    await expect(page.getByTestId('timeline-scroll')).toBeVisible();
  }
});
```

- [ ] **Step 3: Add the seven-day compact-view test**

```ts
test('1024x640 中 7 天泳道不触发页面滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await enterReadyState(page);
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-strip')).toBeVisible();
  await expect(page.locator('.history-lane')).toHaveCount(7);
  await expectDocumentFits(page);
});
```

- [ ] **Step 4: Add the overdue full-screen timeline integration test**

```ts
test('全屏逾期时主区与时间轴共享告警状态', async ({ page }) => {
  const beijingNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const minute = beijingNow.getUTCHours() * 60 + beijingNow.getUTCMinutes();
  test.skip(isQuietMinute(minute) || isQuietMinute(minute + 10), '静默时段不升级告警');
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 720 });
  await enterReadyState(page);
  await page.getByRole('radio', { name: '数学二' }).click();
  await page.getByTestId('start-btn').click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '暂停计时' }).click();
  await page.clock.fastForward(9 * 60 * 1000);
  const overlay = page.locator('.away-overlay');
  if (await overlay.count()) await overlay.click({ position: { x: 4, y: 4 } });
  await page.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}));
  await page.waitForTimeout(400);
  test.skip(!(await page.evaluate(() => Boolean(document.fullscreenElement))), '浏览器不支持全屏');
  await page.getByRole('button', { name: '展开时间轴' }).click();
  const state = await page.locator('.app').evaluate((element) => {
    const app = getComputedStyle(element);
    const drawer = getComputedStyle(document.querySelector('.timeline-drawer')!);
    return {
      level: document.querySelector('.clockface')?.getAttribute('data-away-level'),
      wash: app.getPropertyValue('--alert-wash').trim(),
      drawerBackground: drawer.backgroundColor,
    };
  });
  expect(state.level).toBe('3');
  expect(state.wash).not.toBe('transparent');
  expect(state.drawerBackground).not.toBe('rgb(255, 255, 255)');
  await expectDocumentFits(page);
});
```

- [ ] **Step 5: Run tests to verify the current layout fails for the intended reasons**

Run:

```bash
npx playwright test --project=desktop-light e2e/responsive.spec.ts
```

Expected before CSS changes: idle viewport assertions fail at `1024x640` and `1280x720`; the alert test fails because `--alert-wash` is unset or the drawer remains the normal surface.

- [ ] **Step 6: Commit the failing tests**

```bash
git add e2e/responsive.spec.ts
git commit -m "test: define responsive alert UI contract"
```

### Task 3: Migrate the fixed viewport skeleton

**Files:**
- Modify: `web/src/styles.css:105-330`

- [ ] **Step 1: Lock the document and application to the dynamic viewport**

Replace the root layout declarations with:

```css
html, body, #root {
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  overflow: hidden;
}

.app {
  --topbar-height: 44px;
  --timeline-track-height: 96px;
  --main-pad-block: clamp(18px, 4dvh, 48px);
  --clock-gap: clamp(10px, 1.8dvh, 16px);
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  display: grid;
  grid-template-rows: var(--topbar-height) minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--bg);
}
```

- [ ] **Step 2: Remove error banners from the grid flow and constrain the main row**

```css
.sync-banner {
  position: fixed;
  top: calc(var(--topbar-height, 44px) + 8px);
  left: 16px;
  right: 16px;
  z-index: 50;
  margin: 0;
}

.main {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: var(--main-pad-block) 16px;
}

.clockface { gap: var(--clock-gap); }
.timeline { min-height: 0; }
.timeline-track { height: var(--timeline-track-height); }
```

- [ ] **Step 3: Run the idle no-scroll test**

Run:

```bash
npm run build -w web
npx playwright test --project=desktop-light e2e/responsive.spec.ts -g '横屏标准视口'
```

Expected: the document no longer scrolls; content visibility may still fail until Task 4 tightens height tokens.

- [ ] **Step 4: Commit the skeleton**

```bash
git add web/src/styles.css
git commit -m "feat: adopt fixed viewport clock skeleton"
```

### Task 4: Migrate window-size classes and compact history layout

**Files:**
- Modify: `web/src/styles.css:330-700, 1000-1048`

- [ ] **Step 1: Make clock typography depend on available height**

```css
.idle-clock { font-size: clamp(52px, 11dvh, 96px); }
.big-timer { font-size: clamp(58px, 12dvh, 112px); }
```

- [ ] **Step 2: Add compact and ultra-compact height classes**

```css
@media (max-height: 760px) {
  .app {
    --timeline-track-height: 78px;
    --main-pad-block: 12px;
    --clock-gap: 9px;
  }
  .subject-picker { gap: 6px; margin-top: 2px; }
  .subject-chip { padding: 6px 11px; font-size: 13px; }
  .intent-input { padding-block: 8px; }
  .start-btn { min-height: 44px; }
  .control-row { margin-top: 2px; }
  .switch-subject { margin-top: 4px; }
  .timeline { padding-block: 9px 6px; }
  .timeline-head { margin-bottom: 4px; }
  .timeline-scale { margin-bottom: 4px; }
  .quiet-period { top: 22px; height: 32px; }
  .seg { top: 28px; }
  .now-line { top: 22px; bottom: 8px; }
  .overview { margin-top: 4px; }
}

@media (max-height: 660px) {
  .app {
    --timeline-track-height: 68px;
    --main-pad-block: 8px;
    --clock-gap: 6px;
  }
  .idle-date, .sub-line { font-size: 13px; }
  .away-slot { min-height: 30px; }
  .away-line { padding-block: 4px; font-size: 13px; }
  .control-btn { width: 48px; height: 48px; }
  .control-btn.resume { width: 48px; height: 48px; }
  .timeline-scale button { height: 24px; }
}
```

- [ ] **Step 3: Compact the seven-day report without hiding its content**

```css
.app:has(.history-strip) {
  grid-template-rows: var(--topbar-height) minmax(190px, 38dvh) minmax(0, 1fr);
}
.app:has(.history-strip) .main { padding-block: 6px; }
.app:has(.history-strip) .clockface { gap: 6px; }
.app:has(.history-strip) .big-timer { font-size: clamp(52px, 9dvh, 84px); }
.app:has(.history-strip) .timeline { overflow: hidden; }
.app:has(.history-strip) .history-strip {
  height: 100%;
  margin-bottom: 0;
  padding: 10px 14px;
  overflow: hidden;
}
.app:has(.history-strip) .history-report { gap: 8px; margin-top: 8px; }
.app:has(.history-strip) .history-metrics > div { padding-block: 6px; }
.app:has(.history-strip) .history-lanes { gap: 4px; }
.app:has(.history-strip) .history-axis { min-height: 18px; }
.app:has(.history-strip) .history-lane { min-height: 21px; }
.app:has(.history-strip) .history-subjects { gap: 5px; }
```

- [ ] **Step 4: Run idle and history viewport tests**

```bash
npm run build -w web
npx playwright test --project=desktop-light e2e/responsive.spec.ts -g '横屏标准视口|7 天泳道'
```

Expected: both tests pass at all specified sizes with all core elements visible.

- [ ] **Step 5: Commit responsive sizing**

```bash
git add web/src/styles.css
git commit -m "feat: add height-aware clock density"
```

### Task 5: Migrate the full-viewport alert layer

**Files:**
- Modify: `web/src/styles.css:70-105, 420-510, 930-990`

- [ ] **Step 1: Define neutral alert tokens on the application root**

```css
.app {
  --alert-wash: transparent;
  --alert-border: var(--border);
  --alert-duration: 3.2s;
}
.app:has(.clockface[data-away-level='2']) {
  --alert-wash: color-mix(in srgb, var(--amber) 10%, var(--bg));
  --alert-border: color-mix(in srgb, var(--amber) 30%, var(--border));
}
.app:has(.clockface[data-away-level='3']) {
  --alert-wash: color-mix(in srgb, var(--danger) 15%, var(--bg));
  --alert-border: color-mix(in srgb, var(--danger) 38%, var(--border));
  --alert-duration: 1.8s;
}
```

- [ ] **Step 2: Add one shared background layer and remove the separate clockface wash**

```css
.app::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: var(--alert-wash);
  transition: background-color 280ms ease;
}
.app:has(.clockface[data-away-level='2'])::before,
.app:has(.clockface[data-away-level='3'])::before {
  animation: app-alert-breathe var(--alert-duration) ease-in-out infinite;
}
@keyframes app-alert-breathe {
  0%, 100% { opacity: 0.58; }
  50% { opacity: 1; }
}

.clockface[data-away-level='2']::before,
.clockface[data-away-level='3']::before { content: none; }
```

- [ ] **Step 3: Make all main surfaces consume the shared alert tokens**

```css
.main,
.timeline,
.timeline-drawer,
.fs-controls {
  transition: background-color 280ms ease, border-color 280ms ease, box-shadow 280ms ease;
}
.app:has(.clockface[data-away-level='2']) .timeline,
.app:has(.clockface[data-away-level='3']) .timeline,
.app:has(.clockface[data-away-level='2']) .timeline-drawer,
.app:has(.clockface[data-away-level='3']) .timeline-drawer {
  background: color-mix(in srgb, var(--alert-wash) 72%, var(--bg-elevated));
  border-color: var(--alert-border);
}
.app:has(.clockface[data-away-level='2']) .fs-controls,
.app:has(.clockface[data-away-level='3']) .fs-controls {
  background: color-mix(in srgb, var(--alert-wash) 68%, var(--material));
  border-color: var(--alert-border);
}
```

- [ ] **Step 4: Preserve a static alert in reduced-motion modes**

The existing global reduced-motion rules stop animation duration. Add no opacity reset; the `--alert-wash` background remains visible when animation duration becomes `0.01ms`.

- [ ] **Step 5: Run the alert integration test**

```bash
npm run build -w web
npx playwright test --project=desktop-light e2e/responsive.spec.ts -g '全屏逾期'
```

Expected: alert level is `3`, `--alert-wash` is non-transparent, the timeline drawer is not the normal white surface, and the document fits the viewport.

- [ ] **Step 6: Commit alert integration**

```bash
git add web/src/styles.css
git commit -m "feat: unify overdue alert across clock and timeline"
```

### Task 6: Align the full-screen drawer and clock motion

**Files:**
- Modify: `web/src/styles.css:930-990`
- Test: `e2e/responsive.spec.ts`

- [ ] **Step 1: Replace the fixed `-10vh` displacement with the drawer allocation**

```css
.app.fullscreen-mode { --drawer-height: min(45dvh, 360px); }
.timeline-drawer { height: var(--drawer-height); max-height: none; }
.app.fullscreen-mode.fs-timeline-open .main {
  padding-bottom: calc(var(--drawer-height) + 32px);
}
```

- [ ] **Step 2: Use matched, interruptible drawer transitions**

```css
.app.fullscreen-mode .main {
  transition: padding 260ms cubic-bezier(0.2, 0, 0, 1);
}
.timeline-drawer {
  transition:
    transform 260ms cubic-bezier(0.2, 0, 0, 1),
    opacity 200ms ease,
    visibility 0s linear 260ms,
    background-color 280ms ease,
    border-color 280ms ease;
}
.timeline-drawer[data-open='true'] {
  transition-delay: 0s;
}
```

- [ ] **Step 3: Add geometry assertions to the full-screen test**

```ts
const geometry = await page.evaluate(() => {
  const clock = document.querySelector('.clockface')!.getBoundingClientRect();
  const drawer = document.querySelector('.timeline-drawer')!.getBoundingClientRect();
  const controls = document.querySelector('.fs-controls')!.getBoundingClientRect();
  return { clockBottom: clock.bottom, drawerTop: drawer.top, controlsBottom: controls.bottom };
});
expect(geometry.clockBottom).toBeLessThanOrEqual(geometry.drawerTop + 1);
expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.drawerTop);
```

- [ ] **Step 4: Run the full responsive spec**

```bash
npm run build -w web
npx playwright test --project=desktop-light e2e/responsive.spec.ts
```

Expected: all responsive tests pass.

- [ ] **Step 5: Commit full-screen alignment**

```bash
git add web/src/styles.css e2e/responsive.spec.ts
git commit -m "fix: align fullscreen clock with timeline drawer"
```

### Task 7: Full regression and visual evidence

**Files:**
- Verify: `shared/`, `server/`, `web/`, `e2e/`
- Artifacts: ignored `test-results/ui-responsive/`

- [ ] **Step 1: Run all local gates**

```bash
npm test
npm run typecheck
npm run build
npx playwright test --project=desktop-light
npx wrangler deploy --dry-run
git diff --check
```

Expected: shared 46 tests pass, server 12 tests pass, all desktop Playwright tests pass, build/typecheck/dry-run exit 0, and `git diff --check` is empty.

- [ ] **Step 2: Capture deterministic screenshots**

Capture idle, paused overdue with timeline, seven-day review, dark theme and reduced-motion at `1024x640`, `1280x720`, and `1440x900` into `test-results/ui-responsive/`. Use an isolated Playwright context with `try/finally`, then close it.

- [ ] **Step 3: Inspect screenshot pixels and geometry**

For every screenshot, verify nonblank pixel variance, no clipped text, no overlap, no vertical scrollbar, the current-time Flag remains aligned, and the L3 wash covers both the main area and timeline with one phase.

- [ ] **Step 4: Commit the completed implementation**

```bash
git add web/src/styles.css e2e/flow.spec.ts e2e/responsive.spec.ts
git commit -m "feat: unify responsive clock and alert layout"
```

### Task 8: Deploy and prove the public version

**Files:**
- Verify: `wrangler.jsonc`, `web/dist/index.html`
- Public target: `https://clock.4c666.top`

- [ ] **Step 1: Check Cloudflare authentication**

```bash
npx wrangler whoami
```

Expected: authenticated account information. If the token is expired, stop deployment and ask the user to complete `npx wrangler login`; do not claim the public site is updated.

- [ ] **Step 2: Deploy the verified commit**

```bash
npx wrangler deploy
```

Record the Worker Version ID and deployment timestamp. Do not change DNS, D1 bindings or secrets.

- [ ] **Step 3: Compare local and public static asset fingerprints through the required proxy**

```bash
rg -o 'assets/index-[^" ]+' web/dist/index.html
HTTPS_PROXY=http://127.0.0.1:7897 curl -fsS https://clock.4c666.top/ | rg -o 'assets/index-[^" ]+'
```

Expected: CSS and JavaScript asset names match the local build.

- [ ] **Step 4: Verify public health**

```bash
HTTPS_PROXY=http://127.0.0.1:7897 curl -fsS https://clock.4c666.top/api/v1/health
```

Expected: HTTP 200 and the documented healthy JSON response.

- [ ] **Step 5: Verify the public UI in the user's authenticated Chrome**

Use the official Chrome extension route with a named task session. Confirm the public page has no `睡眠结束` or `睡眠` labels, an open running/paused segment does not extend to `22:30` in the seven-day lane, the full-screen overdue wash includes the timeline, and the page has no document scrollbar at the target landscape size. Close Agent-created tabs and finalize the browser session.

- [ ] **Step 6: Report actual online state**

Report the commit, Worker Version ID, public asset fingerprint comparison, health response, UI observations and any remaining authentication blocker. Public completion is forbidden until Steps 2-5 are evidenced.
