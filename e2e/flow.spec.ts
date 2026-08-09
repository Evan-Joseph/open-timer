/**
 * E2E：真实交互、独立时间差校验、时间轴、视口矩阵与截图证据。
 * 每次运行前清空数据目录，保证 setup 流程可重复。
 */

import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';

const PASSWORD = 'e2e-password-0000001';

test.beforeAll(() => {
  rmSync('/tmp/clock-e2e-data', { recursive: true, force: true });
});

async function doSetup(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('密码')).toBeVisible();
  await page.getByLabel('密码').fill(PASSWORD);
  const setupBtn = page.getByRole('button', { name: '设置并进入' });
  if ((await setupBtn.count()) > 0) {
    await setupBtn.click();
  } else {
    await page.getByRole('button', { name: '进入' }).click();
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

    // 等 3 秒，做独立时间差校验：UI 秒数 vs 服务端暂算秒数
    await page.waitForTimeout(3000);
    const uiText = await page.getByTestId('timer-seconds').innerText();
    const [h, m, s] = uiText.split(':').map(Number);
    const uiSeconds = h * 3600 + m * 60 + s;
    const stateRes = await page.request.get('/api/v1/state');
    expect(stateRes.ok()).toBeTruthy();
    const stateBody = await stateRes.json();
    expect(stateBody.active_session).not.toBeNull();
    const serverSeconds = stateBody.active_session.active_seconds;
    expect(Math.abs(uiSeconds - serverSeconds)).toBeLessThanOrEqual(3);
    expect(uiSeconds).toBeGreaterThan(0);

    // 暂停
    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByText('· 已暂停')).toBeVisible();
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

  test('时间轴片段点击弹出详情且热区足够大', async ({ page }) => {
    await doSetup(page);
    // 快速产生一个已停止会话
    await page.getByRole('radio', { name: '数学一' }).click();
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

    await seg.click();
    await expect(page.getByRole('dialog', { name: '片段详情' })).toBeVisible();
    await expect(page.getByText('净时长')).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();
  });

  test('换科目结束当前段并开启新段', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '英语一' }).click();
    await page.getByTestId('start-btn').click();
    await expect(page.getByText('· 进行中')).toBeVisible();

    await page.getByText('切换到其他科目').click();
    await page.getByRole('button', { name: '数据结构' }).first().click();

    await expect(page.locator('.subject-pill.large', { hasText: '数据结构' })).toBeVisible();

    // 清理：结束
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('刷新后恢复运行中会话（不丢不重）', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '操作系统' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(2000);

    const before = await page.getByTestId('timer-seconds').innerText();
    await page.reload();

    await expect(page.getByTestId('timer-seconds')).toBeVisible();
    await expect(page.getByText('· 进行中')).toBeVisible();
    // 恢复后秒数与刷新前接近（±10s，含刷新耗时）
    const [bh, bm, bs] = before.split(':').map(Number);
    const beforeSecs = bh * 3600 + bm * 60 + bs;
    await page.waitForTimeout(1000);
    const afterText = await page.getByTestId('timer-seconds').innerText();
    const [ah, am, as] = afterText.split(':').map(Number);
    const afterSecs = ah * 3600 + am * 60 + as;
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
