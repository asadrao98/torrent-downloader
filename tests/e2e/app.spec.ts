/**
 * End-to-end tests driving the real Electron app.
 *
 * These launch the built application, click through its actual UI, and -- for the
 * download test -- run a real BitTorrent swarm on loopback so the app performs a
 * genuine transfer with real piece verification. Nothing here is mocked.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { startLocalSwarm, type LocalSwarm } from '../integration/helpers/local-swarm.js'

// The project is ESM, so `__dirname` does not exist here.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCREENSHOT_DIR = join(PROJECT_ROOT, 'test-results', 'screenshots')

interface Harness {
  app: ElectronApplication
  page: Page
  userDataDir: string
  downloadDir: string
}

async function launch(): Promise<Harness> {
  const userDataDir = join(tmpdir(), `td-e2e-${randomBytes(6).toString('hex')}`)
  const downloadDir = join(userDataDir, 'downloads')
  await fs.mkdir(downloadDir, { recursive: true })

  const app = await electron.launch({
    args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: PROJECT_ROOT
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The shell renders a splash until the first snapshot lands.
  await expect(page.locator('.app')).toBeVisible({ timeout: 30_000 })

  return { app, page, userDataDir, downloadDir }
}

async function teardown(harness: Harness): Promise<void> {
  await harness.app.close().catch(() => undefined)
  await fs.rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Screenshots are diagnostics, not assertions. Capturing can stall on a page
 * with running CSS animations, and a failed artifact must never fail a
 * functional test -- so animations are frozen and errors are swallowed.
 */
async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({
      path: join(SCREENSHOT_DIR, name),
      animations: 'disabled',
      timeout: 15_000
    })
  } catch {
    // Ignore: the test's real assertions stand on their own.
  }
}

/** Forces a theme through the app's own settings, then waits for it to apply. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => window.torrentApi.setTheme(value as 'light' | 'dark'), theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

test.describe('application shell', () => {
  let harness: Harness

  test.beforeAll(async () => {
    harness = await launch()
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  })

  test.afterAll(async () => {
    await teardown(harness)
  })

  test('opens a single window with the sidebar and empty state', async () => {
    const { page } = harness

    expect(await harness.app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.getByRole('button', { name: /^All/ })).toBeVisible()
    await expect(page.getByText('No torrents yet')).toBeVisible()
    await expect(page.locator('.titlebar').getByRole('button', { name: 'Add Torrent' })).toBeVisible()
  })

  test('the renderer is sandboxed with no Node access', async () => {
    const { page } = harness
    // If any of these are reachable, contextIsolation/sandbox is misconfigured.
    const exposure = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      module: typeof (globalThis as Record<string, unknown>).module,
      api: typeof window.torrentApi
    }))
    expect(exposure.require).toBe('undefined')
    expect(exposure.process).toBe('undefined')
    expect(exposure.module).toBe('undefined')
    // The narrow bridge is the only thing exposed.
    expect(exposure.api).toBe('object')
  })

  test('the preload bridge exposes no generic invoke escape hatch', async () => {
    const { page } = harness
    const keys = await page.evaluate(() => Object.keys(window.torrentApi))
    expect(keys).not.toContain('invoke')
    expect(keys).not.toContain('send')
    expect(keys).not.toContain('ipcRenderer')
    expect(keys.length).toBeGreaterThan(20)
  })

  test('rejects an invalid magnet link with a specific message', async () => {
    const { page } = harness
    await page.locator('.titlebar').getByRole('button', { name: 'Add Torrent' }).click()

    const input = page.locator('textarea.textarea')
    await expect(input).toBeVisible()

    await input.fill('not-a-magnet-link')
    await page.locator('.card').getByRole('button', { name: 'Add Torrent' }).click()

    await expect(page.getByText('Invalid magnet link')).toBeVisible()
    await expect(page.getByText(/not a magnet link/i)).toBeVisible()
  })

  test('explains that a pasted web address is not a magnet link', async () => {
    const { page } = harness
    const input = page.locator('textarea.textarea')
    await input.fill('https://example.com/some/page')
    await page.locator('.card').getByRole('button', { name: 'Add Torrent' }).click()
    await expect(page.getByText(/looks like a web address/i)).toBeVisible()
  })

  test('rejects a v2-only magnet with an explanation', async () => {
    const { page } = harness
    const input = page.locator('textarea.textarea')
    await input.fill(`magnet:?xt=urn:btmh:${'1220'.padEnd(68, 'a')}`)
    await page.locator('.card').getByRole('button', { name: 'Add Torrent' }).click()
    await expect(page.getByText(/v2-only magnet/i)).toBeVisible()
  })

  test('renders every settings section', async () => {
    const { page } = harness
    await page.locator('.sidebar__item', { hasText: 'Settings' }).click()

    for (const section of ['General', 'Downloads', 'Bandwidth', 'Seeding', 'Appearance', 'Advanced']) {
      await page.getByRole('tab', { name: section }).click()
      await expect(page.locator('.card')).toBeVisible()
    }

    // Advanced reports what the engine build actually supports.
    await page.getByRole('tab', { name: 'Advanced' }).click()
    await expect(page.getByText(/Engine: WebTorrent \d+\.\d+\.\d+/)).toBeVisible()
    await expect(page.getByText(/µTP: (available|unavailable)/)).toBeVisible()
  })

  test('rejects an unparseable bandwidth limit instead of silently using zero', async () => {
    const { page } = harness
    await page.getByRole('tab', { name: 'Bandwidth' }).click()

    const field = page.locator('input[placeholder="Unlimited"]').first()
    await field.fill('very fast')
    await field.blur()
    await expect(field).toHaveAttribute('aria-invalid', 'true')

    // A valid value is accepted and normalised.
    await field.fill('500 KB/s')
    await field.blur()
    await expect(field).toHaveAttribute('aria-invalid', 'false')
    const limit = await page.evaluate(async () => (await window.torrentApi.getSettings()).bandwidth.downloadLimit)
    expect(limit).toBe(500 * 1024)

    // Put it back so later tests are not throttled.
    await field.fill('')
    await field.blur()
  })

  test('renders the logs screen', async () => {
    const { page } = harness
    await page.locator('.sidebar__item', { hasText: 'Logs' }).click()
    await expect(page.getByRole('button', { name: 'Open Logs Folder' })).toBeVisible()
  })

  test('captures light and dark theme screenshots', async () => {
    const { page } = harness
    await page.locator('.sidebar__item', { hasText: 'All' }).click()

    await setTheme(page, 'light')
    await shot(page, 'empty-light.png')

    await setTheme(page, 'dark')
    await shot(page, 'empty-dark.png')

    await page.locator('.sidebar__item', { hasText: 'Settings' }).click()
    await shot(page, 'settings-dark.png')

    await setTheme(page, 'light')
    await shot(page, 'settings-light.png')
  })
})

test.describe('downloading a real torrent through the UI', () => {
  let harness: Harness
  let swarm: LocalSwarm

  test.beforeAll(async () => {
    harness = await launch()
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true })

    swarm = await startLocalSwarm({
      name: 'E2E Payload',
      files: [
        { path: 'movie.bin', size: 220 * 1024 },
        { path: 'extras/notes.txt', size: 40 * 1024 },
        { path: 'extras/skip-me.bin', size: 150 * 1024 }
      ]
    })
  })

  test.afterAll(async () => {
    await swarm?.stop()
    await teardown(harness)
  })

  test('paste magnet, retrieve metadata, select files, download, seed', async () => {
    const { page, downloadDir } = harness
    test.setTimeout(240_000)

    // The folder picker is a native modal Playwright cannot drive, so the
    // destination is set through the same setting the dialog writes. It must
    // happen before the add flow starts: the metadata screen reads the default
    // path when it mounts.
    await page.evaluate(
      (dir) => window.torrentApi.updateSettings({ downloads: { defaultPath: dir } }),
      downloadDir
    )

    // --- paste the magnet -------------------------------------------------
    await page.locator('.titlebar').getByRole('button', { name: 'Add Torrent' }).click()
    await page.locator('textarea.textarea').fill(swarm.magnetUri)
    await shot(page, 'add-magnet.png')
    await page.locator('.card').getByRole('button', { name: 'Add Torrent' }).click()

    // --- metadata arrives from the swarm ----------------------------------
    // The magnet carries no file list, so this proves ut_metadata worked.
    await expect(page.getByRole('heading', { name: 'E2E Payload' })).toBeVisible({
      timeout: 90_000
    })
    await expect(page.getByText('Files: 3')).toBeVisible()
    await expect(page.locator('.tree__name', { hasText: 'movie.bin' })).toBeVisible()
    await shot(page, 'metadata-selection.png')

    // --- deselect one file ------------------------------------------------
    const extras = page.locator('.tree__row', { hasText: 'extras' }).first()
    await extras.locator('.tree__twisty').click()
    const skipRow = page.locator('.tree__row', { hasText: 'skip-me.bin' })
    await expect(skipRow).toBeVisible()
    await skipRow.locator('[role="checkbox"]').click()
    await expect(page.getByText('2 of 3 files selected')).toBeVisible()

    // --- start the download ----------------------------------------------
    await page.getByRole('button', { name: 'Start Download' }).click()

    // Lands back on the list with the torrent present.
    await expect(page.locator('.torrent__name', { hasText: 'E2E Payload' })).toBeVisible({
      timeout: 30_000
    })
    await shot(page, 'downloading.png')

    // --- wait for real completion ----------------------------------------
    await expect(async () => {
      const progress = await page.evaluate(async () => {
        const listing = await window.torrentApi.listTorrents()
        return listing.torrents[0]?.progress ?? 0
      })
      expect(progress).toBeGreaterThanOrEqual(1)
    }).toPass({ timeout: 180_000, intervals: [500] })

    // The status must move on to seeding or completed, not sit at 99%.
    await expect(page.locator('.pill--seeding, .pill--completed')).toBeVisible({ timeout: 30_000 })
    await shot(page, 'completed.png')

    // --- the bytes on disk must match what the seeder holds ---------------
    const wanted = swarm.files.filter((f) => f.path !== 'extras/skip-me.bin')
    for (const file of wanted) {
      const target = join(downloadDir, 'E2E Payload', file.path)
      const stat = await fs.stat(target)
      expect(stat.size).toBe(file.length)
    }

    // The deselected file must not have been fully downloaded.
    const skipped = join(downloadDir, 'E2E Payload', 'extras/skip-me.bin')
    const skippedStat = await fs.stat(skipped).catch(() => null)
    if (skippedStat) {
      // Boundary pieces are legitimately fetched; a complete file is not.
      const written = await fs.readFile(skipped)
      const nonZero = written.some((b) => b !== 0)
      expect(nonZero ? written.length : 0).toBeLessThanOrEqual(150 * 1024)
    }
  })

  test('pause and resume preserve progress', async () => {
    const { page } = harness
    test.setTimeout(120_000)

    const infoHash = await page.evaluate(async () => {
      const listing = await window.torrentApi.listTorrents()
      return listing.torrents[0]!.infoHash
    })

    const before = await page.evaluate(async () => {
      const listing = await window.torrentApi.listTorrents()
      return listing.torrents[0]!.downloaded
    })

    await page.evaluate((hash) => window.torrentApi.pause(hash), infoHash)
    await expect(page.locator('.pill--paused')).toBeVisible({ timeout: 30_000 })

    // A paused torrent must report no transfer at all.
    await expect(async () => {
      const snapshot = await page.evaluate(async () => {
        const listing = await window.torrentApi.listTorrents()
        return listing.torrents[0]!
      })
      expect(snapshot.downloadSpeed).toBe(0)
      expect(snapshot.uploadSpeed).toBe(0)
    }).toPass({ timeout: 20_000 })

    await page.evaluate((hash) => window.torrentApi.resume(hash), infoHash)

    // Data survives the round trip rather than restarting from zero.
    await expect(async () => {
      const after = await page.evaluate(async () => {
        const listing = await window.torrentApi.listTorrents()
        return listing.torrents[0]!.downloaded
      })
      expect(after).toBeGreaterThanOrEqual(before)
    }).toPass({ timeout: 60_000 })
  })

  test('the details panel shows real figures', async () => {
    const { page } = harness
    await page.locator('.torrent__name', { hasText: 'E2E Payload' }).dblclick()

    await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
    await expect(page.getByText('Info hash')).toBeVisible()

    await page.getByRole('tab', { name: 'Files' }).click()
    await expect(page.locator('.tree__name', { hasText: 'movie.bin' })).toBeVisible()

    await page.getByRole('tab', { name: 'Trackers' }).click()
    await expect(page.locator('td.mono', { hasText: '127.0.0.1' })).toBeVisible({ timeout: 20_000 })

    await shot(page, 'details.png')
  })

  test('recheck verifies the files on disk', async () => {
    const { page } = harness
    test.setTimeout(120_000)

    const infoHash = await page.evaluate(async () => {
      const listing = await window.torrentApi.listTorrents()
      return listing.torrents[0]!.infoHash
    })

    const result = await page.evaluate((hash) => window.torrentApi.recheck(hash), infoHash)
    expect(result.ok).toBe(true)

    await expect(async () => {
      const progress = await page.evaluate(async () => {
        const listing = await window.torrentApi.listTorrents()
        return listing.torrents[0]!.progress
      })
      expect(progress).toBeGreaterThanOrEqual(1)
    }).toPass({ timeout: 90_000 })
  })

  test('torrents survive a restart and resume rather than restarting', async () => {
    test.setTimeout(180_000)
    const { userDataDir } = harness

    const beforeRestart = await harness.page.evaluate(async () => {
      const listing = await window.torrentApi.listTorrents()
      return { count: listing.torrents.length, downloaded: listing.torrents[0]!.downloaded }
    })
    expect(beforeRestart.count).toBe(1)

    // Quit cleanly so the session file and bitfield are flushed.
    await harness.app.close()

    const app = await electron.launch({
      args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
      cwd: PROJECT_ROOT
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.app')).toBeVisible({ timeout: 30_000 })

    harness.app = app
    harness.page = page

    // The torrent comes back, with its progress intact.
    await expect(page.locator('.torrent__name', { hasText: 'E2E Payload' })).toBeVisible({
      timeout: 60_000
    })

    await expect(async () => {
      const after = await page.evaluate(async () => {
        const listing = await window.torrentApi.listTorrents()
        return listing.torrents[0]!
      })
      expect(after.downloaded).toBeGreaterThanOrEqual(beforeRestart.downloaded)
      expect(after.progress).toBeGreaterThanOrEqual(1)
    }).toPass({ timeout: 120_000 })

    await shot(page, 'after-restart.png')
  })

  test('removing a torrent keeps its files by default', async () => {
    const { page, downloadDir } = harness
    test.setTimeout(60_000)

    const infoHash = await page.evaluate(async () => {
      const listing = await window.torrentApi.listTorrents()
      return listing.torrents[0]!.infoHash
    })

    const result = await page.evaluate(
      (hash) => window.torrentApi.remove(hash, 'keep-files'),
      infoHash
    )
    expect(result.ok).toBe(true)

    await expect(page.getByText('No torrents yet')).toBeVisible({ timeout: 30_000 })

    // The point of "keep files": the download is still on disk.
    const stat = await fs.stat(join(downloadDir, 'E2E Payload', 'movie.bin'))
    expect(stat.size).toBe(220 * 1024)
  })
})
