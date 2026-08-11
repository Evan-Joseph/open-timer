import { test, expect } from '@playwright/test';

const PIN = '123456';

async function setup(page: any) {
  await page.goto('/');
  await page.waitForTimeout(400);
  await page.keyboard.type(PIN);
  await page.waitForTimeout(700);
  if ((await page.getByText('再输入一次以确认').count()) > 0) {
    await page.keyboard.type(PIN);
    await page.waitForTimeout(700);
  }
}

test('视觉审计样式断言', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  await page.waitForTimeout(500);

  // 1. start-btn：radius 12、高 48、accent #007aff
  const start = await page.getByTestId('start-btn').evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, height: s.minHeight, bg: s.backgroundColor };
  });
  console.log('start-btn:', JSON.stringify(start));
  expect(start.radius).toBe('12px');
  expect(start.height).toBe('48px');

  // 2. 空闲时钟 tabular + 大字号
  const idleClock = await page.getByTestId('idle-clock').evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, weight: s.fontWeight };
  });
  console.log('idle-clock:', JSON.stringify(idleClock));

  // 3. 输入框 radius 10
  const input = await page.locator('.intent-input').evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, fontSize: s.fontSize, padding: s.padding };
  });
  console.log('intent-input:', JSON.stringify(input));
  expect(input.radius).toBe('10px');
  expect(input.fontSize).toBe('15px');

  // 4. 运行态控制按钮 24px 图标 + 56 圆
  await page.getByRole('radio', { name: '数学一' }).click();
  await page.getByTestId('start-btn').click();
  await page.waitForTimeout(1200);
  const ctl = await page.locator('.control-btn.pause').evaluate((el) => {
    const svg = el.querySelector('svg');
    const s = getComputedStyle(el);
    return { w: s.width, h: s.height, svg: svg ? svg.getAttribute('width') : 'none' };
  });
  console.log('control-btn.pause:', JSON.stringify(ctl));
  expect(ctl.w).toBe('56px');
  expect(ctl.svg).toBe('24');

  // 5. now 信标 accent 色
  const nowLine = await page.getByTestId('now-line').evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor };
  });
  console.log('now-line bg:', nowLine.bg);
  expect(nowLine.bg).toBe('rgb(0, 122, 255)'); // #007aff

  // 6. 设置弹窗：dialog radius 14、switch 51×31、seg 容器
  await page.getByRole('button', { name: '结束并保存' }).click();
  await page.getByRole('button', { name: '好，继续' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '设置' }).click();
  await page.waitForTimeout(600);
  const dialog = await page.locator('.dialog-content').evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius };
  });
  console.log('dialog:', JSON.stringify(dialog));
  expect(dialog.radius).toBe('14px');

  // 6b. 结束提示音已与全系统统一为分段控件（无独立 iOS Switch 异类）
  const segCount = await page.locator('.seg-control').count();
  console.log('seg-control count:', segCount);
  expect(segCount).toBe(3); // 外观 / 结束提示音 / 动画
  expect(await page.locator('.switch-root').count()).toBe(0);

  const seg = await page.locator('.seg-control').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, bg: s.backgroundColor };
  });
  console.log('seg-control:', JSON.stringify(seg));

  // 7. PIN 页删除键 aria-disabled
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.waitForTimeout(800);
  const del = page.getByRole('button', { name: '删除一位' });
  expect(await del.getAttribute('aria-disabled')).toBe('true');
  console.log('del-key aria-disabled OK');

  console.log('ALL STYLE ASSERTIONS PASSED');
});
