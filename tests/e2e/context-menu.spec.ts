/**
 * Regression: context menu items must actually run when clicked.
 *
 * The menu dismissed itself on any mousedown, including its own, so it
 * unmounted before the click landed and every right-click action silently did
 * nothing.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { startLocalSwarm } from '../integration/helpers/local-swarm.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('right-click menu actions execute', async () => {
  test.setTimeout(180_000)

  const swarm = await startLocalSwarm({
    name: 'Menu Payload',
    files: [{ path: 'a.bin', size: 64 * 1024 }]
  })
  const userDataDir = join(tmpdir(), `td-menu-${randomBytes(5).toString('hex')}`)
  const downloadDir = join(userDataDir, 'downloads')
  await fs.mkdir(downloadDir, { recursive: true })

  const app = await electron.launch({
    args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: PROJECT_ROOT
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.app')).toBeVisible({ timeout: 30_000 })

  await page.evaluate(
    (d) => window.torrentApi.updateSettings({ downloads: { defaultPath: d } }),
    downloadDir
  )

  await page.locator('.titlebar').getByRole('button', { name: 'Add Torrent' }).click()
  await page.locator('textarea.textarea').fill(swarm.magnetUri)
  await page.locator('.card').getByRole('button', { name: 'Add Torrent' }).click()
  await expect(page.getByRole('heading', { name: 'Menu Payload' })).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Start Download' }).click()
  await expect(page.locator('.torrent')).toBeVisible({ timeout: 30_000 })

  // Clear the clipboard so the assertion cannot pass on a stale value.
  await page.evaluate(() => navigator.clipboard?.writeText('').catch(() => undefined))

  // ---- the action under test ----
  await page.locator('.torrent').click({ button: 'right' })
  await expect(page.locator('.menu')).toBeVisible()
  await page.locator('.menu button', { hasText: 'Copy Magnet Link' }).click()

  // The menu closes...
  await expect(page.locator('.menu')).toHaveCount(0)

  // ...and the action actually ran.
  await expect(async () => {
    const clip = await page.evaluate(() => window.torrentApi.readMagnetFromClipboard())
    expect(clip).toContain(swarm.infoHash)
  }).toPass({ timeout: 15_000 })

  // A second action, to prove it was not a one-off.
  await page.locator('.torrent').click({ button: 'right' })
  await expect(page.locator('.menu')).toBeVisible()
  await page.locator('.menu button', { hasText: 'Show Details' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible({ timeout: 15_000 })

  // Clicking outside still dismisses, rather than trapping the menu open.
  await page.goBack().catch(() => undefined)
  await page.locator('.sidebar__item', { hasText: 'All' }).click()
  await page.locator('.torrent').click({ button: 'right' })
  await expect(page.locator('.menu')).toBeVisible()
  await page.locator('.titlebar__title').click()
  await expect(page.locator('.menu')).toHaveCount(0)

  await app.close()
  await swarm.stop()
  await fs.rm(userDataDir, { recursive: true, force: true })
})
