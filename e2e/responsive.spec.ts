import { expect, test, type Page } from '@playwright/test';

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
  } else if (await page.getByTestId('unlock-btn').count()) {
    // 只读监督态：点锁图标解锁进入可操作态
    await page.getByTestId('unlock-btn').click();
    await page.waitForTimeout(300);
    await page.keyboard.type(PASSWORD);
    await page.waitForTimeout(700);
  }

  const stopButton = page.getByRole('button', { name: '结束并保存' });
  if (await stopButton.count()) {
    await stopButton.click();
    const withdrawButton = page.getByTestId('finish-withdraw-btn');
    if (await withdrawButton.count()) await withdrawButton.click();
    else {
      const cont = page.getByRole('button', { name: '好，继续' });
      if (await cont.count()) await cont.click();
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
  // 测试隔离：重置服务端同步偏好与本地键（跨用例泄漏防护）
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

async function recordRecentSession(page: Page, subjectName: string, durationMs = 120) {
  await page.getByRole('radio', { name: subjectName }).click();
  await page.getByTestId('start-btn').click();
  await page.waitForTimeout(durationMs);
  await page.getByRole('button', { name: '结束并保存' }).click();
  // 填上结束备注：避免「无备注刚结束会话」水合到后续新页面的结束卡（跨用例污染）
  await page.locator('.finish-note').fill(`e2e ${subjectName}`);
  await page.getByRole('button', { name: '好，继续' }).click();
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

async function expectWithinViewport(page: Page, selector: string) {
  const bounds = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  });
  const viewport = page.viewportSize()!;
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(viewport.width);
  expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
}

test('横屏标准视口一屏容纳主时钟与时间轴', async ({ page }) => {
  await enterReadyState(page);
  const state = await (await page.request.get('/api/v1/state')).json();
  const expectedTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(state.server_now_ms));
  await expect(page.getByTestId('idle-clock')).toHaveText(expectedTime);

  // Pad/Desktop 横屏共用一套布局：手册要求的四个关键断点全部覆盖，
  // 首屏不得产生文档滚动，时钟与时间轴都必须完整可见。
  for (const viewport of [
    { width: 1024, height: 640 },
    { width: 1024, height: 768 },
    { width: 1180, height: 820 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectDocumentFits(page);
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    await expect(page.getByTestId('timeline-scroll')).toBeVisible();
    await expectWithinViewport(page, '.clockface');
    await expectWithinViewport(page, '.timeline');
    const compactTrack = await page.evaluate(() => {
      const empty = document.querySelector('.timeline-empty-inline')?.getBoundingClientRect();
      const track = document.querySelector('.timeline-track')!.getBoundingClientRect();
      return empty ? { emptyBottom: empty.bottom, trackBottom: track.bottom } : null;
    });
    if (compactTrack) expect(compactTrack.emptyBottom).toBeLessThanOrEqual(compactTrack.trackBottom);
  }
});

test('Pad/Desktop 被动识别可见，且不切换为第二套界面或自动全屏', async ({ page, browser }) => {
  await enterReadyState(page);
  await page.goto('/?device=desktop');
  await expect(page.locator('.app')).toHaveAttribute('data-device-role', 'desktop');
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByTestId('device-role')).toHaveText('Desktop（主控）');
  await page.keyboard.press('Escape');

  const padContext = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
  });
  try {
    const padPage = await padContext.newPage();
    await padPage.goto('/');
    await expect(padPage.locator('.app')).toHaveAttribute('data-device-role', 'pad');
    await expect(padPage.evaluate(() => document.fullscreenElement)).resolves.toBeNull();
    await padPage.getByRole('button', { name: '设置' }).click();
    await expect(padPage.getByTestId('device-role')).toHaveText('Pad（副屏）');
    await expect(padPage.locator('.timeline')).toBeVisible();
  } finally {
    await padContext.close();
  }
});

test('1024x640 中 7 天泳道不触发页面滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await enterReadyState(page);
  for (const subject of ['数学二', '英语二', '数据结构', '计算机组成原理', '操作系统', '计算机网络', '思想政治理论']) {
    await recordRecentSession(page, subject, 1_050);
  }
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-strip')).toBeVisible();
  await expect(page.locator('.history-lane')).toHaveCount(7);
  await expect(page.locator('.history-subject-list > span')).toHaveCount(7);
  await expect.poll(() => page.getByTestId('history-strip').evaluate((panel) => (
    panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1
  ))).toBe(true);
  await expectDocumentFits(page);
  await expectWithinViewport(page, '.clockface');
  await expectWithinViewport(page, '.history-overlay-panel');
  const historyClearance = await page.evaluate(() => ({
    clockBottom: document.querySelector('.clockface')!.getBoundingClientRect().bottom,
    timelineTop: document.querySelector('.timeline')!.getBoundingClientRect().top,
    historyBottom: document.querySelector('.history-overlay-panel')!.getBoundingClientRect().bottom,
    viewportBottom: document.documentElement.clientHeight,
  }));
  expect(
    historyClearance.clockBottom,
    `主时钟侵入时间轴：${JSON.stringify(historyClearance)}`,
  ).toBeLessThanOrEqual(historyClearance.timelineTop);
  expect(
    historyClearance.historyBottom,
    `7 天报告越出视口：${JSON.stringify(historyClearance)}`,
  ).toBeLessThanOrEqual(historyClearance.viewportBottom);
});

test('全屏与窗口模式共用同一布局，逾期告警状态一致', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await enterReadyState(page);
  await recordRecentSession(page, '数学二');
  await expect(page.getByTestId('idle-rest-line')).toBeVisible();
  await page.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}));
  await page.waitForTimeout(400);
  test.skip(!(await page.evaluate(() => Boolean(document.fullscreenElement))), '浏览器不支持全屏');

  // 共用一套代码：全屏下顶栏、主时钟、时间轴原样可见，没有第二套全屏 UI
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.timeline')).toBeVisible();
  await expect(page.locator('.fs-controls')).toHaveCount(0);
  await expect(page.locator('.timeline-drawer')).toHaveCount(0);

  // 告警状态沿用窗口模式的同一套 CSS 变量
  await page.locator('.clockface').evaluate((element) => element.setAttribute('data-away-level', '3'));
  const state = await page.locator('.app').evaluate((element) => {
    const app = getComputedStyle(element);
    return {
      level: document.querySelector('.clockface')?.getAttribute('data-away-level'),
      wash: app.getPropertyValue('--alert-wash').trim(),
      timelineBackground: getComputedStyle(document.querySelector('.timeline')!).backgroundColor,
    };
  });
  expect(state.level).toBe('3');
  expect(state.wash).not.toBe('');
  expect(state.wash).not.toBe('transparent');
  expect(state.timelineBackground).not.toBe('rgb(255, 255, 255)');

  // 一屏容纳，无文档滚动
  await expectDocumentFits(page);
  await expectWithinViewport(page, '.clockface');
  await expectWithinViewport(page, '.timeline');

  await page.evaluate(() => document.exitFullscreen().catch(() => {}));
  await page.waitForTimeout(400);
});

test('L3 逾期告警延续到设置、回顾与海螺浮层', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await enterReadyState(page);
  await page.route('**/api/v1/conch/ask', async (route) => {
    const state = await (await page.request.get('/api/v1/state')).json();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        window: 'all',
        generated_at: new Date().toISOString(),
        revision: state.revision,
        conch_revision: state.conch_revision,
        model: 'e2e-stub',
        subjects: [],
        skipped: [],
      }),
    });
  });

  const surface = async (selector: string) => page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderColor };
  });

  await page.getByTestId('history-toggle').click();
  const historyBase = await surface('.history-overlay-panel');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置' }).click();
  const settingsBase = await surface('.dialog-content');
  await page.keyboard.press('Escape');
  await page.getByTestId('conch-toggle').click();
  await expect(page.locator('.conch-empty')).toBeVisible();
  const conchBase = await surface('.conch-panel');
  await page.keyboard.press('Escape');

  await page.locator('.clockface').evaluate((element) => element.setAttribute('data-away-level', '3'));
  await page.getByTestId('history-toggle').click();
  const historyAlert = await surface('.history-overlay-panel');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置' }).click();
  const settingsAlert = await surface('.dialog-content');
  await page.keyboard.press('Escape');
  await page.getByTestId('conch-toggle').click();
  await expect(page.locator('.conch-empty')).toBeVisible();
  const conchAlert = await surface('.conch-panel');

  expect(historyAlert).not.toEqual(historyBase);
  expect(settingsAlert).not.toEqual(settingsBase);
  expect(conchAlert).not.toEqual(conchBase);
});
