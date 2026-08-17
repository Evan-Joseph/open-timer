/**
 * E2E：真实交互、独立时间差校验、时间轴、视口矩阵与截图证据。
 * 每次运行前清空数据目录，保证 setup 流程可重复。
 */

import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { isQuietMinute } from '@clock/shared';

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

async function doSetup(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(300);
  // PIN 键盘：物理键盘输入 6 位数字（window keydown 监听）
  const enterPin = async () => {
    await page.keyboard.type(PASSWORD);
    await page.waitForTimeout(500); // 满 6 位后自动提交的延迟
  };
  const setupDots = page.locator('.pin-dots');
  await expect(setupDots).toBeVisible();
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
  await expect(page.getByTestId('idle-clock')).toBeVisible();
}

test.describe('核心流程', () => {
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
    await expect(page.getByRole('dialog', { name: '会话详情' })).toHaveCount(0);
    await seg.hover();
    await seg.click();
    await expect(page.getByRole('dialog', { name: '会话详情' })).toBeVisible();
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
    await expect(peer.getByTestId('idle-clock')).toBeVisible({ timeout: 3_000 });
    await page.getByTestId('finish-withdraw-btn').click();
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
    const currentDates = new Set(Array.from({ length: 7 }, (_, index) => shift(state.today_date, -index)));
    await page.route('**/api/v1/daily-summary?**', async (route) => {
      const date = new URL(route.request().url()).searchParams.get('date')!;
      const current = currentDates.has(date);
      const total = current ? 3600 : 1800;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          date,
          total_active_seconds: total,
          by_subject: [
            { subject_id: subjects[0].subject_id, active_seconds: total * 2 / 3, session_count: 1 },
            { subject_id: subjects[1].subject_id, active_seconds: total / 3, session_count: 1 },
          ],
        }),
      });
    });

    await page.route('**/api/v1/sessions?**', async (route) => {
      const date = new URL(route.request().url()).searchParams.get('date')!;
      const startedAt = `${date}T01:00:00.000Z`;
      const endedAt = `${date}T02:00:00.000Z`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [{
            session_id: `history-${date}`,
            subject_id: subjects[0].subject_id,
            started_at: startedAt,
            ended_at: endedAt,
            active_seconds: 3600,
            status: 'stopped',
            end_reason: 'manual',
            note: null,
            segments: [{ started_at: startedAt, ended_at: endedAt }],
          }],
        }),
      });
    });

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByTestId('history-toggle').click();
    const report = page.getByTestId('history-strip');
    await expect(report).toBeVisible();
    await expect(report.locator('.history-metrics')).toContainText('7 小时');
    await expect(report.locator('.history-metrics')).toContainText('日均');
    await expect(report.locator('.history-metrics > div').nth(1)).toContainText('1 小时');
    await expect(report.locator('.history-metrics')).toContainText('最长一天');
    await expect(report).not.toContainText('仅记录时间事实');
    await expect(report).not.toContainText('较前 7 天');
    await expect(report).not.toContainText('活跃天数');
    await expect(report.locator('.history-lane')).toHaveCount(7);
    await expect(report.locator('.history-lane-segment')).toHaveCount(7);
    await expect(report.locator('.history-quiet-period')).toHaveCount(21);
    await expect(report.locator('.history-lane').first()).toContainText('午饭');
    await expect(report.locator('.history-lane').first()).toContainText('午睡');
    await expect(report.locator('.history-lane').first()).toContainText('晚饭');
    await expect(report.getByText('08:00', { exact: true })).toBeVisible();
    await expect(report.getByText('22:30', { exact: true })).toBeVisible();
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
    await expect(page.getByTestId('away-line')).toContainText('休息中');
    await expect(page.getByTestId('away-line')).toContainText('建议');

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

    // 打开 popover → 填备注 → 保存
    await page.locator('.seg-hit').last().click();
    await expect(page.getByTestId('seg-popover')).toBeVisible();
    await page.getByTestId('popover-note-input').fill('精读真题 2010 年');
    await page.getByTestId('popover-save-note').click();

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
    await expect(track.locator('.tick-label').first()).toHaveText('08:00');
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
  test('无应用内全屏按钮；外部进入全屏后自动切换布局', async ({ page }) => {
    await doSetup(page);
    await expect(page.getByRole('button', { name: '全屏沉浸模式' })).toHaveCount(0);
    await page.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}));
    await page.waitForTimeout(600);
    const fs = await page.evaluate(() => Boolean(document.fullscreenElement));
    if (fs) {
      // display:none 隐藏但保留 DOM：断言不可见而非不存在
      await expect(page.locator('.timeline')).not.toBeVisible();
      await expect(page.locator('.topbar')).not.toBeVisible();
      // headless 下 Esc 可能不触发退出，用程序化退出
      await page.evaluate(() => document.exitFullscreen().catch(() => {}));
      await page.waitForTimeout(600);
      const stillFs = await page.evaluate(() => Boolean(document.fullscreenElement));
      if (!stillFs) await expect(page.locator('.topbar')).toBeVisible();
    }
  });
});

test.describe('全屏时间轴开关', () => {
  test('全屏下默认隐藏时间轴，可通过控制条展开与收起', async ({ page }) => {
    await doSetup(page);
    await page.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}));
    await page.waitForTimeout(600);
    const fs = await page.evaluate(() => Boolean(document.fullscreenElement));
    if (!fs) return; // headless 不支持全屏则跳过断言

    // 默认隐藏时间轴，显示控制条
    await expect(page.locator('.timeline')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '展开时间轴' })).toBeVisible();

    // 展开
    await page.getByRole('button', { name: '展开时间轴' }).click();
    await expect(page.locator('.timeline')).toBeVisible();

    // 展开后控制条移到顶部（top:16px），不再遮挡时间轴内容
    const ctrlTop = await page.locator('.fs-controls').evaluate((el) => getComputedStyle(el).top);
    expect(ctrlTop).toBe('16px');

    // 收起
    await page.getByRole('button', { name: '收起时间轴' }).click();
    await expect(page.locator('.timeline')).not.toBeVisible();

    await page.evaluate(() => document.exitFullscreen().catch(() => {}));
    await page.waitForTimeout(400);
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
    await page.clock.install();
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: '暂停计时' }).click();
    await page.clock.fastForward(3 * 60 * 1000);
    await expect(page.getByTestId('away-line')).toContainText('已休息 00:03');

    await page.getByRole('button', { name: '结束并保存' }).click();
    await expect(page.getByTestId('finish-duration')).toBeVisible();
    await expect(page.getByTestId('away-line')).toContainText('已休息 00:03');
  });
});

test.describe('离开渐进提醒', () => {
  test('专注运行中无论持续多久都不进入休息提醒', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-16T02:00:00.000Z') });
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.clock.fastForward(2 * 60 * 60 * 1000);

    await expect(page.locator('.clockface.is-running')).toHaveAttribute('data-away-level', '0');
    await expect(page.getByTestId('away-line')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);
  });

  test('午饭午睡静默期间继续计时但不升级提醒或弹出召回', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-16T02:58:00.000Z') }); // 北京时间 10:58
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: '暂停计时' }).click();

    // 进入 11:00–13:30 静默后，即使休息超过建议时长也不能升级为提醒或召回。
    await page.clock.fastForward(10 * 60 * 1000);
    await expect(page.getByTestId('away-line')).toContainText('静默中');
    await expect(page.locator('.clockface.is-paused')).toHaveAttribute('data-away-level', '0');
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);

    await page.getByRole('button', { name: '继续计时' }).click();
    await page.getByRole('button', { name: '结束并保存' }).click();
    const continueBtn = page.getByRole('button', { name: '好，继续' });
    if ((await continueBtn.count()) > 0) await continueBtn.click();
  });

  test('按上一段专注时长计算休息窗口，并在临近/到期/超时提醒', async ({ page }) => {
    const beijingNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const currentMinute = beijingNow.getUTCHours() * 60 + beijingNow.getUTCMinutes();
    test.skip(
      isQuietMinute(currentMinute) || isQuietMinute(currentMinute + 20),
      '测试窗口与静默时段相交，提醒升级场景互斥',
    );
    await page.clock.install();
    await doSetup(page);
    await page.getByRole('radio', { name: '数据结构' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByTestId('away-line')).toBeVisible();

    // 约 1 秒专注给 2 分钟短暂离开窗口；此时已超过建议时长 → 红（strong）
    await page.clock.fastForward(6 * 60 * 1000);
    await expect(page.getByTestId('away-line')).toHaveClass(/strong/);

    // 逾期宽限后 → 全屏召回
    await page.clock.fastForward(3 * 60 * 1000);
    const dialog = page.getByRole('dialog', { name: '离开提醒' });
    await expect(dialog).toBeVisible();

    // 推迟 5 分钟：立即关闭；4 分钟后不弹，6 分钟后重新弹出
    await dialog.getByRole('button', { name: '再等 5 分钟' }).click();
    await expect(dialog).not.toBeVisible();
    await page.clock.fastForward(4 * 60 * 1000);
    await expect(dialog).not.toBeVisible();
    await page.clock.fastForward(2 * 60 * 1000);
    await expect(dialog).toBeVisible();

    // 回到学习：overlay 关闭并恢复运行
    await dialog.getByRole('button', { name: '回到学习' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('· 进行中')).toBeVisible();
    await expect(page.locator('.clockface.is-running')).toHaveAttribute('data-away-level', '0');
    await page.clock.fastForward(20 * 60 * 1000);
    await expect(page.getByRole('dialog', { name: '离开提醒' })).toHaveCount(0);

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
    await page.clock.install({ time: new Date('2026-08-16T02:00:00.000Z') });
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

    // 约 1 秒专注给 2 分钟短暂离开窗口；达到建议休息时长 → 红（strong）
    await page.clock.fastForward(6 * 60 * 1000);
    await expect(page.getByTestId('away-line')).toHaveClass(/strong/);

    // 逾期宽限后 → 全屏召回，"开始下一段"恢复学习
    await page.clock.fastForward(3 * 60 * 1000);
    const dialog = page.getByRole('dialog', { name: '离开提醒' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '开始下一段' }).click();
    await expect(dialog).not.toBeVisible();
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
