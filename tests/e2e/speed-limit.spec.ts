/**
 * The bandwidth control in the title bar must actually change the engine's
 * limit, not just look like it does.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('the title bar speed control sets the global download limit', async () => {
  test.setTimeout(120_000)

  const userDataDir = join(tmpdir(), `td-speed-${randomBytes(5).toString('hex')}`)
  await fs.mkdir(userDataDir, { recursive: true })

  const app = await electron.launch({
    args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: PROJECT_ROOT
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.app')).toBeVisible({ timeout: 30_000 })

  const control = page.locator('.titlebar').getByRole('button', { name: 'Bandwidth limits' })

  // Starts unlimited, and says so on its face.
  await expect(control).toContainText('Unlimited')

  await control.click()
  await expect(page.locator('.menu')).toBeVisible()
  await expect(page.locator('.menu__heading', { hasText: 'Download limit' })).toBeVisible()
  await expect(page.locator('.menu__heading', { hasText: 'Upload limit' })).toBeVisible()

  // Pick a download cap from the download section specifically.
  await page.locator('.menu button', { hasText: '500 KB/s' }).first().click()

  await expect(async () => {
    const limit = await page.evaluate(
      async () => (await window.torrentApi.getSettings()).bandwidth.downloadLimit
    )
    expect(limit).toBe(500 * 1024)
  }).toPass({ timeout: 15_000 })

  // The button reflects the new cap without needing a reopen.
  await expect(control).toContainText('500 KB/s')

  // Upload is untouched: the two sections are independent.
  const upload = await page.evaluate(
    async () => (await window.torrentApi.getSettings()).bandwidth.uploadLimit
  )
  expect(upload).toBe(-1)

  // And it can be put back.
  await control.click()
  await page.locator('.menu button', { hasText: 'Unlimited' }).first().click()
  await expect(async () => {
    const limit = await page.evaluate(
      async () => (await window.torrentApi.getSettings()).bandwidth.downloadLimit
    )
    expect(limit).toBe(-1)
  }).toPass({ timeout: 15_000 })
  await expect(control).toContainText('Unlimited')

  // The Settings page must agree -- one setting, two places to reach it.
  await page.locator('.sidebar__item', { hasText: 'Settings' }).click()
  await page.getByRole('tab', { name: 'Bandwidth' }).click()
  await expect(page.locator('input[placeholder="Unlimited"]').first()).toHaveValue('')

  await page
    .screenshot({
      path: join(PROJECT_ROOT, 'test-results', 'screenshots', 'speed-limit.png'),
      animations: 'disabled',
      timeout: 15_000
    })
    .catch(() => undefined)

  await app.close()
  await fs.rm(userDataDir, { recursive: true, force: true })
})
