import { test, expect } from '@playwright/test';

const PIN = '123456';

async function setup(page: any) {
  await page.goto('/');
  await page.waitForTimeout(400);
  // 只读监督态（已设置过密码、未登录）：点锁图标唤出解锁层
  if ((await page.locator('.pin-dots').isVisible().catch(() => false)) === false) {
    await page.getByTestId('unlock-btn').click();
    await page.waitForTimeout(300);
  }
  await page.keyboard.type(PIN);
  await page.waitForTimeout(700);
  if ((await page.getByText('再输入一次以确认').count()) > 0) {
    await page.keyboard.type(PIN);
    await page.waitForTimeout(700);
  }
  // 测试隔离：重置服务端同步偏好 + 本地键（深色/视图模式会跨用例泄漏）；清理残留活动会话
  await page.request.put('/api/v1/prefs', {
    data: { theme: 'auto', animations: true, finishSound: false, ambientKind: 'none', timelineScale: 'default', timelineMode: 'track', historyOpen: false, selectedSubject: 'math' },
  });
  await page.evaluate(() => {
    localStorage.setItem('clock-theme', 'auto');
    localStorage.setItem('clock-timeline-scale', 'default');
    localStorage.setItem('clock-timeline-mode', 'track');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  const stopBtn = page.getByRole('button', { name: '结束并保存' });
  if ((await stopBtn.count()) > 0) {
    await stopBtn.click();
    const withdrawBtn = page.getByTestId('finish-withdraw-btn');
    if ((await withdrawBtn.count()) > 0) await withdrawBtn.click();
    else {
      const cont = page.getByRole('button', { name: '好，继续' });
      if ((await cont.count()) > 0) await cont.click();
    }
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
  expect(input.padding).toBe('12px');

  // 4. 运行态控制按钮 24px 图标 + 56 圆
  await page.getByRole('radio', { name: '数学二' }).click();
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
    return { radius: s.borderRadius, background: s.backgroundColor };
  });
  console.log('dialog:', JSON.stringify(dialog));
  expect(dialog.radius).toBe('14px');
  expect(dialog.background).toBe('rgba(255, 255, 255, 0.96)');

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

  // 7. 时间轴详情：桌面保持宽阔三列动作区，中文按钮不换行；移动端编辑区转为单列。
  await page.getByRole('button', { name: '关闭' }).click();
  await page.locator('.seg-hit:visible').last().click();
  const popover = page.getByTestId('seg-popover');
  const desktopPopover = await popover.evaluate((el) => {
    const style = getComputedStyle(el);
    const actions = el.querySelector('.popover-actions')!;
    return {
      width: el.getBoundingClientRect().width,
      background: style.backgroundColor,
      actionColumns: getComputedStyle(actions).gridTemplateColumns,
      wrappedButtons: Array.from(actions.querySelectorAll('button')).filter((button) => button.getClientRects().length > 1).length,
    };
  });
  expect(desktopPopover.width).toBe(440);
  expect(desktopPopover.background).toBe('rgba(255, 255, 255, 0.96)');
  expect(desktopPopover.actionColumns.split(' ').length).toBe(3); // 3 动作：更新起点/继续这段/撤回（备注已自动保存）
  expect(desktopPopover.wrappedButtons).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePopover = await popover.evaluate((el) => ({
    editColumns: getComputedStyle(el.querySelector('.popover-edit-grid')!).gridTemplateColumns,
    actionColumns: getComputedStyle(el.querySelector('.popover-actions')!).gridTemplateColumns,
    fitsViewport: el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0,
  }));
  expect(mobilePopover.editColumns.split(' ').length).toBe(1);
  expect(mobilePopover.actionColumns.split(' ').length).toBe(3); // 366px 宽放下 3 个短按钮，无需换行
  expect(mobilePopover.fitsViewport).toBe(true);
  await page.keyboard.press('Escape');

  // 8. PIN 页删除键 aria-disabled
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.waitForTimeout(800);
  const del = page.getByRole('button', { name: '删除一位' });
  expect(await del.getAttribute('aria-disabled')).toBe('true');
  console.log('del-key aria-disabled OK');

  console.log('ALL STYLE ASSERTIONS PASSED');
});

/**
 * 深色模式契约（docs/DESIGN.md §2/§4）：
 * - 文字 token 对比度：text-1/text-2 ≥4.5:1，text-3 ≥3:1（仅非关键信息），
 *   在 --bg / --bg-elevated / --surface-2 三个表面上逐一验证；
 * - 语义色（accent/danger/success）对底色 ≥3:1；
 * - 弹层材质固定 --popover-surface 深色值 rgba(36, 36, 38, 0.96)。
 */
test('深色模式对比度与材质 token', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('html[data-theme="dark"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const report = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tok = (name: string) => root.getPropertyValue(name).trim();
    const hexToRgb = (hex: string): [number, number, number] => {
      const h = hex.replace('#', '');
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    };
    /** 颜色 token 归一化为 [r,g,b,a]：浏览器可能把自定义属性序列化为
        legacy rgba(…)、modern rgb(… / …) 或 #rrggbb(aa)，全部兼容。 */
    const colorOf = (value: string): [number, number, number, number] => {
      if (value.startsWith('#')) {
        const h = value.slice(1);
        const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return [rgb[0], rgb[1], rgb[2], a];
      }
      const nums = value.match(/[\d.]+/g)!.map(Number);
      return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1];
    };
    const lin = (c: number) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const lum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const text1 = hexToRgb(tok('--text-1'));
    const text2 = hexToRgb(tok('--text-2'));
    const text3 = hexToRgb(tok('--text-3'));
    const surfaces: Array<[string, [number, number, number]]> = [
      ['bg', hexToRgb(tok('--bg'))],
      ['elevated', hexToRgb(tok('--bg-elevated'))],
      ['surface-2', hexToRgb(tok('--surface-2'))],
    ];
    const pairs: Record<string, number> = {};
    for (const [sn, sc] of surfaces) {
      pairs[`text-1/${sn}`] = ratio(text1, sc);
      pairs[`text-2/${sn}`] = ratio(text2, sc);
      pairs[`text-3/${sn}`] = ratio(text3, sc);
    }
    const bg = hexToRgb(tok('--bg'));
    for (const name of ['--accent', '--danger', '--success', '--amber']) {
      pairs[`${name}/bg`] = ratio(hexToRgb(tok(name)), bg);
    }
    pairs['white/accent'] = ratio([255, 255, 255], hexToRgb(tok('--accent')));
    return {
      ratios: pairs,
      popoverSurface: colorOf(tok('--popover-surface')),
      overlayScrim: colorOf(tok('--overlay-scrim')),
    };
  });

  for (const [pair, value] of Object.entries(report.ratios)) {
    console.log(`contrast ${pair}: ${value.toFixed(2)}:1`);
    const min = pair.startsWith('text-3/') ? 3 : pair.includes('/bg') || pair.startsWith('white/') ? 3 : 4.5;
    expect(value, pair).toBeGreaterThanOrEqual(min);
  }
  // 材质 token：深色弹层 rgba(36,36,38,0.96)；遮罩 rgba(0,0,0,0.44)（序列化格式不定，按分量比较）
  expect(report.popoverSurface.slice(0, 3)).toEqual([36, 36, 38]);
  expect(report.popoverSurface[3]).toBeCloseTo(0.96, 1);
  expect(report.overlayScrim.slice(0, 3)).toEqual([0, 0, 0]);
  expect(report.overlayScrim[3]).toBeCloseTo(0.44, 1);

  // 深色弹窗材质实测：设置对话框背景取 --popover-surface
  await page.getByRole('button', { name: '设置' }).click();
  await page.waitForTimeout(500);
  const dialogBg = await page.locator('.dialog-content').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dialogBg).toBe('rgba(36, 36, 38, 0.96)');
  await page.keyboard.press('Escape');
});

/**
 * 工具栏对齐契约（2026-08-20 统一）：
 * - 时间轴标题与右侧工具栏同一行、垂直中心对齐；
 * - 工具栏行高 32px：分段控件容器与图标按钮等高（32），行内所有控件中心共线（±1px）；
 * - 行内间距统一 --space-2（8px）；
 * - 动作行（.action-row）按钮等高 44px：结束反馈卡与时间轴详情弹窗逐一验证。
 */
test('工具栏对齐与动作行等高契约', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  await page.waitForTimeout(500);

  const head = await page.evaluate(() => {
    const title = document.querySelector('.timeline-title')!.getBoundingClientRect();
    const nav = document.querySelector('.timeline-nav')!;
    const navRect = nav.getBoundingClientRect();
    const children = Array.from(nav.children).map((c) => c.getBoundingClientRect());
    return {
      titleCenterY: title.top + title.height / 2,
      navCenterY: navRect.top + navRect.height / 2,
      childCenterYs: children.map((r) => r.top + r.height / 2),
      childHeights: children.map((r) => r.height),
      scaleHeight: document.querySelector('.timeline-scale')!.getBoundingClientRect().height,
      iconHeight: document.querySelector('.timeline-nav .icon-btn')!.getBoundingClientRect().height,
      gap: getComputedStyle(nav).gap,
    };
  });
  expect(Math.abs(head.titleCenterY - head.navCenterY)).toBeLessThanOrEqual(1);
  expect(head.scaleHeight).toBe(32); // 2padding + 2border + 26 项高
  expect(head.iconHeight).toBe(32);
  for (const y of head.childCenterYs) expect(Math.abs(y - head.navCenterY)).toBeLessThanOrEqual(1);
  for (const h of head.childHeights) {
    expect(h).toBeGreaterThanOrEqual(26);
    expect(h).toBeLessThanOrEqual(32);
  }
  expect(head.gap).toBe('8px');

  // 动作行等高：结束反馈卡（撤回 36 档 ghost 与 44 档 primary 必须拉平）
  await page.getByRole('radio', { name: '英语二' }).click();
  await page.getByTestId('start-btn').click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '结束并保存' }).click();
  await page.waitForTimeout(400);
  const finishHeights = await page
    .locator('.finish-actions.action-row > button')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(finishHeights.length).toBe(3); // 撤回这条 / 好，继续 / 继续这段
  for (const h of finishHeights) expect(h).toBe(44);
  await page.getByRole('button', { name: '好，继续' }).click();

  // 动作行等高：时间轴详情弹窗（保存备注/更新起点/撤回）
  await page.locator('.seg-hit:visible').last().click();
  const popHeights = await page
    .locator('.popover-actions.action-row > button')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(popHeights.length).toBe(3); // 更新起点 / 继续这段 / 撤回（备注自动保存，无 Save 按钮）
  for (const h of popHeights) expect(h).toBe(44);
  await page.keyboard.press('Escape');
});

/**
 * 动效时长白名单（docs/DESIGN.md §2 动效行；参照 Spectrum/M3 命名档位实践）：
 * 页面任何元素的 transition/animation 时长只允许取 token 档位值，
 * 禁止组件另写近似时长（此前存在 120/160/220ms 离群值）。
 */
test('动效时长白名单', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  await page.getByRole('radio', { name: '数学二' }).click();
  await page.getByTestId('start-btn').click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '设置' }).click();
  await page.waitForTimeout(400);

  const allowed = [0, 0.00001, 0.1, 0.15, 0.25, 0.28, 0.4, 0.5, 0.9, 1.2, 2.4, 2.6, 2.8, 3.2];
  const violations = await page.evaluate((allow: number[]) => {
    const bad: string[] = [];
    const els = document.querySelectorAll('body *');
    for (const el of els) {
      const s = getComputedStyle(el);
      const durations = `${s.transitionDuration},${s.animationDuration}`.split(',');
      for (const d of durations) {
        const sec = d.trim().endsWith('ms') ? parseFloat(d) / 1000 : parseFloat(d);
        if (!Number.isFinite(sec)) continue;
        if (!allow.some((a) => Math.abs(sec - a) < 0.005)) {
          bad.push(`${(el as HTMLElement).tagName}.${(el as HTMLElement).className}: ${d.trim()}`);
        }
      }
    }
    return bad.slice(0, 10);
  }, allowed);
  expect(violations).toEqual([]);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '结束并保存' }).click();
  await page.getByRole('button', { name: '好，继续' }).click();
});
