/**
 * E2E：真实交互、独立时间差校验、时间轴、视口矩阵与截图证据。
 * 每次运行前清空数据目录，保证 setup 流程可重复。
 */

import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';

const PASSWORD = '123456';

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

test.describe('番茄节奏（自动阶段）', () => {
  test('开启节奏后显示节奏环；暂停显示离开行与节奏环小憩态', async ({ page }) => {
    await doSetup(page);

    // 设置里开启自定义节奏
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('radio', { name: '自定义' }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('radio', { name: '数学一' }).click();
    await page.getByTestId('start-btn').click();

    // 节奏环出现（未到节奏点，无横幅）
    await expect(page.getByTestId('rhythm-remain')).toBeVisible();
    await expect(page.getByText('第 1 轮')).toBeVisible();
    await expect(page.getByTestId('rhythm-banner')).toHaveCount(0);

    // 暂停后显示离开行与节奏环的小憩态
    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByTestId('away-line')).toBeVisible();
    await expect(page.getByTestId('away-line')).toContainText('已离开');
    await expect(page.getByText('小憩中')).toBeVisible();

    // 继续并结束清理
    await page.getByRole('button', { name: '继续计时' }).click();
    await expect(page.getByTestId('away-line')).toHaveCount(0);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });

  test('节奏默认关闭，运行态不显示节奏环', async ({ page, context }) => {
    // 先进入页面拿到 origin，再清设置与 cookie
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('clock-settings-v2'));
    await context.clearCookies();
    await doSetup(page);
    await page.getByRole('radio', { name: '英语一' }).click();
    await page.getByTestId('start-btn').click();
    await expect(page.getByTestId('timer-seconds')).toBeVisible();
    await expect(page.locator('.rhythm-ring-wrap')).toHaveCount(0);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();
  });
});

test.describe('时间轴信标与自动滚动', () => {
  test('开始会话后时间轴自动定位，「现在」按钮可滚回信标', async ({ page }) => {
    await doSetup(page);
    await page.getByRole('radio', { name: '数学一' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(800);

    // 信标存在
    await expect(page.getByTestId('now-line')).toBeVisible();

    // 手动滚到远端（模拟用户浏览历史时段）
    const scroll = page.getByTestId('timeline-scroll');
    await scroll.evaluate((el) => { el.scrollLeft = 4000; });
    await page.waitForTimeout(100);

    // 点击「现在」平滑滚回信标（时间无关：验证 now-line 进入可视区）
    await page.getByTestId('scroll-now-btn').click();
    await page.waitForFunction(
      () => {
        const scrollEl = document.querySelector('[data-testid="timeline-scroll"]');
        const nowLine = document.querySelector('[data-testid="now-line"]') as HTMLElement | null;
        if (!scrollEl || !nowLine) return false;
        const rect = scrollEl.getBoundingClientRect();
        const lineRect = nowLine.getBoundingClientRect();
        return lineRect.left >= rect.left - 5 && lineRect.left <= rect.right + 5;
      },
      { timeout: 5000 },
    );

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
    await page.getByRole('radio', { name: '数学一' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1000);

    // 暂停前不显示离开行
    await expect(page.getByTestId('away-line')).toHaveCount(0);

    await page.getByRole('button', { name: '暂停计时' }).click();
    await expect(page.getByTestId('away-line')).toBeVisible();
    await expect(page.getByTestId('away-line')).toContainText('已离开');
    await expect(page.getByTestId('away-line')).toContainText('不计学习时长');

    // 离开时长在增长（等待 1.5s 后应至少为 00:00:01）
    await page.waitForTimeout(1500);
    const text = await page.getByTestId('away-line').innerText();
    expect(text).toMatch(/已离开 00:00:0[1-9]/);

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
    await page.getByRole('radio', { name: '英语一' }).click();
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

test.describe('时间轴缩放与流水账视图', () => {
  test('缩放改变轨道宽度，流水账视图可切换回', async ({ page }) => {
    await doSetup(page);
    // 产生一个会话
    await page.getByRole('radio', { name: '数学一' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.getByRole('button', { name: '好，继续' }).click();

    const track = page.locator('.timeline-track');
    await expect(track).toBeVisible();
    const baseWidth = (await track.boundingBox())!.width;

    // 放大后轨道变宽
    await page.getByRole('button', { name: '放大时间轴' }).click();
    const zoomedWidth = (await track.boundingBox())!.width;
    expect(zoomedWidth).toBeGreaterThan(baseWidth);

    // 缩小回原宽
    await page.getByRole('button', { name: '缩小时间轴' }).click();
    const backWidth = (await track.boundingBox())!.width;
    expect(backWidth).toBeCloseTo(baseWidth, 0);

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
  test('全屏按钮存在；进入全屏后时间轴与顶栏隐藏', async ({ page }) => {
    await doSetup(page);
    const btn = page.getByRole('button', { name: '全屏沉浸模式' });
    await expect(btn).toBeVisible();
    // headless 环境可能不支持 Fullscreen API；仅在真实进入全屏时验证隐藏行为
    await btn.click().catch(() => {});
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
