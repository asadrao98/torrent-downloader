/**
 * Menu-bar item.
 *
 * Shows aggregate transfer state and offers the few actions worth having without
 * bringing the window forward. The icon is drawn at runtime as a template image
 * so macOS tints it correctly in both light and dark menu bars.
 */

import { Menu, Tray, nativeImage } from 'electron'
import type { SessionStats } from '@shared/types.js'
import { UNLIMITED } from '@shared/constants.js'
import { formatSpeed } from '@shared/format.js'
import { log, toLogDetail } from './logger.js'

/**
 * A 16pt download-arrow glyph as an SVG data URI, rendered to a template image.
 * Drawing it here avoids shipping binary assets for something this small.
 */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g fill="black">
    <path d="M16 4a1.6 1.6 0 0 1 1.6 1.6v11.2l3.7-3.7a1.6 1.6 0 1 1 2.26 2.26l-6.43 6.43a1.6 1.6 0 0 1-2.26 0l-6.43-6.43a1.6 1.6 0 1 1 2.26-2.26l3.7 3.7V5.6A1.6 1.6 0 0 1 16 4z"/>
    <path d="M6.4 22.4a1.6 1.6 0 0 1 1.6 1.6v1.6h16v-1.6a1.6 1.6 0 0 1 3.2 0v2.4a2.4 2.4 0 0 1-2.4 2.4H7.6a2.4 2.4 0 0 1-2.4-2.4v-2.4a1.6 1.6 0 0 1 1.2-1.6z"/>
  </g>
</svg>`

export interface TrayActions {
  openApp(): void
  pauseAll(): void
  resumeAll(): void
  setDownloadLimit(bytesPerSecond: number): void
  quit(): void
}

const KB = 1024
const MB = 1024 * 1024

/** Same presets the in-app control offers, so the two never disagree. */
const LIMIT_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Unlimited', value: UNLIMITED },
  { label: '100 KB/s', value: 100 * KB },
  { label: '250 KB/s', value: 250 * KB },
  { label: '500 KB/s', value: 500 * KB },
  { label: '1 MB/s', value: MB },
  { label: '2 MB/s', value: 2 * MB },
  { label: '5 MB/s', value: 5 * MB },
  { label: '10 MB/s', value: 10 * MB }
]

export class AppTray {
  private tray: Tray | null = null
  private lastTitle = ''

  constructor(private readonly actions: TrayActions) {}

  show(): void {
    if (this.tray) return
    try {
      const image = nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`
      )
      const icon = image.resize({ width: 16, height: 16 })
      // Template images are tinted by macOS to match the menu bar appearance.
      icon.setTemplateImage(true)

      this.tray = new Tray(icon)
      this.tray.setToolTip('Torrent Downloader')
      this.tray.on('click', () => this.actions.openApp())
      this.update(null)
    } catch (err) {
      log('tray').warn(`could not create the menu bar item: ${toLogDetail(err)}`)
      this.tray = null
    }
  }

  hide(): void {
    this.tray?.destroy()
    this.tray = null
  }

  get visible(): boolean {
    return this.tray !== null
  }

  update(stats: SessionStats | null, downloadLimit: number = UNLIMITED): void {
    if (!this.tray) return

    const summary = stats
      ? stats.numDownloading > 0
        ? `${stats.numDownloading} downloading`
        : stats.numSeeding > 0
          ? `${stats.numSeeding} seeding`
          : stats.numTorrents > 0
            ? `${stats.numTorrents} torrent${stats.numTorrents === 1 ? '' : 's'}`
            : 'No torrents'
      : 'No torrents'

    const rates = stats
      ? `Total: ↓ ${formatSpeed(stats.downloadSpeed)}   ↑ ${formatSpeed(stats.uploadSpeed)}`
      : 'Total: ↓ —   ↑ —'

    const menu = Menu.buildFromTemplate([
      { label: 'Torrent Downloader', enabled: false },
      { type: 'separator' },
      { label: summary, enabled: false },
      { label: rates, enabled: false },
      { type: 'separator' },
      { label: 'Open App', click: () => this.actions.openApp() },
      { label: 'Pause All', click: () => this.actions.pauseAll() },
      { label: 'Resume All', click: () => this.actions.resumeAll() },
      { type: 'separator' },
      {
        label: 'Download Limit',
        submenu: LIMIT_PRESETS.map((preset) => ({
          label: preset.label,
          type: 'radio' as const,
          checked: downloadLimit === preset.value,
          click: () => this.actions.setDownloadLimit(preset.value)
        }))
      },
      { type: 'separator' },
      { label: 'Quit Torrent Downloader', click: () => this.actions.quit() }
    ])
    this.tray.setContextMenu(menu)

    // Show the download rate beside the icon only while something is moving, so
    // the menu bar is not permanently cluttered.
    const title =
      stats && stats.numDownloading > 0 && stats.downloadSpeed > 0
        ? ` ${formatSpeed(stats.downloadSpeed)}`
        : ''
    if (title !== this.lastTitle) {
      this.tray.setTitle(title)
      this.lastTitle = title
    }
  }
}
