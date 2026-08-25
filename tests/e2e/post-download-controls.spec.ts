/**
 * Regression: a finished torrent must always offer a way to stop it.
 *
 * Originally the details panel had no action controls at all, and the list row
 * offered "Pause" on a torrent that had already stopped seeding -- so once a
 * download completed there was no obvious way to halt it.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { startLocalSwarm, type LocalSwarm } from '../integration/helpers/local-swarm.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('a finished torrent can be stopped and restarted from both the list and the details panel', async () => {
  test.setTimeout(300_000)

  const swarm: LocalSwarm = await startLocalSwarm({
    name: 'Finished Payload',
    files: [{ path: 'a.bin', size: 200 * 1024 }]
  })
  const userDataDir = join(tmpdir(), `td-done-${randomBytes(5).toString('hex')}`)
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
  await expect(page.getByRole('heading', { name: 'Finished Payload' })).toBeVisible({
    timeout: 90_000
  })
  await page.getByRole('button', { name: 'Start Download' }).click()

  await expect(async () => {
    const p = await page.evaluate(
      async () => (await window.torrentApi.listTorrents()).torrents[0]!.progress
    )
    expect(p).toBeGreaterThanOrEqual(1)
  }).toPass({ timeout: 150_000, intervals: [400] })

  const infoHash = await page.evaluate(
    async () => (await window.torrentApi.listTorrents()).torrents[0]!.infoHash
  )

  // ---- seeding: the row must offer a stop, worded for seeding ----
  await expect(page.locator('.pill--seeding')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.torrent__actions button[title="Stop Seeding"]')).toBeVisible()

  // ---- the details panel must offer real actions ----
  await page.locator('.torrent__name').dblclick()
  const panel = page.locator('.content')
  await expect(panel.getByRole('button', { name: 'Recheck Files' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Open Folder' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Copy Magnet' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Stop Seeding' })).toBeVisible()

  // Stopping from the details panel works.
  await panel.getByRole('button', { name: 'Stop Seeding' }).click()
  await expect(async () => {
    const s = await page.evaluate(
      async () => (await window.torrentApi.listTorrents()).torrents[0]!
    )
    expect(s.status).toBe('paused')
    expect(s.uploadSpeed).toBe(0)
  }).toPass({ timeout: 30_000 })

  // And it flips to a start action rather than leaving a dead Pause button.
  await expect(panel.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(async () => {
    const s = await page.evaluate(
      async () => (await window.torrentApi.listTorrents()).torrents[0]!
    )
    expect(['seeding', 'completed']).toContain(s.status)
  }).toPass({ timeout: 30_000 })

  // ---- the "goal met" state: previously unstoppable and unstartable ----
  // A zero-minute seed goal is met immediately, so the torrent stops itself.
  await page.evaluate(
    (hash) =>
      window.torrentApi.setSeedingGoal(hash, { kind: 'time', ratio: 1, minutes: 0 }),
    infoHash
  )

  await expect(async () => {
    const s = await page.evaluate(
      async () => (await window.torrentApi.listTorrents()).torrents[0]!
    )
    expect(s.status).toBe('completed')
  }).toPass({ timeout: 40_000 })

  // The control must now read as a start, not a pause on an idle torrent.
  await expect(panel.getByRole('button', { name: 'Start Seeding' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Stop Seeding' })).toHaveCount(0)

  // And pressing it must actually put it back to seeding, past the met goal.
  await panel.getByRole('button', { name: 'Start Seeding' }).click()
  await expect(async () => {
    const s = await page.evaluate(
      async () => (await window.torrentApi.listTorrents()).torrents[0]!
    )
    expect(s.status).toBe('seeding')
  }).toPass({ timeout: 40_000 })

  await page
    .screenshot({
      path: join(PROJECT_ROOT, 'test-results', 'screenshots', 'details-actions.png'),
      animations: 'disabled',
      timeout: 15_000
    })
    .catch(() => undefined)

  await app.close()
  await swarm.stop()
  await fs.rm(userDataDir, { recursive: true, force: true })
})
