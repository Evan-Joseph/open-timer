import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';

const PIN = '123456';

test.beforeAll(() => rmSync('/tmp/open-timer-e2e-data', { recursive: true, force: true }));

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('.pin-dots')).toBeVisible();
  await page.keyboard.type(PIN);
  await page.waitForTimeout(300);
  if (await page.getByText('再输入一次以确认').count()) {
    await page.keyboard.type(PIN);
  }
  await expect(page.getByTestId('idle-clock')).toBeVisible();
}

test('private login, project creation, and timing flow', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByLabel('新项目名称').fill('Release checklist');
  await page.getByRole('button', { name: '添加' }).click();
  await page.getByLabel('关闭').click();
  await page.getByRole('radio', { name: 'Release checklist' }).click();
  await page.getByTestId('start-btn').click();
  await expect(page.getByTestId('timer-seconds')).toBeVisible();
  await page.getByRole('button', { name: '暂停计时' }).click();
  await page.getByRole('button', { name: '继续计时' }).click();
  await page.getByRole('button', { name: '结束并保存' }).click();
  await expect(page.getByTestId('finish-duration')).toBeVisible();
});

test('a logged-out browser cannot view timer data', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.pin-dots')).toBeVisible();
  await expect(page.getByTestId('idle-clock')).toHaveCount(0);
});
