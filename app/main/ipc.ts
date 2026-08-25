/**
 * IPC handlers.
 *
 * Every handler validates its arguments before touching anything: the renderer
 * is sandboxed, but treating its input as trusted would defeat the point of the
 * sandbox if the renderer were ever compromised (a malicious torrent name
 * rendered into the DOM, say). Info hashes are checked against a strict pattern,
 * paths go through the download-directory guard, and enums are matched against
 * allowlists.
 *
 * Errors come back as a user-facing message with the detail written to the log
 * file. A stack trace never crosses this boundary.
 */

import { BrowserWindow, app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/constants.js'
import type {
  ChooseFolderResult,
  FilePriority,
  MagnetParseResult,
  OperationResult,
  RemoveMode,
  SeedingGoal,
  SettingsPatch,
  ThemePreference
} from '@shared/types.js'
import { FILE_PRIORITIES } from '@shared/types.js'
import { extractMagnetUri, parseMagnet } from '@shared/magnet.js'
import type { TorrentManager } from './torrent-manager.js'
import type { SettingsStore } from './settings.js'
import { getLogger, log, toLogDetail, toUserMessage } from './logger.js'
import { engineSupportsUtp, engineVersion } from './torrent-engine.js'
import { UnsafePathError } from './path-guard.js'

const logger = () => log('ipc')

const INFO_HASH = /^[0-9a-f]{40}$/

function requireInfoHash(value: unknown): string {
  if (typeof value !== 'string' || !INFO_HASH.test(value)) {
    throw new Error('That torrent reference is not valid.')
  }
  return value
}

function requireFileIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 500_000) {
    throw new Error('That file reference is not valid.')
  }
  return value
}

function requirePriority(value: unknown): FilePriority {
  if (typeof value !== 'string' || !FILE_PRIORITIES.includes(value as FilePriority)) {
    throw new Error('That priority is not valid.')
  }
  return value as FilePriority
}

function requireRemoveMode(value: unknown): RemoveMode {
  if (value !== 'keep-files' && value !== 'delete-files') {
    throw new Error('That removal mode is not valid.')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Wraps a handler so it always resolves to an OperationResult. */
function action(
  name: string,
  fn: (...args: unknown[]) => Promise<void> | void
): (event: unknown, ...args: unknown[]) => Promise<OperationResult> {
  return async (_event, ...args) => {
    try {
      await fn(...args)
      return { ok: true }
    } catch (err) {
      logger().warn(`${name} failed: ${toLogDetail(err)}`)
      const result: OperationResult = {
        ok: false,
        error: toUserMessage(err, 'That action could not be completed.')
      }
      if (err instanceof UnsafePathError) result.code = 'unsafe-path'
      return result
    }
  }
}

export interface IpcDeps {
  manager: TorrentManager
  settings: SettingsStore
  getMainWindow(): BrowserWindow | null
  showMainWindow(): void
  defaultDownloadPath: string
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { manager, settings } = deps

  // -------------------------------------------------------------- magnet flow

  ipcMain.handle(IPC.MagnetParse, (_event, uri: unknown): MagnetParseResult => {
    if (typeof uri !== 'string') {
      return { ok: false, code: 'empty', message: 'No magnet link was provided.' }
    }
    return parseMagnet(uri)
  })

  ipcMain.handle(IPC.PreviewStart, (_event, source: unknown) => {
    if (typeof source !== 'string') throw new Error('No magnet link was provided.')
    // Accept a pasted blob of text containing a magnet, not just a bare URI.
    const extracted = extractMagnetUri(source) ?? source
    return manager.previews.startFromMagnet(extracted)
  })

  ipcMain.handle(IPC.TorrentFileRead, async (_event, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
      throw new Error('That file could not be read.')
    }
    const view = bytes as Uint8Array
    // A .torrent file is bencoded metadata; anything this large is not one.
    if (view.byteLength === 0 || view.byteLength > 32 * 1024 * 1024) {
      throw new Error('That file is not a valid .torrent file.')
    }
    return manager.previews.startFromTorrentFile(new Uint8Array(view))
  })

  ipcMain.handle(
    IPC.PreviewCancel,
    action('preview:cancel', (previewId) => {
      if (typeof previewId !== 'string') return
      manager.previews.cancel(previewId)
    })
  )

  ipcMain.handle(
    IPC.PreviewCommit,
    action('preview:commit', async (raw) => {
      if (!isRecord(raw)) throw new Error('That request was not valid.')

      const previewId = raw.previewId
      if (typeof previewId !== 'string' || previewId.length === 0) {
        throw new Error('That torrent is no longer pending.')
      }

      const downloadPath = raw.downloadPath
      if (typeof downloadPath !== 'string' || !downloadPath.startsWith('/')) {
        throw new Error('Choose a download folder first.')
      }

      const priorities: Record<number, FilePriority> = {}
      if (isRecord(raw.priorities)) {
        for (const [key, value] of Object.entries(raw.priorities)) {
          const index = Number(key)
          if (!Number.isInteger(index) || index < 0) continue
          priorities[index] = requirePriority(value)
        }
      }

      await manager.addFromPreview(
        previewId,
        downloadPath,
        priorities,
        raw.startPaused === true
      )
    })
  )

  // ------------------------------------------------------------------ torrents

  ipcMain.handle(IPC.TorrentList, () => ({
    torrents: manager.snapshots(),
    stats: manager.sessionStats()
  }))

  ipcMain.handle(IPC.TorrentDetails, (_event, infoHash: unknown) =>
    manager.details(requireInfoHash(infoHash))
  )

  ipcMain.handle(
    IPC.TorrentPause,
    action('torrent:pause', (infoHash) => manager.pause(requireInfoHash(infoHash)))
  )

  ipcMain.handle(
    IPC.TorrentResume,
    action('torrent:resume', (infoHash) => manager.resume(requireInfoHash(infoHash)))
  )

  ipcMain.handle(
    IPC.TorrentForceStart,
    action('torrent:force-start', (infoHash) => manager.forceStart(requireInfoHash(infoHash)))
  )

  ipcMain.handle(
    IPC.TorrentRemove,
    action('torrent:remove', async (raw) => {
      if (!isRecord(raw)) throw new Error('That request was not valid.')
      await manager.remove(requireInfoHash(raw.infoHash), requireRemoveMode(raw.mode))
    })
  )

  ipcMain.handle(
    IPC.TorrentRecheck,
    action('torrent:recheck', (infoHash) => manager.recheck(requireInfoHash(infoHash)))
  )

  ipcMain.handle(
    IPC.TorrentReannounce,
    action('torrent:reannounce', (infoHash) => manager.reannounce(requireInfoHash(infoHash)))
  )

  ipcMain.handle(
    IPC.TorrentSetFilePriority,
    action('torrent:set-file-priority', async (raw) => {
      if (!isRecord(raw)) throw new Error('That request was not valid.')
      await manager.setFilePriority(
        requireInfoHash(raw.infoHash),
        requireFileIndex(raw.fileIndex),
        requirePriority(raw.priority)
      )
    })
  )

  ipcMain.handle(
    IPC.TorrentSetSeedingGoal,
    action('torrent:set-seeding-goal', async (raw) => {
      if (!isRecord(raw)) throw new Error('That request was not valid.')
      let goal: SeedingGoal | null = null
      if (raw.goal !== null) {
        if (!isRecord(raw.goal)) throw new Error('That seeding goal is not valid.')
        const kind = raw.goal.kind
        if (kind !== 'ratio' && kind !== 'time' && kind !== 'forever') {
          throw new Error('That seeding goal is not valid.')
        }
        const num = (v: unknown, fallback: number, max: number) =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback
        goal = {
          kind,
          ratio: num(raw.goal.ratio, 1, 10_000),
          minutes: num(raw.goal.minutes, 30, 60 * 24 * 365)
        }
      }
      await manager.setSeedingGoal(requireInfoHash(raw.infoHash), goal)
    })
  )

  ipcMain.handle(
    IPC.TorrentOpenFolder,
    action('torrent:open-folder', async (infoHash) => {
      const path = manager.downloadPathFor(requireInfoHash(infoHash))
      const error = await shell.openPath(path)
      if (error) throw new Error('That folder could not be opened. It may have been moved.')
    })
  )

  ipcMain.handle(
    IPC.TorrentOpenFile,
    action('torrent:open-file', async (raw) => {
      if (!isRecord(raw)) throw new Error('That request was not valid.')
      const path = manager.filePathFor(
        requireInfoHash(raw.infoHash),
        requireFileIndex(raw.fileIndex)
      )
      if (!path) throw new Error('That file is not available yet.')
      // Reveal rather than launch: opening arbitrary downloaded content with its
      // default application on the user's behalf is not a decision this app
      // should make.
      shell.showItemInFolder(path)
    })
  )

  ipcMain.handle(
    IPC.TorrentCopyMagnet,
    action('torrent:copy-magnet', (infoHash) => {
      clipboard.writeText(manager.magnetFor(requireInfoHash(infoHash)))
    })
  )

  ipcMain.handle(IPC.TorrentPauseAll, action('torrent:pause-all', () => manager.pauseAll()))
  ipcMain.handle(IPC.TorrentResumeAll, action('torrent:resume-all', () => manager.resumeAll()))

  // ------------------------------------------------------------------ settings

  ipcMain.handle(IPC.SettingsGet, () => settings.get())

  ipcMain.handle(IPC.SettingsUpdate, async (_event, patch: unknown) => {
    if (!isRecord(patch)) return settings.get()
    // `applyPatch` re-validates every field, so a hostile patch cannot install
    // an out-of-range value.
    const next = await settings.update(patch as SettingsPatch)
    return next
  })

  ipcMain.handle(
    IPC.AppSetTheme,
    action('app:set-theme', async (theme) => {
      if (theme !== 'system' && theme !== 'light' && theme !== 'dark') {
        throw new Error('That theme is not valid.')
      }
      nativeTheme.themeSource = theme as ThemePreference
      await settings.update({ appearance: { theme } })
    })
  )

  // ------------------------------------------------------------------- dialogs

  ipcMain.handle(
    IPC.DialogChooseFolder,
    async (_event, currentPath: unknown): Promise<ChooseFolderResult> => {
      const window = deps.getMainWindow()
      const defaultPath =
        typeof currentPath === 'string' && currentPath.startsWith('/')
          ? currentPath
          : deps.defaultDownloadPath

      const result = window
        ? await dialog.showOpenDialog(window, {
            title: 'Choose Download Folder',
            defaultPath,
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Choose'
          })
        : await dialog.showOpenDialog({
            title: 'Choose Download Folder',
            defaultPath,
            properties: ['openDirectory', 'createDirectory']
          })

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null }
      }
      return { canceled: false, path: result.filePaths[0]! }
    }
  )

  ipcMain.handle(IPC.DialogConfirmRemove, async (_event, raw: unknown) => {
    if (!isRecord(raw)) return { confirmed: false }
    const name = typeof raw.name === 'string' ? raw.name.slice(0, 200) : 'this torrent'
    const mode = raw.mode === 'delete-files' ? 'delete-files' : 'keep-files'
    const window = deps.getMainWindow()

    const deleting = mode === 'delete-files'
    const options = {
      type: 'warning' as const,
      // Destructive action is never the default button.
      buttons: deleting ? ['Cancel', 'Delete Files'] : ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      title: deleting ? 'Remove Torrent and Delete Files' : 'Remove Torrent',
      message: deleting
        ? `Delete the downloaded files for “${name}”?`
        : `Remove “${name}” from the list?`,
      detail: deleting
        ? 'The files this torrent downloaded will be permanently deleted from your disk. This cannot be undone.'
        : 'The downloaded files will be kept on your disk.'
    }

    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)

    return { confirmed: result.response === 1 }
  })

  // ----------------------------------------------------------------- clipboard

  ipcMain.handle(IPC.ClipboardReadMagnet, () => {
    // Read on demand only. The clipboard is never polled in the background.
    const text = clipboard.readText()
    if (typeof text !== 'string' || text.length === 0) return null
    return extractMagnetUri(text)
  })

  // ---------------------------------------------------------------------- logs

  ipcMain.handle(
    IPC.LogsOpenFolder,
    action('logs:open-folder', async () => {
      const error = await shell.openPath(getLogger().directory)
      if (error) throw new Error('The logs folder could not be opened.')
    })
  )

  ipcMain.handle(IPC.LogsRead, () => getLogger().recent(500))

  // ------------------------------------------------------------------ app info

  ipcMain.handle(IPC.AppInfo, () => ({
    version: app.getVersion(),
    engineVersion: engineVersion(),
    utpSupported: engineSupportsUtp(),
    homeDir: homedir(),
    defaultDownloadPath: deps.defaultDownloadPath,
    logPath: getLogger().filePath,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node
  }))

  logger().info('IPC handlers registered')
}

/** Default download location: `~/Downloads/Torrents`. */
export function defaultDownloadPath(): string {
  try {
    return join(app.getPath('downloads'), 'Torrents')
  } catch {
    return join(homedir(), 'Downloads', 'Torrents')
  }
}
