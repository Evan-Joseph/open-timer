/**
 * E2E：真实交互、独立时间差校验、时间轴、视口矩阵与截图证据。
 * 每次运行前清空数据目录，保证 setup 流程可重复。
 */

import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { shanghaiDayRangeUtc, shanghaiToday } from '@clock/shared';

const PASSWORD = '123456';

/** 从 timer aria-label（累计 HH:MM:SS，本段 MM:SS）解析累计秒数 */
async function timerTotalSeconds(page: Page): Promise<number> {
  const label = await page.getByTestId('timer-seconds').getAttribute('aria-label');
  expect(label).not.toBeNull();
  const m = label!.match(/累计 (\d{2}):(\d{2}):(\d{2})/);
  expect(m).not.toBeNull();
  return Number(m![1]) * 3600 + Number(m![2]) * 60 + Number(m![3]);
}

test.beforeAll(() => {
  rmSync('/tmp/clock-e2e-data', { recursive: true, force: true });
});

function beijingTodayAt(hour: number, minute = 0): Date {
  const { startMs } = shanghaiDayRangeUtc(shanghaiToday(Date.now()));
  return new Date(startMs + (hour * 60 + minute) * 60_000);
}

async function doSetup(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(300);
  // PIN 键盘：物理键盘输入 6 位数字（window keydown 监听）
  const enterPin = async () => {
    await page.keyboard.type(PASSWORD);
    await page.waitForTimeout(500); // 满 6 位后自动提交的延迟
  };
  const setupDots = page.locator('.pin-dots');
  // 只读监督态（已设置过密码、未登录）：点锁图标唤出解锁层
  if (!(await setupDots.isVisible().catch(() => false))) {
    await page.getByTestId('unlock-btn').click();
    await expect(setupDots).toBeVisible();
  }
  await enterPin();
  // setup 需要二次确认；login 一次即可。出现「再输入一次」说明是 setup 流程
  const confirmTitle = page.getByText('再输入一次以确认');
  if ((await confirmTitle.count()) > 0) {
    await enterPin();
  }
  // 清理上一个用例可能残留的活动会话，保证每个用例从空闲态开始
  const stopBtn = page.getByRole('button', { name: '结束并保存' });
  if ((await stopBtn.count()) > 0) {
    await stopBtn.click();
    // 结束反馈卡：先撤回本条（不污染用例数据），若已消失则点「好，继续」
    const withdrawBtn = page.getByTestId('finish-withdraw-btn');
    if ((await withdrawBtn.count()) > 0) {
      await withdrawBtn.click();
    } else {
      const continueBtn = page.getByRole('button', { name: '好，继续' });
      if ((await continueBtn.count()) > 0) await continueBtn.click();
    }
  }
  // 跨端结束卡水合（2026-08-25 新功能）：多条「未备注刚结束」可能排队水合，循环排空并填备注断污染
  for (let i = 0; i < 6; i++) {
    // 先等一拍让水合落地再检查，杜绝「drain 后才水合」的竞态
    await page.waitForTimeout(350);
    if ((await page.getByTestId('finish-duration').count()) === 0) break;
    await page.locator('.finish-note').fill('e2e 隔离清理');
    const contBtn = page.getByRole('button', { name: '好，继续' });
    if ((await contBtn.count()) > 0) await contBtn.click();
    await page.waitForTimeout(300);
  }
  // 测试隔离：偏好是服务端多端同步的，上一个用例的深色/视图模式会泄漏给后续用例。
  // 每个用例开始时重置为默认偏好（theme=auto 等）。
  await page.request.put('/api/v1/prefs', {
    data: { theme: 'auto', animations: true, finishSound: false, ambientKind: 'none', timelineScale: 'default', timelineMode: 'track', historyOpen: false, selectedSubject: 'math' },
  });
  await page.evaluate(() => {
    localStorage.setItem('clock-theme', 'auto');
    localStorage.setItem('clock-timeline-scale', 'default');
    localStorage.setItem('clock-timeline-mode', 'track');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await expect(page.getByTestId('idle-clock')).toBeVisible();
}

test.describe('核心流程', () => {
  test('时间轴左端保留刻度线但不重复显示起始具体时间', async ({ page }) => {
    await doSetup(page);
    const firstTick = page.locator('.timeline-track .tick').first();
    await expect(firstTick).toBeVisible();
    await expect(firstTick.locator('.tick-label')).toHaveCount(0);
  });

  test('setup → start → 独立时间差校验 → pause → resume → stop → 结束反馈', async ({ page }) => {
    await doSetup(page);

    // 选择科目并填目标
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByLabel('本次目标（可选）').fill('王道 1.1 基本概念');
    await page.getByTestId('start-btn').click();

    // 运行态
    await expect(page.getByTestId('timer-seconds')).toBeVisible();
    await expect(page.getByText('· 进行中')).toBeVisible();

    // 等 3 秒，做独立时间差校验：UI 累计秒 vs 服务端暂算秒数
    await page.waitForTimeout(3000);
    const uiSeconds = await timerTotalSeconds(page);
    const stateRes = await page.request.get('/api/v1/state');
    expect(stateRes.ok()).toBeTruthy();
    const stateBody = await stateRes.json();
    expect(stateBody.active_session).not.toBeNull();
    const serverSeconds = stateBody.active_session.active_seconds;
    expect(Math.abs(uiSeconds - serverSeconds)).toBeLessThanOrEqual(3);
    expect(uiSeconds).toBeGreaterThan(0);

    // 暂停
    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByText('· 离开中')).toBeVisible();
    const pausedUi = await page.getByTestId('timer-seconds').innerText();

    // 暂停期间数字冻结
    await page.waitForTimeout(1500);
    expect(await page.getByTestId('timer-seconds').innerText()).toBe(pausedUi);

    // 继续
    await page.getByRole('button', { name: '继续计时' }).click();
    await expect(page.getByText('· 进行中')).toBeVisible();

    // 结束
    await page.getByRole('button', { name: '结束并保存' }).click();
    await expect(page.getByTestId('finish-duration')).toBeVisible();
    await page.getByLabel('结束备注').fill('E2E 第一段');
    await page.getByRole('button', { name: '好，继续' }).click();

    // 回到空闲态
    await expect(page.getByTestId('idle-clock')).toBeVisible();

    // 时间轴出现片段
    await expect(page.locator('.seg').first()).toBeVisible();

    // API 独立确认：sessions 含该会话且 active_seconds > 0
    const sessRes = await page.request.get(`/api/v1/sessions?date=${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}`);
    const sessBody = await sessRes.json();
    expect(sessBody.sessions.length).toBeGreaterThan(0);
    const total = sessBody.sessions.reduce((a: number, x: { active_seconds: number }) => a + x.active_seconds, 0);
    expect(total).toBeGreaterThan(0);
  });

  test('结束备注保存失败时 Enter 保留结束卡与草稿', async ({ page }) => {
    await doSetup(page);
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1_100);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByLabel('结束备注').fill('不能丢失的草稿');
    await page.route('**/api/v1/sessions/*/note', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL' }) });
    });
    await page.getByLabel('结束备注').press('Enter');
    await expect(page.getByTestId('finish-duration')).toBeVisible();
    await expect(page.getByLabel('结束备注')).toHaveValue('不能丢失的草稿');
    await expect(page.getByText('备注保存失败，请重试')).toBeVisible();
    await page.unroute('**/api/v1/sessions/*/note');
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('时间轴片段悬停预览，点击后固定打开详情且热区足够大', async ({ page }) => {
    await doSetup(page);
    // 快速产生一个已停止会话
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();

    const seg = page.locator('.seg-hit').first();
    await expect(seg).toBeVisible();
    const box = await seg.boundingBox();
    expect(box).not.toBeNull();
    // 稀疏时热区 ≥24px（±12px 扩展）；密集相邻时按中点分割仍保证可点
    expect(box!.width).toBeGreaterThanOrEqual(3);

    await seg.hover();
    await expect(page.getByTestId('seg-preview')).toBeVisible();
    const previewAlignment = await page.evaluate(() => {
      const segRect = document.querySelector('.seg-hit')!.getBoundingClientRect();
      const previewRect = document.querySelector('.seg-preview')!.getBoundingClientRect();
      return Math.abs(segRect.left + segRect.width / 2 - (previewRect.left + previewRect.width / 2));
    });
    expect(previewAlignment).toBeLessThanOrEqual(16);
    await expect(page.getByRole('dialog', { name: '会话详情' })).toHaveCount(0);
    await seg.hover();
    await seg.click();
    await expect(page.getByRole('dialog', { name: '会话详情' })).toBeVisible();
    const popoverAlignment = await page.evaluate(() => {
      const segRect = document.querySelector('.seg-hit')!.getBoundingClientRect();
      const popoverRect = document.querySelector('.seg-popover')!.getBoundingClientRect();
      return Math.abs(segRect.left + segRect.width / 2 - (popoverRect.left + popoverRect.width / 2));
    });
    expect(popoverAlignment).toBeLessThanOrEqual(16);
    await expect(page.getByText('净时长')).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();
  });

  test('换科目结束当前段并开启新段', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '英语二' }).click();
    await page.getByTestId('start-btn').click();
    await expect(page.getByText('· 进行中')).toBeVisible();

    await page.getByText('切换到其他科目').click();
    await page.getByRole('button', { name: '数据结构' }).first().click();

    await expect(page.locator('.subject-pill.large', { hasText: '数据结构' })).toBeVisible();

    // 清理：结束
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('暂停后继续，同一会话的时间段保持在同一泳道', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '继续计时' }).click();
    await page.waitForTimeout(900);

    const lanes = await page.locator('.seg').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-lane')));
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lanes).size).toBe(1);

    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('刷新后恢复运行中会话（不丢不重）', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '操作系统' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(2000);

    const before = await timerTotalSeconds(page);
    await page.reload();

    await expect(page.getByTestId('timer-seconds')).toBeVisible();
    await expect(page.getByText('· 进行中')).toBeVisible();
    // 恢复后秒数与刷新前接近（±10s，含刷新耗时）
    const beforeSecs = before;
    await page.waitForTimeout(1000);
    const afterSecs = await timerTotalSeconds(page);
    expect(Math.abs(afterSecs - beforeSecs)).toBeLessThanOrEqual(10);

    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('计时数字无布局跳动：秒变化时容器尺寸稳定', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '计算机网络' }).click();
    await page.getByTestId('start-btn').click();
    const timer = page.getByTestId('timer-seconds');
    await expect(timer).toBeVisible();
    const box1 = await timer.boundingBox();
    await page.waitForTimeout(2200);
    const box2 = await timer.boundingBox();
    expect(box1).not.toBeNull();
    expect(box2).not.toBeNull();
    expect(box1!.width).toBe(box2!.width); // tabular numerals：宽度不变
    expect(box1!.height).toBe(box2!.height);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });
});

test.describe('多标签页同步', () => {
  test('写操作在轮询周期前同步到其他标签页', async ({ page, context }) => {
    await doSetup(page);
    const peer = await context.newPage();
    await peer.goto('/');
    await expect(peer.getByTestId('idle-clock')).toBeVisible();

    const startedAt = Date.now();
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await expect(peer.getByText('· 进行中')).toBeVisible({ timeout: 3_000 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(peer.getByText('· 离开中')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('button', { name: '继续计时' }).click();
    await expect(peer.getByText('· 进行中')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('button', { name: '结束并保存' }).click();
    // 2026-08-25 新功能：他端对「刚结束未备注」会话水合结束卡（跨端可补备注）
    await expect(peer.getByTestId('finish-duration')).toBeVisible({ timeout: 3_000 });
    await page.getByTestId('finish-withdraw-btn').click();
    // 撤回后会话作废；B 端关闭结束卡回空闲
    const contB = peer.getByRole('button', { name: '好，继续' });
    if ((await contB.count()) > 0) await contB.click();
    await expect(peer.getByTestId('idle-clock')).toBeVisible({ timeout: 3_000 });
    await peer.close();
  });
});

test.describe('截图矩阵与视觉', () => {
  test('空闲态与运行态截图（浅色）', async ({ page }) => {
    await doSetup(page);
    await page.screenshot({ path: 'e2e/screens/idle-light.png', fullPage: true });

    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e/screens/running-light.png', fullPage: true });

    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/screens/paused-light.png', fullPage: true });

    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('深色模式运行态', async ({ page }) => {
    await doSetup(page);
    // 打开设置切深色
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html[data-theme="dark"]')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('radio', { name: '思想政治理论' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e/screens/running-dark.png', fullPage: true });
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('深色模式截图矩阵（空闲/运行/暂停/结束反馈）', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html[data-theme="dark"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/screens/idle-dark.png', fullPage: true });

    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e/screens/running-dark-matrix.png', fullPage: true });

    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/screens/paused-dark.png', fullPage: true });

    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/screens/finish-dark.png', fullPage: true });
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('reduced-motion：动画归零但布局与告警色保留（含截图）', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await doSetup(page);
    // 系统 prefers-reduced-motion 时应用自动挂 animations-off
    await expect(page.locator('html.animations-off')).toHaveCount(1);
    await page.screenshot({ path: 'e2e/screens/idle-reduced-motion.png', fullPage: true });

    // Motion 浮层也必须同步归零，不能只关 CSS animation 后仍播放 250ms Motion 进入动画。
    await page.getByTestId('history-toggle').click();
    await expect(page.getByTestId('history-strip')).toBeVisible();
    const historyMotion = await page.getByTestId('history-strip').evaluate((el) =>
      el.getAnimations().map((animation) => Number(animation.effect?.getTiming().duration ?? 0)),
    );
    expect(historyMotion.every((duration) => duration <= 0)).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByTestId('conch-toggle').click();
    await expect(page.getByTestId('conch-panel')).toBeVisible();
    const conchMotion = await page.getByTestId('conch-panel').evaluate((el) =>
      el.getAnimations().map((animation) => Number(animation.effect?.getTiming().duration ?? 0)),
    );
    expect(conchMotion.every((duration) => duration <= 0)).toBe(true);
    await page.keyboard.press('Escape');

    await page.getByRole('radio', { name: '操作系统' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'e2e/screens/running-reduced-motion.png', fullPage: true });

    // 全部 transition/animation 时长归零（0.01ms 兜底写法 → ≤0.001s）
    const maxDuration = await page.evaluate(() => {
      const els = document.querySelectorAll('.start-btn, .control-btn, .idle-clock, .topbar, .timeline-track, .subject-chip');
      let max = 0;
      for (const el of els) {
        const s = getComputedStyle(el);
        for (const part of `${s.transitionDuration},${s.animationDuration}`.split(',')) {
          const sec = part.endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part);
          if (Number.isFinite(sec)) max = Math.max(max, sec);
        }
      }
      return max;
    });
    expect(maxDuration).toBeLessThanOrEqual(0.001);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
    await context.close();
  });

  test('DOM 非空与关键区域无重叠', async ({ page }) => {
    await doSetup(page);
    // DOM 非空
    const bodyChildren = await page.evaluate(() => document.querySelector('#root')!.childElementCount);
    expect(bodyChildren).toBeGreaterThan(0);

    await page.getByRole('radio', { name: '计算机组成原理' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(800);

    // 关键控件不重叠：计时数字与控制按钮行
    const timerBox = await page.getByTestId('timer-seconds').boundingBox();
    const controls = page.locator('.control-row');
    const controlBox = await controls.boundingBox();
    expect(timerBox).not.toBeNull();
    expect(controlBox).not.toBeNull();
    const overlapY = Math.min(timerBox!.y + timerBox!.height, controlBox!.y + controlBox!.height) - Math.max(timerBox!.y, controlBox!.y);
    expect(overlapY).toBeLessThanOrEqual(0);

    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });
});

test.describe('时间轴信标与定位', () => {
  test('默认尺度将当前时间置于约 60%，用户浏览后仅点击「现在」才归位', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(800);

    // 信标存在
    await expect(page.getByTestId('now-line')).toBeVisible();

    const scroll = page.getByTestId('timeline-scroll');
    await expect(scroll).toBeVisible();

    await page.getByRole('radio', { name: '全天', exact: true }).click();
    await page.waitForTimeout(1100);
    await expect(page.getByRole('radio', { name: '全天', exact: true })).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('scroll-now-btn').click();
    await expect(page.getByRole('radio', { name: '默认' })).toHaveAttribute('aria-checked', 'true');
    await expect(scroll).toBeVisible();

    // 清理
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('空日时间轴仍显示刻度与空提示', async ({ page }) => {
    await doSetup(page);
    // 翻到 30 天内的历史空日
    await page.getByRole('button', { name: '前一天' }).click();
    await expect(page.getByText('这一天还没有记录')).toBeVisible();
    // 刻度标签仍存在（时间感保留）
    await expect(page.locator('.tick-label').first()).toBeVisible();
  });
});

test.describe('时间轴空态与窗口', () => {
  test('当天有记录但都在默认窗口外：不误报空日，显示窗口外提示', async ({ page }) => {
    await page.clock.install({ time: beijingTodayAt(10) });
    await doSetup(page);
    const today = shanghaiToday(Date.now());
    const { startMs } = shanghaiDayRangeUtc(today);
    const at = (h: number) => new Date(startMs + h * 3_600_000).toISOString();

    // 模拟：记录在清晨 06–07 点；state 的 server_now_ms 为 20:00。
    // 默认尺度窗口锚定当前时刻（20:00），不含清晨片段 → 不得误报「这一天还没有记录」。
    const realSnapshot = await (await page.request.get('/api/v1/snapshot')).json();
    await page.route('**/api/v1/snapshot', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...realSnapshot,
          state: { ...realSnapshot.state, server_now_ms: startMs + 20 * 3_600_000, server_now_iso: at(20), active_session: null },
          sessions: [
            {
              session_id: 'TESTSESS',
              subject_id: 'math',
              started_at: at(6),
              ended_at: at(7),
              active_seconds: 3600,
              status: 'stopped',
              end_reason: 'manual',
              note: null,
              end_note: null,
              session_active_seconds: 3600,
              longest_continuous_seconds: 3600,
              last_continuous_seconds: 3600,
              last_continuous_ended_at: at(7),
              segments: [{ started_at: at(6), ended_at: at(7) }],
            },
          ],
        }),
      }),
    );

    await page.reload();
    await page.waitForTimeout(500);
    // 不误报空日
    await expect(page.getByTestId('timeline-empty')).toHaveCount(0);
    // 窗口外提示（记录在窗口之外）
    await expect(page.locator('.timeline-empty-window')).toBeVisible();
    // 片段不在当前窗口内，未渲染
    await expect(page.locator('.seg')).toHaveCount(0);

    // 切到全天尺度：清晨片段落在 08:00–22:30 之外（06–07 点），仍不得误报空日
    await page.getByRole('radio', { name: '全天' }).click();
    await expect(page.getByTestId('timeline-empty')).toHaveCount(0);
    await expect(page.locator('.timeline-empty-window')).toBeVisible();
  });

  test('真正无记录的一天显示空日文案', async ({ page }) => {
    await page.clock.install({ time: beijingTodayAt(10) });
    await doSetup(page);
    const realSnapshot = await (await page.request.get('/api/v1/snapshot')).json();
    await page.route('**/api/v1/snapshot', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...realSnapshot, sessions: [] }),
      }),
    );
    await page.reload();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('timeline-empty')).toBeVisible();
    await expect(page.getByTestId('timeline-empty')).toContainText('这一天还没有记录');
    await expect(page.locator('.timeline-empty-window')).toHaveCount(0);
  });
});

test.describe('近 7 天执行回顾', () => {
  test('以固定全天泳道展示七天记录，并隐藏单日时间轴', async ({ page }) => {
    await doSetup(page);
    const state = await (await page.request.get('/api/v1/state')).json();
    const subjects = await (await page.request.get('/api/v1/subjects')).json();
    const shift = (date: string, delta: number) => {
      const [year, month, day] = date.split('-').map(Number);
      const shifted = new Date(Date.UTC(year, month - 1, day + delta));
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
    };
    let todaySessionCount = 1;
    let todayHasUnfinished = false;
    let todayOpenStatus: 'running' | 'paused' = 'running';
    const from = shift(state.today_date, -6);
    const dates = Array.from({ length: 7 }, (_, index) => shift(from, index));
    // 今日第二段从 02:00Z 开始；汇总截至 03:00Z，精确包含 1 小时未结束段。
    const generatedAt = `${state.today_date}T03:00:00.000Z`;
    const rangeSummary = () => ({
      from,
      to: state.today_date,
      timezone: 'Asia/Shanghai',
      generated_at: generatedAt,
      revision: 999,
      total_active_seconds: 28_800,
      by_subject: [
        { subject_id: subjects[0].subject_id, display_name: subjects[0].display_name, active_seconds: 19_200 },
        { subject_id: subjects[1].subject_id, display_name: subjects[1].display_name, active_seconds: 9_600 },
      ],
      aggregates: [],
      active_dates: dates,
      // 面板只查近 7 天窗口；今日 7200、过去 6 日各 3600，用于区分日均口径：
      // 日均 = 6×3600/6 = 3600「1 小时 0 分」。
      days: dates.map((date) => {
        const total = date === state.today_date ? 7200 : 3600;
        return {
          date,
          total_active_seconds: total,
          by_subject: [
            { subject_id: subjects[0].subject_id, display_name: subjects[0].display_name, active_seconds: total * 2 / 3, session_count: 1 },
            { subject_id: subjects[1].subject_id, display_name: subjects[1].display_name, active_seconds: total / 3, session_count: 1 },
          ],
          aggregates: [],
          session_count: date === state.today_date ? todaySessionCount : 1,
        };
      }),
    });
    await page.route('**/api/v1/daily-summaries?**', async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('from')).toBe(from);
      expect(url.searchParams.get('to')).toBe(state.today_date);
      expect(url.searchParams.get('timezone')).toBe('Asia/Shanghai');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rangeSummary()),
      });
    });

    await page.route('**/api/v1/sessions?**', async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('from')).toBe(from);
      expect(url.searchParams.get('to')).toBe(state.today_date);
      const sessions = dates.flatMap((date) => {
        const sessionCount = date === state.today_date ? todaySessionCount : 1;
        const startedAt = `${date}T01:00:00.000Z`;
        const endedAt = `${date}T02:00:00.000Z`;
        return Array.from({ length: sessionCount }, (_, index) => {
          const unfinished = date === state.today_date && index === 1 && todayHasUnfinished;
          const segmentStartedAt = new Date(Date.parse(startedAt) + index * 3_600_000).toISOString();
          const segmentEndedAt = unfinished ? null : new Date(Date.parse(endedAt) + index * 3_600_000).toISOString();
          return {
            session_id: `history-${date}-${index}`,
            subject_id: subjects[0].subject_id,
            started_at: segmentStartedAt,
            ended_at: segmentEndedAt,
            active_seconds: 3600,
            window_active_seconds: 3600,
            session_active_seconds: 3600,
            longest_continuous_seconds: 3600,
            last_continuous_seconds: 3600,
            last_continuous_ended_at: segmentEndedAt,
            status: unfinished ? todayOpenStatus : 'stopped',
            end_reason: unfinished ? null : 'manual',
            note: null,
            intent_note: null,
            end_note: null,
            segments: [{ started_at: segmentStartedAt, ended_at: segmentEndedAt }],
          };
        });
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          from,
          to: state.today_date,
          timezone: 'Asia/Shanghai',
          generated_at: generatedAt,
          revision: 999,
          count: sessions.length,
          sessions,
          adjustments_or_revocations: [],
        }),
      });
    });

    await expect(page.getByText('睡眠结束', { exact: true })).toHaveCount(0);
    await expect(page.getByText('睡眠', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByTestId('history-toggle').click();
    const report = page.getByTestId('history-strip');
    await expect(report).toBeVisible();
    await expect(report.locator('.history-metrics')).toContainText('8 小时');
    await expect(report.locator('.history-metrics')).toContainText('日均');
    // 日均剔除进行中的今日：6×3600/6 = 3600s =「1 小时 0 分」（若纳入今日则为「1 小时 8 分」）
    await expect(report.locator('.history-metrics > div').nth(1)).toContainText('1 小时 0 分');
    await expect(report.locator('.history-metrics')).toContainText('最长一天');
    await expect(report).not.toContainText('仅记录时间事实');
    await expect(report).not.toContainText('较前 7 天');
    await expect(report).not.toContainText('活跃天数');
    await expect(report.locator('.history-lane')).toHaveCount(7);
    await expect(report.locator('.history-lane-segment')).toHaveCount(7);
    await expect(report.locator('.history-now-line')).toHaveCount(1);
    await expect(report.locator('.history-quiet-period')).toHaveCount(21);
    await expect(report.locator('.history-lane').first()).toContainText('午饭');
    await expect(report.locator('.history-lane').first()).toContainText('午睡');
    await expect(report.locator('.history-lane').first()).toContainText('晚饭');
    await expect(report.getByText('08:00', { exact: true })).toBeVisible();
    await expect(report.getByText('22:30', { exact: true })).toBeVisible();
    await expect(report.getByText('睡眠结束', { exact: true })).toHaveCount(0);
    await expect(report.getByText('睡眠', { exact: true })).toHaveCount(0);
    await expect(report.locator('.history-subject-list > span')).toHaveCount(2);
    await expect(report.locator('.history-subject-list')).toContainText('67%');
    await expect(report.getByRole('button', { name: /2026-/ })).toHaveCount(0);
    await expect(page.getByTestId('timeline-scroll')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '前一天' })).toHaveCount(0);
    await expect(page.getByTestId('scroll-now-btn')).toHaveCount(0);
    await expect(page.getByTestId('now-line')).toHaveCount(0);
    await page.waitForFunction(() => (
      window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4
    ));

    await page.keyboard.press('Escape');
    await expect(report).toHaveCount(0);
    todaySessionCount = 2;
    todayHasUnfinished = true;
    await page.getByTestId('history-toggle').click();
    await expect(report.locator('.history-lane').last().locator('.history-lane-segment')).toHaveCount(1);
    await expect(report.locator('.history-lane-segment')).toHaveCount(7);
    // 未结束的最后一段不应让汇总比泳道多 1 小时：6×1h + 今天已结束的 1h = 7h。
    await expect(report.locator('.history-metrics')).toContainText('7 小时');

    await page.keyboard.press('Escape');
    await expect(report).toHaveCount(0);
    todayOpenStatus = 'paused';
    await page.getByTestId('history-toggle').click();
    await expect(report.locator('.history-lane').last().locator('.history-lane-segment')).toHaveCount(1);
    await expect(report.locator('.history-lane-segment')).toHaveCount(7);

    await page.keyboard.press('Escape');
    await expect(report).toHaveCount(0);
    todayHasUnfinished = false;
    await page.getByTestId('history-toggle').click();
    await expect(report.locator('.history-lane').last().locator('.history-lane-segment')).toHaveCount(2);
    await expect(report.locator('.history-lane-segment')).toHaveCount(8);
    await expect(report.locator('.history-metrics')).toContainText('8 小时');
  });

  test('范围读取失败不把近 7 天伪造成零记录', async ({ page }) => {
    await doSetup(page);
    await page.route('**/api/v1/daily-summaries?**', (route) => route.abort('failed'));
    await page.route('**/api/v1/sessions?**', (route) => route.abort('failed'));
    await page.getByTestId('history-toggle').click();
    const report = page.getByTestId('history-strip');
    await expect(report).toContainText('暂时无法读取近 7 天数据');
    await expect(report.locator('.history-metrics')).toHaveCount(0);
  });

  test('本地恢复已打开的回顾时自动读取范围数据', async ({ page }) => {
    await doSetup(page);
    let dailyRanges = 0;
    let sessionRanges = 0;
    await page.route('**/api/v1/daily-summaries?**', async (route) => {
      dailyRanges += 1;
      await route.continue();
    });
    await page.route('**/api/v1/sessions?**', async (route) => {
      sessionRanges += 1;
      await route.continue();
    });
    await page.evaluate(() => localStorage.setItem('clock-history-open', '1'));
    await page.reload();
    await expect(page.getByTestId('history-strip')).toBeVisible();
    await expect.poll(() => dailyRanges).toBeGreaterThan(0);
    await expect.poll(() => sessionRanges).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    expect(dailyRanges).toBe(1);
    expect(sessionRanges).toBe(1);
    const zeroDataLayout = await page.getByTestId('history-strip').evaluate((panel) => {
      const metrics = panel.querySelector('.history-metrics')!.getBoundingClientRect();
      const lanes = panel.querySelector('.history-lanes')!.getBoundingClientRect();
      return { metricsBottom: metrics.bottom, lanesTop: lanes.top };
    });
    expect(zeroDataLayout.lanesTop).toBeGreaterThanOrEqual(zeroDataLayout.metricsBottom);
  });
});

test.describe('选科状态归属', () => {
  test('手动选择的科目不被轮询抢回，刷新后记住', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '计算机网络' }).click();
    await expect(page.getByRole('radio', { name: '计算机网络' })).toHaveAttribute('aria-checked', 'true');
    // 等待覆盖多次状态更新时机，确认不被抢
    await page.waitForTimeout(2500);
    await expect(page.getByRole('radio', { name: '计算机网络' })).toHaveAttribute('aria-checked', 'true');
    // 刷新后记住最近选择
    await page.reload();
    await expect(page.getByRole('radio', { name: '计算机网络' })).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('撤回（作废）与一致性', () => {
  test('结束反馈处撤回：时间轴与累计同步移除', async ({ page }) => {
    await doSetup(page);
    // 记录基线（其他用例可能留有片段/时长）
    const beforeSegs = await page.locator('.seg').count();
    const beforeRestLines = await page.getByTestId('idle-rest-line').count();
    const beforeState = await (await page.request.get('/api/v1/state')).json();
    const beforeSeconds = beforeState.today_active_seconds as number;

    await page.getByRole('radio', { name: '操作系统' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await expect(page.getByTestId('finish-duration')).toBeVisible();

    // 撤回
    await page.getByTestId('finish-withdraw-btn').click();
    await expect(page.getByTestId('toast')).toContainText('已撤回');

    // 一致性：回到空闲态；片段数与累计时长回到基线（本次会话被完整排除）
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    await expect(page.getByTestId('idle-rest-line')).toHaveCount(beforeRestLines);
    await expect(page.locator('.seg')).toHaveCount(beforeSegs);
    const afterState = await (await page.request.get('/api/v1/state')).json();
    expect(afterState.today_active_seconds).toBe(beforeSeconds);
  });

  test('时间轴 popover 处撤回历史片段', async ({ page }) => {
    await doSetup(page);
    const beforeSegs = await page.locator('.seg').count();
    // 产生一个已停止会话
    await page.getByRole('radio', { name: '思想政治理论' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
    await expect(page.locator('.seg')).toHaveCount(beforeSegs + 1);
    // 等待 sessions 状态更新为 stopped（withdraw 按钮仅在 stopped 片段渲染）
    await page.waitForTimeout(1200);

    // 点最后一个片段 → popover → 撤回
    await page.locator('.seg-hit').last().click();
    await expect(page.getByTestId('seg-popover')).toBeVisible();
    await page.getByTestId('withdraw-btn').click();
    await expect(page.getByTestId('toast')).toContainText('已撤回');
    await expect(page.locator('.seg')).toHaveCount(beforeSegs);
  });
});

test.describe('误触继续（stopped 会话可重开）', () => {
  test('结束反馈卡一键继续：恢复运行态且秒数保留', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);

    // 误触场景：想点暂停却点成了结束
    await page.getByRole('button', { name: '结束并保存' }).click();
    await expect(page.getByTestId('finish-duration')).toBeVisible();

    await page.getByTestId('finish-resume-btn').click();
    await expect(page.getByTestId('toast')).toContainText('已继续这段会话');

    // 恢复运行态：同一会话继续计时（暂停按钮回来、进行中状态）
    await expect(page.getByText('· 进行中')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: '暂停计时' })).toBeVisible();
    const state = await (await page.request.get('/api/v1/state')).json();
    expect(state.active_session).not.toBeNull();
    expect(state.active_session.status).toBe('running');
    // 误触前已计的秒数保留（≥1s）
    expect(state.active_session.active_seconds).toBeGreaterThanOrEqual(1);

    // 清理：真正结束
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
    await expect(page.getByTestId('idle-clock')).toBeVisible();
  });

  test('时间轴详情处继续：点错结束、关掉反馈卡后仍可恢复', async ({ page }) => {
    await doSetup(page);
    const beforeSegs = await page.locator('.seg').count();
    await page.getByRole('radio', { name: '英语二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    // 关掉结束反馈卡（误以为没有补救入口）
    await page.getByRole('button', { name: '好，继续' }).click();
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    await page.waitForTimeout(1200); // 等 sessions 更新为 stopped

    // 时间轴详情里仍可继续这段
    await page.locator('.seg-hit').last().click();
    await expect(page.getByTestId('seg-popover')).toBeVisible();
    await page.getByTestId('popover-resume').click();
    await expect(page.getByText('· 进行中')).toBeVisible({ timeout: 3_000 });

    // 清理
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByTestId('finish-withdraw-btn').click();
    await expect(page.locator('.seg')).toHaveCount(beforeSegs);
  });
});

test.describe('多端偏好同步', () => {
  // 用独立 browser context 模拟「另一台真实设备」：隔离 localStorage 与 cookie。
  // 同 context 标签页共享 localStorage，会掩盖服务端同步路径，不能验证跨设备语义。
  async function freshDevice(browser: any) {
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageB = await ctxB.newPage();
    await pageB.goto('/');
    await pageB.waitForTimeout(400);
    // 登录态不共享：输入 PIN 登录（服务端已 setup；未登录默认进只读监督态，需先点锁解锁）
    if (await pageB.locator('.pin-dots').count()) {
      await pageB.keyboard.type(PASSWORD);
      await pageB.waitForTimeout(700);
    } else if (await pageB.getByTestId('unlock-btn').count()) {
      await pageB.getByTestId('unlock-btn').click();
      await pageB.waitForTimeout(300);
      await pageB.keyboard.type(PASSWORD);
      await pageB.waitForTimeout(700);
    }
    return { ctxB, pageB };
  }

  test('跨设备：一端切深色，另一端登录后经服务端同步应用', async ({ page, browser }) => {
    await doSetup(page);
    // 端 A 切深色（本地立即生效 + 500ms 防抖推送服务端）
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html[data-theme="dark"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200); // 等推送落地

    // 端 B（独立设备）：登录后首轮偏好拉取即应用深色
    const { ctxB, pageB } = await freshDevice(browser);
    await expect(pageB.locator('html[data-theme="dark"]')).toBeVisible({ timeout: 15_000 });
    await ctxB.close();

    // 复位：端 A 切回跟随系统，避免污染后续用例
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('radio', { name: '跟随系统' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.request.put('/api/v1/prefs', {
      data: { theme: 'auto', animations: true, finishSound: false, ambientKind: 'none', timelineScale: 'default', timelineMode: 'track', historyOpen: false, selectedSubject: 'math' },
    });
  });

  test('跨设备：一端选科目，另一端登录后经服务端同步跟随', async ({ page, browser }) => {
    await doSetup(page);
    // 端 A 选「计算机组成原理」并推送
    await page.getByRole('radio', { name: '计算机组成原理' }).click();
    await page.waitForTimeout(1200); // 等防抖推送落地

    // 端 B（独立设备）：登录后选中项应为计算机组成原理
    const { ctxB, pageB } = await freshDevice(browser);
    await expect(pageB.locator('.subject-chip.selected')).toContainText('计算机组成原理', { timeout: 15_000 });
    await ctxB.close();

    // 复位
    await page.request.put('/api/v1/prefs', {
      data: { theme: 'auto', animations: true, finishSound: false, ambientKind: 'none', timelineScale: 'default', timelineMode: 'track', historyOpen: false, selectedSubject: 'math' },
    });
  });

  test('跨设备：浮层开合态为设备本地——一端打开近 7 天回顾，另一端不跟随（2026-08-24 同步下线）', async ({ page, browser }) => {
    await doSetup(page);
    await page.getByTestId('history-toggle').click();
    await expect(page.getByTestId('history-strip')).toBeVisible();
    await page.waitForTimeout(1200); // 即便偏好推送落地，开合态也不再同步

    // 端 B（独立设备）：登录后 7 天面板应保持关闭（开合态设备本地，避免多端重复发请求）
    const { ctxB, pageB } = await freshDevice(browser);
    await pageB.waitForTimeout(2000);
    await expect(pageB.getByTestId('history-strip')).toHaveCount(0);
    await ctxB.close();

    // 复位：Esc 关闭面板（仅本端生效）
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-strip')).toHaveCount(0);
  });

  test('跨设备：一端结束会话未填备注，另一端结束卡可补填（5 分钟窗口）', async ({ page, browser }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForSelector('.control-btn.pause', { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.locator('.control-btn.stop').click();
    await page.getByTestId('finish-duration').waitFor();
    // 端 A 不填备注直接确认
    await page.getByRole('button', { name: '好，继续' }).click();

    // 端 B（独立设备）：轮询到「刚结束且无结束备注」→ 呈现结束卡可补填
    const { ctxB, pageB } = await freshDevice(browser);
    await pageB.getByTestId('finish-duration').waitFor({ timeout: 30_000 });
    await pageB.locator('.finish-note').fill('跨端补的备注');
    await pageB.getByRole('button', { name: '好，继续' }).click();
    await pageB.waitForTimeout(800);

    // 端 A 正在等备注的结束卡应在快轮询确认 end_note 后自动收回主页（≤5s）
    await expect(page.getByTestId('finish-duration')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('idle-clock')).toBeVisible({ timeout: 5_000 });

    // 备注落库：sessions API 可见 end_note
    const today = (await pageB.locator('.topbar-date').textContent())!.slice(0, 10);
    const res = await pageB.request.get(`/api/v1/sessions?date=${today}`);
    const body = await res.json();
    const noted = body.sessions.find((s: any) => s.end_note === '跨端补的备注');
    expect(noted).toBeTruthy();
    await ctxB.close();
  });

  test('跨设备结束反馈：两端展示同一会话总专注与最长连续专注', async ({ page, browser }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForSelector('.control-btn.pause', { timeout: 10_000 });
    await page.waitForTimeout(6_000);
    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: '继续计时' }).click();
    await page.waitForTimeout(6_000);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByTestId('finish-duration').waitFor();
    await page.waitForTimeout(900); // 等服务端全量指标与数字滚动落定

    const localMetrics = {
      total: await page.getByTestId('finish-duration').textContent(),
      longest: await page.getByTestId('finish-longest-continuous').textContent(),
    };
    await page.getByRole('button', { name: '好，继续' }).click();

    const { ctxB, pageB } = await freshDevice(browser);
    await pageB.getByTestId('finish-duration').waitFor({ timeout: 30_000 });
    await expect(pageB.getByTestId('finish-duration')).toHaveText(localMetrics.total ?? '');
    await expect(pageB.getByTestId('finish-longest-continuous')).toHaveText(localMetrics.longest ?? '');
    await pageB.locator('.finish-note').fill('跨端指标确认');
    await pageB.getByRole('button', { name: '好，继续' }).click();
    await ctxB.close();
  });

  test('海螺计划只写入开始意图；结束卡 Enter 仅保存用户填写的实际记录', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    const state = await (await page.request.get('/api/v1/state')).json();
    const plan = '做第 5 章定积分的冲刺题';
    await page.route('**/api/v1/conch/ask', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: 'all', generated_at: new Date().toISOString(), cache_valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          revision: state.revision, conch_revision: state.conch_revision, model: 'e2e-stub', skipped: [],
          subjects: [{ subject_id: 'math', display_name: '数学二', color_id: 'copper', last_active_date: state.today_date, running_now: false, action_kind: 'problems', next_action: plan, rationale: null, pattern: null, alternatives: [], confidence: 'high' }],
        }),
      });
    });

    await page.getByTestId('conch-toggle').click();
    await page.getByRole('button', { name: '开始这个科目' }).click();
    await expect(page.getByTestId('timer-seconds')).toBeVisible();
    const active = await (await page.request.get('/api/v1/state')).json();
    expect(active.active_session.intent_note).toBe(plan);

    await page.getByRole('button', { name: '结束并保存' }).click();
    await expect(page.getByLabel('结束备注')).toHaveValue('');
    await expect(page.getByText(`开始时计划：${plan}`)).toBeVisible();
    await page.getByLabel('结束备注').fill('实际做了两道题，第三题待订正');
    await page.getByLabel('结束备注').press('Enter');
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    const sessions = await (await page.request.get(`/api/v1/sessions?date=${state.today_date}`)).json();
    expect(sessions.sessions.some((s: { intent_note: string | null; end_note: string | null }) => s.intent_note === plan && s.end_note === '实际做了两道题，第三题待订正')).toBe(true);
  });

  test('神奇海螺缓存只随已完成时间线变化：开始/暂停/继续不重新问，完成后才重新问', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    const initialState = await (await page.request.get('/api/v1/state')).json();

    let askCount = 0;
    await page.route('**/api/v1/conch/ask', async (route) => {
      askCount += 1;
      const stateRes = await page.request.get('/api/v1/state');
      const state = await stateRes.json();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: 'all',
          generated_at: new Date().toISOString(),
          cache_valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          revision: state.revision,
          conch_revision: state.conch_revision,
          model: 'e2e-stub',
          subjects: [],
          skipped: [],
        }),
      });
    });

    // 首问：请求一次并落本地语义缓存
    await page.getByTestId('conch-toggle').click();
    await page.locator('.conch-empty').waitFor();
    expect(askCount).toBe(1);
    await page.keyboard.press('Escape');

    // 进行中状态变化不会改变完成时间线，不应再次问模型
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForSelector('.control-btn.pause', { timeout: 10_000 });
    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.getByRole('button', { name: '继续计时' }).click();
    await page.getByTestId('conch-toggle').click();
    await page.locator('.conch-empty').waitFor();
    expect(askCount).toBe(1);
    await page.keyboard.press('Escape');

    // 完成一段专注会推进 conch_revision，下一次打开才重新问
    await page.waitForTimeout(1_100);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
    await page.waitForTimeout(500);
    const completedState = await (await page.request.get('/api/v1/state')).json();
    expect(completedState.conch_revision).toBeGreaterThan(initialState.conch_revision);
    await page.getByTestId('conch-toggle').click();
    await page.locator('.conch-empty').waitFor();
    expect(askCount).toBe(2);
  });

  test('神奇海螺本机缓存越过 cache_valid_until 后不展示旧建议', async ({ page }) => {
    await doSetup(page);
    const state = await (await page.request.get('/api/v1/state')).json();
    await page.evaluate(({ conchRevision }) => {
      localStorage.setItem('clock-conch-cache-v5', JSON.stringify({
        all: {
          ts: Date.now() - 60_000,
          data: {
            window: 'all',
            generated_at: new Date(Date.now() - 60_000).toISOString(),
            cache_valid_until: new Date(Date.now() - 1).toISOString(),
            conch_revision: conchRevision,
            revision: 1,
            model: 'e2e-stub',
            subjects: [],
            skipped: [],
          },
        },
      }));
    }, { conchRevision: state.conch_revision });

    let askCount = 0;
    await page.route('**/api/v1/conch/ask', async (route) => {
      askCount += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: 'all',
          generated_at: new Date().toISOString(),
          cache_valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          conch_revision: state.conch_revision,
          revision: state.revision,
          model: 'e2e-stub',
          subjects: [],
          skipped: [],
        }),
      });
    });

    await page.getByTestId('conch-toggle').click();
    await expect(page.locator('.conch-empty')).toBeVisible();
    expect(askCount).toBe(1);
    await expect(page.getByText(/缓存/)).toHaveCount(0);
  });

  test('神奇海螺发现另一处正在生成时自动等待并读取共享结果', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    let askCount = 0;
    await page.route('**/api/v1/conch/ask', async (route) => {
      askCount += 1;
      if (askCount === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'CONCH_GENERATING', retry_after_ms: 250 }),
        });
        return;
      }
      const state = await (await page.request.get('/api/v1/state')).json();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: 'all', generated_at: new Date().toISOString(), cache_valid_until: new Date(Date.now() + 86_400_000).toISOString(), revision: state.revision,
          conch_revision: state.conch_revision, model: 'e2e-stub', subjects: [], skipped: [],
        }),
      });
    });

    await page.getByTestId('conch-toggle').click();
    await expect(page.locator('.conch-empty')).toBeVisible({ timeout: 5_000 });
    expect(askCount).toBe(2);
    await expect(page.getByText('海螺正在另一处整理同一批记录，稍后会自动显示。')).toHaveCount(0);
  });

  test('退出 owner 态会清除设备本地海螺建议缓存', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.setItem('clock-conch-cache-v5', '{"all":{"ts":1,"data":{}}}'));
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByTestId('unlock-btn')).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('clock-conch-cache-v5'))).toBeNull();
  });

  test('神奇海螺遇到真实 fetch 失败时显示可重试的网络错误', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    await page.route('**/api/v1/conch/ask', (route) => route.abort('failed'));

    await page.getByTestId('conch-toggle').click();
    await expect(page.getByText('海螺没听见（网络错误），再问一次？')).toBeVisible();
    await expect(page.getByRole('button', { name: '再问一次' })).toBeVisible();
    await expect(page.getByText(/诊断编号：conch-/)).toBeVisible();
  });

  test('Safari 缺少 crypto.randomUUID 时海螺仍能发起无幂等推荐请求', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => {
      localStorage.removeItem('clock-conch-cache-v5');
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    });
    let receivedHeaders: Record<string, string> | null = null;
    await page.route('**/api/v1/conch/ask', async (route) => {
      receivedHeaders = route.request().headers();
      const state = await (await page.request.get('/api/v1/state')).json();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: 'all', generated_at: new Date().toISOString(), cache_valid_until: new Date(Date.now() + 86_400_000).toISOString(), revision: state.revision,
          conch_revision: state.conch_revision, model: 'e2e-stub', subjects: [], skipped: [],
        }),
      });
    });
    await page.getByTestId('conch-toggle').click();
    await expect(page.locator('.conch-empty')).toBeVisible();
    expect(receivedHeaders?.['x-client-request-id']).toMatch(/^conch-/);
    expect(receivedHeaders?.['idempotency-key']).toBeUndefined();
  });

  test('Safari 缺少 BroadcastChannel 与 crypto.randomUUID 时，计时写入后仍能同步', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined });
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    });
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await expect(page.getByRole('button', { name: '暂停计时' })).toBeVisible();
    const state = await (await page.request.get('/api/v1/state')).json();
    expect(state.active_session?.status).toBe('running');
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('神奇海螺区分 Worker 500 与浏览器网络拒绝', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    await page.route('**/api/v1/conch/ask', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL' }) });
    });
    await page.getByTestId('conch-toggle').click();
    await expect(page.getByText('海螺服务暂时无法处理这次请求，再问一次？')).toBeVisible();
    await expect(page.getByText(/诊断编号：conch-/)).toBeVisible();
  });

  test('神奇海螺明确显示上游 API 凭据失效', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    await page.route('**/api/v1/conch/ask', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'CONCH_CREDENTIAL_INVALID' }) });
    });
    await page.getByTestId('conch-toggle').click();
    await expect(page.getByText('海螺服务的 API 凭据已失效，更新后才能继续。')).toBeVisible();
    await expect(page.getByRole('button', { name: '再问一次' })).toHaveCount(0);
  });

  test('神奇海螺明确显示上游推理额度不足', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    await page.route('**/api/v1/conch/ask', async (route) => {
      await route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'CONCH_QUOTA_EXHAUSTED' }) });
    });
    await page.getByTestId('conch-toggle').click();
    await expect(page.getByText('海螺的推理额度已用尽；补充额度或更换已授权模型后再问。')).toBeVisible();
    await expect(page.getByText(/诊断编号：conch-/)).toBeVisible();
    await expect(page.getByRole('button', { name: '再问一次' })).toHaveCount(0);
  });

  test('神奇海螺发现 owner 会话失效后回到只读态并引导解锁', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    let askCount = 0;
    await page.route('**/api/v1/conch/ask', async (route) => {
      askCount += 1;
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'UNAUTHORIZED' }) });
    });

    await page.getByTestId('conch-toggle').click();
    await expect.poll(() => askCount).toBe(1);
    await expect(page.getByTestId('unlock-btn')).toBeVisible();
    await expect(page.getByText('登录状态已过期，请点击右上角锁图标重新解锁')).toBeVisible();
    await expect(page.getByTestId('conch-panel')).toHaveCount(0);
  });

  test('回顾与海螺浮层约束 Tab 焦点并在关闭后归还入口焦点', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => localStorage.removeItem('clock-conch-cache-v5'));
    await page.route('**/api/v1/conch/ask', async (route) => {
      const state = await (await page.request.get('/api/v1/state')).json();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: 'all',
          generated_at: new Date().toISOString(),
          cache_valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          revision: state.revision,
          conch_revision: state.conch_revision,
          model: 'e2e-stub',
          subjects: [],
          skipped: [],
        }),
      });
    });

    const historyTrigger = page.getByTestId('history-toggle');
    await historyTrigger.click();
    const history = page.getByTestId('history-strip');
    await expect(history).toBeVisible();
    await expect(history.getByRole('button', { name: '关闭' })).toBeFocused();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await history.evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(historyTrigger).toBeFocused();

    const conchTrigger = page.getByTestId('conch-toggle');
    await conchTrigger.click();
    const conch = page.getByTestId('conch-panel');
    await expect(conch).toBeVisible();
    await expect(conch.getByRole('button', { name: '关闭' })).toBeFocused();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await conch.evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(conchTrigger).toBeFocused();
  });

  test('计时对表：一端开始计时，另一端同步进入运行且秒数对齐（±2s）', async ({ page, context }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await expect(page.getByText('· 进行中')).toBeVisible();

    // 端 B：同浏览器新标签页（共享会话状态轮询 + BroadcastChannel 脉冲）
    const pageB = await context.newPage();
    await pageB.goto('/');
    await pageB.waitForTimeout(400);
    await expect(pageB.getByText('· 进行中')).toBeVisible({ timeout: 10_000 });

    // 对表：两端累计秒数差 ≤2s（服务端权威 + 各自单调外推）
    await page.waitForTimeout(6_000);
    const secsOf = async (p: typeof page) => {
      const label = await p.getByTestId('timer-seconds').getAttribute('aria-label');
      const m = label!.match(/累计 (\d{2}):(\d{2}):(\d{2})/);
      return Number(m![1]) * 3600 + Number(m![2]) * 60 + Number(m![3]);
    };
    const [a, b] = [await secsOf(page), await secsOf(pageB)];
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
    expect(a).toBeGreaterThanOrEqual(5);
    await pageB.close();

    // 自我清理
    await page.getByRole('button', { name: '结束并保存' }).click();
    const withdrawBtn = page.getByTestId('finish-withdraw-btn');
    if (await withdrawBtn.count()) await withdrawBtn.click();
    else {
      const cont = page.getByRole('button', { name: '好，继续' });
      if (await cont.count()) await cont.click();
    }
    await expect(page.getByTestId('idle-clock')).toBeVisible();
  });
});

test.describe('离开（暂停）时长显示', () => {
  test('暂停后显示「已离开」计时且不计学习时长', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1000);

    // 暂停前不显示离开行
    await expect(page.getByTestId('away-line')).toHaveCount(0);

    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByTestId('away-line')).toBeVisible();
    await expect(page.getByTestId('away-line')).toContainText(/休息中|静默中/);
    await expect(page.getByTestId('away-line')).toContainText('建议');
    const pausedState = await (await page.request.get('/api/v1/state')).json();
    expect(pausedState.active_session.status).toBe('paused');
    expect(Math.abs(pausedState.server_now_ms - Date.parse(pausedState.active_session.paused_at))).toBeLessThan(5_000);

    // 离开时长在增长（等待 1.5s 后应至少为 00:00:01）
    await page.waitForTimeout(1500);
    const text = await page.getByTestId('away-line').innerText();
    expect(text).toMatch(/已休息 00:00:0[1-9]/);

    await page.getByRole('button', { name: '继续计时' }).click();
    await expect(page.getByTestId('away-line')).toHaveCount(0);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });
});

test.describe('时间轴 popover 编辑备注', () => {
  test('点击已停止片段可编辑并保存备注', async ({ page }) => {
    await doSetup(page);
    const beforeSegs = await page.locator('.seg').count();
    // 产生一个已停止会话
    await page.getByRole('radio', { name: '英语二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
    // 等待 sessions 刷新（写锁延迟解锁后才拉新数据），片段数 +1 即已停止会话可见
    await expect(page.locator('.seg')).toHaveCount(beforeSegs + 1, { timeout: 8000 });
    // 再等 sessions 状态更新为 stopped（片段 stopped 标记依赖 sessions 数据）
    await page.waitForTimeout(1200);

    // 打开 popover → 填备注 → Enter 自动保存（无 Save 按钮，参照 SP inline-markdown）
    await page.locator('.seg-hit').last().click();
    await expect(page.getByTestId('seg-popover')).toBeVisible();
    await page.getByTestId('popover-note-input').fill('精读真题 2010 年');
    await page.getByTestId('popover-note-input').press('Enter');

    // 保存后 popover 关闭，时间轴刷新后再次打开可见备注
    await expect(page.getByTestId('seg-popover')).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.locator('.seg-hit').last().click();
    await expect(page.getByTestId('popover-note-input')).toHaveValue('精读真题 2010 年');
    await page.keyboard.press('Escape');
  });
});

test.describe('时间轴起点补录', () => {
  test('已结束会话可把开始时间向前调整', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();

    await page.waitForTimeout(1600);
    await expect(page.locator('.seg-hit').last()).toBeVisible({ timeout: 8000 });
    await page.locator('.seg-hit:visible').last().click();
    const input = page.getByTestId('popover-start-input');
    await expect(input).toBeVisible();
    const original = await input.inputValue();
    const [hour, minute] = original.split(':').map(Number);
    const earlierMinutes = (hour * 60 + minute - 10 + 1440) % 1440;
    const earlier = `${String(Math.floor(earlierMinutes / 60)).padStart(2, '0')}:${String(earlierMinutes % 60).padStart(2, '0')}`;
    await input.fill(earlier);
    await page.getByTestId('popover-save-start').click();
    await expect(page.getByTestId('toast')).toContainText('开始时间已更新');
  });
});

test.describe('时间轴尺度与流水账视图', () => {
  test('默认与全天尺度可切换，不再提供放大缩小或有效全天', async ({ page }) => {
    await doSetup(page);
    // 产生一个会话
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();

    const track = page.locator('.timeline-track');
    await expect(track).toBeVisible();
    await expect(page.getByRole('button', { name: '放大时间轴' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '缩小时间轴' })).toHaveCount(0);

    const scales = page.getByRole('radiogroup', { name: '时间轴尺度' });
    await expect(scales).toBeVisible();
    await expect(scales.getByRole('radio')).toHaveCount(2);
    await expect(scales.getByRole('radio', { name: '默认' })).toHaveAttribute('aria-checked', 'true');
    await expect(track).toHaveAttribute('data-scale', 'default');

    await scales.getByRole('radio', { name: '全天', exact: true }).click();
    await expect(track).toHaveAttribute('data-scale', 'full-day');
    // 左端只保留刻度线：08:00 与轨道/静默区边界重合时不重复标字，避免可读性冲突。
    await expect(track.locator('.tick').first().locator('.tick-label')).toHaveCount(0);
    await expect(track.locator('.tick-label').last()).toHaveText('22:30');

    await expect(scales.getByRole('radio', { name: '有效全天' })).toHaveCount(0);

    // 切换流水账视图
    await page.getByTestId('timeline-mode-btn').click();
    await expect(page.getByTestId('timeline-list')).toBeVisible();
    await expect(track).toHaveCount(0);

    // 切回轨道
    await page.getByTestId('timeline-mode-btn').click();
    await expect(track).toBeVisible();
  });
});

test.describe('全屏沉浸模式', () => {
  test('设置内入口可进入全屏；全屏与窗口模式共用同一套布局', async ({ page }) => {
    await doSetup(page);
    // 主界面没有全屏按钮（入口只在设置内）
    await expect(page.getByRole('button', { name: '全屏沉浸模式' })).toHaveCount(0);
    await expect(page.getByTestId('settings-fullscreen-btn')).toHaveCount(0);

    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByTestId('settings-fullscreen-btn')).toBeVisible();
    await page.getByTestId('settings-fullscreen-btn').click();
    await page.waitForTimeout(600);
    const fs = await page.evaluate(() => Boolean(document.fullscreenElement));
    if (fs) {
      // 成功后设置弹窗关闭
      await expect(page.getByTestId('settings-fullscreen-btn')).toHaveCount(0);
      // 共用一套代码：全屏只是视口变大，顶栏与时间轴原样保留，
      // 不存在第二套全屏 UI（无控制条、无抽屉）
      await expect(page.locator('.topbar')).toBeVisible();
      await expect(page.locator('.timeline')).toBeVisible();
      await expect(page.locator('.fs-controls')).toHaveCount(0);
      await expect(page.locator('.timeline-drawer')).toHaveCount(0);
      // headless 下 Esc 可能不触发退出，用程序化退出
      await page.evaluate(() => document.exitFullscreen().catch(() => {}));
      await page.waitForTimeout(600);
      const stillFs = await page.evaluate(() => Boolean(document.fullscreenElement));
      if (!stillFs) await expect(page.locator('.topbar')).toBeVisible();
    } else {
      // 浏览器拒绝全屏时必须给出可理解的反馈，而不是静默失败
      await expect(page.getByText('浏览器拒绝了全屏请求')).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test('全屏请求异步被拒绝时保留设置并显示原因', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
      Object.defineProperty(document.documentElement, 'requestFullscreen', {
        configurable: true,
        value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      });
    });

    await page.getByRole('button', { name: '设置' }).click();
    await page.getByTestId('settings-fullscreen-btn').click();
    await expect(page.getByTestId('settings-fullscreen-btn')).toBeVisible();
    await expect(page.getByText('浏览器拒绝了全屏请求')).toBeVisible();
  });
});

test.describe('首页休息状态', () => {
  test('关闭结束反馈后仍显示休息建议，刷新后可恢复', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
    await expect(page.getByTestId('idle-rest-line')).toContainText('建议 2 分钟');
    await page.reload();
    await expect(page.getByTestId('idle-rest-line')).toContainText('已休息');
  });

  test('暂停后结束不会把已经发生的休息重新归零', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: '暂停计时' }).click();
    // 先等暂停到达服务端再快进时钟，避免与轮询校准竞态导致休息锚点漂移
    await expect.poll(async () => {
      const res = await page.request.get('/api/v1/state');
      return ((await res.json()).active_session as { status?: string } | null)?.status;
    }, { timeout: 5_000 }).toBe('paused');
    await page.clock.fastForward(3 * 60 * 1000);
    await expect(page.getByTestId('away-line')).toContainText('已休息 00:03');

    await page.getByRole('button', { name: '结束并保存' }).click();
    await expect(page.getByTestId('finish-duration')).toBeVisible();
    await expect(page.getByTestId('away-line')).toContainText('已休息 00:03');
  });
});

test.describe('离开渐进提醒', () => {
  test('专注运行中无论持续多久都不进入休息提醒', async ({ page }) => {
    await page.clock.install({ time: beijingTodayAt(10) });
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.clock.fastForward(2 * 60 * 60 * 1000);

    await expect(page.locator('.clockface.is-running')).toHaveAttribute('data-away-level', '0');
    await expect(page.getByTestId('away-line')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);
  });

  test('午饭午睡静默期间继续计时但不升级提醒或弹出召回', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: '暂停计时' }).click();

    const pausedSnapshot = await (await page.request.get('/api/v1/snapshot')).json();
    const pausedState = pausedSnapshot.state;
    const quietNowMs = beijingTodayAt(11, 8).getTime();
    await page.route('**/api/v1/snapshot', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...pausedSnapshot,
          state: {
            ...pausedState,
            server_now_ms: quietNowMs,
            active_session: {
              ...pausedState.active_session,
              paused_at: new Date(quietNowMs - 10 * 60_000).toISOString(),
            },
          },
        }),
      });
    });

    // 恢复 11:08 的服务端状态；即使休息超时，午饭午睡静默期也不得升级或召回。
    await page.reload();
    await expect(page.getByTestId('away-line')).toContainText('静默中');
    await expect(page.locator('.clockface.is-paused')).toHaveAttribute('data-away-level', '0');
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);

    await page.unroute('**/api/v1/snapshot');
    await page.getByRole('button', { name: '继续计时' }).click();
    await page.getByRole('button', { name: '结束并保存' }).click();
    const continueBtn = page.getByRole('button', { name: '好，继续' });
    if ((await continueBtn.count()) > 0) await continueBtn.click();
  });

  test('按上一段专注时长计算休息窗口，并在临近/到期/超时提醒', async ({ page }) => {
    await page.clock.install({ time: beijingTodayAt(10) });
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByTestId('away-line')).toBeVisible();

    const pausedSnapshot = await (await page.request.get('/api/v1/snapshot')).json();
    const pausedState = pausedSnapshot.state;
    let pausedAgeMs = 6 * 60 * 1000;
    await page.route('**/api/v1/snapshot', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...pausedSnapshot,
          state: {
            ...pausedState,
            active_session: {
              ...pausedState.active_session,
              paused_at: new Date(pausedState.server_now_ms - pausedAgeMs).toISOString(),
            },
          },
        }),
      });
    });

    // 约 1 秒专注给 2 分钟统一休息窗口；恢复 6 分钟暂停快照后进入到期提醒。
    await page.reload();
    await expect(page.getByTestId('away-line')).toHaveClass(/strong/);

    // 恢复 9 分钟暂停快照后进入逾期：统一由红色洗色氛围 + away-line 表达，无阻断弹窗。
    pausedAgeMs = 9 * 60 * 1000;
    await page.reload();
    await expect(page.locator('.clockface.is-paused')).toHaveAttribute('data-away-level', '3');
    await expect(page.getByTestId('away-line')).toContainText('休息已超时');
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);

    // 回到学习：常规控件恢复运行，提醒复位
    await page.unroute('**/api/v1/snapshot');
    await page.getByRole('button', { name: '继续计时' }).click();
    await expect(page.getByText('· 进行中')).toBeVisible();
    await expect(page.locator('.clockface.is-running')).toHaveAttribute('data-away-level', '0');

    // 自我清理：结束会话回到空闲态（避免串行污染后续依赖空闲态的测试）
    await page.getByRole('button', { name: '结束并保存' }).click();
    const continueBtn = page.getByRole('button', { name: '好，继续' });
    if ((await continueBtn.count()) > 0) await continueBtn.click();
    await expect(page.getByTestId('idle-clock')).toBeVisible();
  });
});

test.describe('科目结束后的离开提醒', () => {
  test('结束后同样进入已离开渐进提醒，逾期后可开始下一段', async ({ page }) => {
    // 固定在北京时间 10:00，避免真实运行时间落入静默区导致用例漂移。
    await page.clock.install({ time: beijingTodayAt(10) });
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.waitForTimeout(500);

    // 结束卡内显示可解释的休息阶段与建议时长
    await expect(page.getByTestId('away-line')).toBeVisible();
    await expect(page.getByTestId('away-line')).toContainText('休息中');
    await expect(page.getByTestId('away-line')).toContainText('建议 2 分钟');

    // 约 1 秒专注给 2 分钟统一休息窗口；达到建议休息时长 → 红（strong）
    await page.clock.fastForward(6 * 60 * 1000);
    await expect(page.getByTestId('away-line')).toHaveClass(/strong/);

    // 逾期宽限后：红色洗色氛围 + away-line 表达（无阻断弹窗）；开始下一段回到空闲页
    await page.clock.fastForward(3 * 60 * 1000);
    await expect(page.locator('.clockface')).toHaveAttribute('data-away-level', '3');
    await expect(page.getByTestId('away-line')).toContainText('休息已超时');
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);

    // 开始下一段：回到空闲页并开始新会话
    await page.getByRole('button', { name: '好，继续' }).click();
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    // 关掉结束卡后的空闲态与暂停态氛围一致：逾期洗色持续，直到开始下一段
    await expect(page.locator('.clockface.idle')).toHaveAttribute('data-away-level', '3');
    await page.getByTestId('start-btn').click();
    await expect(page.getByText('· 进行中')).toBeVisible();
    // 运行态不再显示离开行（提醒已复位）
    await expect(page.getByTestId('away-line')).toHaveCount(0);
    await expect(page.locator('.clockface.is-running')).toHaveAttribute('data-away-level', '0');

    // 自我清理
    await page.getByRole('button', { name: '结束并保存' }).click();
    const continueBtn = page.getByRole('button', { name: '好，继续' });
    if ((await continueBtn.count()) > 0) await continueBtn.click();
    await expect(page.getByTestId('idle-clock')).toBeVisible();
  });
});

test.describe('计时防抖', () => {
  test('运行/恢复中前段+本段与累计恒一致（无抢秒 ±1 跳变）', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(2000);
    // 暂停 → 恢复（正是此前抖动高发的状态切换点）
    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: '继续计时' }).click();

    // 连续采样：任意时刻 prev+seg 与累计的偏差 ≤1s（floor 损失），杜绝 prev 多 1 秒又跳回
    // 注：flex item 的 innerText 会插入换行，用 textContent 解析
    for (let i = 0; i < 8; i++) {
      const label = await page.getByTestId('timer-seconds').getAttribute('aria-label');
      const totalM = label!.match(/累计 (\d{2}):(\d{2}):(\d{2})/);
      const total = Number(totalM![1]) * 3600 + Number(totalM![2]) * 60 + Number(totalM![3]);
      const text = await page.getByTestId('timer-seconds').evaluate((el) => el.textContent ?? '');
      const m = text.match(/(\d{2}):(\d{2}):(\d{2})\+(\d{2}):(\d{2})/);
      expect(m, `text=${JSON.stringify(text)}`).not.toBeNull();
      const prevS = Number(m![1]) * 3600 + Number(m![2]) * 60 + Number(m![3]);
      const segS = Number(m![4]) * 60 + Number(m![5]);
      expect(Math.abs(total - (prevS + segS))).toBeLessThanOrEqual(1);
      await page.waitForTimeout(150);
    }

    // 自我清理：结束会话回到空闲态
    await page.getByRole('button', { name: '结束并保存' }).click();
    const continueBtn = page.getByRole('button', { name: '好，继续' });
    if ((await continueBtn.count()) > 0) await continueBtn.click();
    await expect(page.getByTestId('idle-clock')).toBeVisible();
  });
});
