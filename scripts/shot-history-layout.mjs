import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:4517';
const PIN = '123456';

const browser = await chromium.launch();

async function shoot(width, height, name) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(400);
  // PIN setup / login
  await page.keyboard.type(PIN);
  await page.waitForTimeout(700);
  if ((await page.getByText('再输入一次以确认').count()) > 0) {
    await page.keyboard.type(PIN);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(400);
  // 造一条今日会话，让 7 天视图有内容
  const hasStart = await page.getByTestId('start-btn').count();
  if (hasStart) {
    await page.getByRole('radio', { name: '数学二' }).click();
    await page.getByTestId('start-btn').click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '结束并保存' }).click();
    await page.waitForTimeout(300);
    const cont = page.getByRole('button', { name: '好，继续' });
    if ((await cont.count()) > 0) await cont.click();
    await page.waitForTimeout(400);
  }
  // 打开近 7 天回顾
  await page.getByTestId('history-toggle').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `e2e/screens/layout-${name}.png`, fullPage: false });
  // 采集几何：app / main / timeline / history-strip 高度，检查是否有空白与挤压
  const geo = await page.evaluate(() => {
    const r = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    const app = document.querySelector('.app');
    const main = document.querySelector('.main');
    const clock = document.querySelector('.clockface');
    const timer = document.querySelector('.big-timer, .idle-clock');
    const timeline = document.querySelector('.timeline');
    const strip = document.querySelector('.history-strip');
    const cs = timer ? getComputedStyle(timer).fontSize : null;
    return {
      viewport: innerHeight,
      app: r(app),
      main: r(main),
      clock: r(clock),
      timerFontSize: cs,
      timeline: r(timeline),
      historyStrip: r(strip),
      bodyScrollHeight: document.body.scrollHeight,
    };
  });
  console.log(`[${name} ${width}x${height}]`, JSON.stringify(geo));
  await ctx.close();
}

await shoot(1280, 720, '1280x720');
await shoot(1440, 900, '1440x900');
await shoot(1024, 640, '1024x640');
await browser.close();
console.log('done');
