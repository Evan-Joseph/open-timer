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
  }

  const stopButton = page.getByRole('button', { name: '结束并保存' });
  if (await stopButton.count()) {
    await stopButton.click();
    const withdrawButton = page.getByTestId('finish-withdraw-btn');
    if (await withdrawButton.count()) await withdrawButton.click();
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

  for (const viewport of [
    { width: 1024, height: 640 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectDocumentFits(page);
    await expect(page.getByTestId('idle-clock')).toBeVisible();
    await expect(page.getByTestId('timeline-scroll')).toBeVisible();
    await expectWithinViewport(page, '.clockface');
    await expectWithinViewport(page, '.timeline');
  }
});

test('1024x640 中 7 天泳道不触发页面滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await enterReadyState(page);
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-strip')).toBeVisible();
  await expect(page.locator('.history-lane')).toHaveCount(7);
  await expectDocumentFits(page);
  await expectWithinViewport(page, '.clockface');
  await expectWithinViewport(page, '.history-strip');
});

test('全屏逾期时主区与时间轴共享告警状态', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await enterReadyState(page);
  await page.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}));
  await page.waitForTimeout(400);
  test.skip(!(await page.evaluate(() => Boolean(document.fullscreenElement))), '浏览器不支持全屏');

  await page.getByRole('button', { name: '展开时间轴' }).click();
  await page.locator('.clockface').evaluate((element) => element.setAttribute('data-away-level', '3'));
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
  expect(state.wash).not.toBe('');
  expect(state.wash).not.toBe('transparent');
  expect(state.drawerBackground).not.toBe('rgb(255, 255, 255)');

  await expect(page.locator('.timeline-drawer')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  const geometry = await page.evaluate(() => {
    const clock = document.querySelector('.clockface')!.getBoundingClientRect();
    const drawer = document.querySelector('.timeline-drawer')!.getBoundingClientRect();
    const controls = document.querySelector('.fs-controls')!.getBoundingClientRect();
    const main = document.querySelector('.main')!;
    return {
      clockBottom: clock.bottom,
      drawerTop: drawer.top,
      controlsBottom: controls.bottom,
      mainPaddingBottom: getComputedStyle(main).paddingBottom,
    };
  });
  expect(geometry.clockBottom).toBeLessThanOrEqual(geometry.drawerTop + 1);
  expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.drawerTop);
  await expectDocumentFits(page);
});
