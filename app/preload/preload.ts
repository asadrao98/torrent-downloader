/**
 * The only bridge between the renderer and the main process.
 *
 * The renderer runs sandboxed with `contextIsolation: true` and
 * `nodeIntegration: false`, so it has no filesystem, no child processes and no
 * network beyond what this file exposes. Every method here is an explicit,
 * named operation -- there is deliberately no generic `invoke(channel, args)`
 * escape hatch, because that would hand the renderer the whole main-process
 * surface and make the sandbox decorative.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants.js'
import type {
  AppSettings,
  ChooseFolderResult,
  FilePriority,
  LogEntry,
  MagnetParseResult,
  MetadataPreview,
  OperationResult,
  RemoveMode,
  SeedingGoal,
  SessionStats,
  SettingsPatch,
  ThemePreference,
  TorrentDetails,
  TorrentSnapshot
} from '../shared/types.js'

/** Wraps an event subscription so the renderer always gets an unsubscribe fn. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  // ------------------------------------------------------------- magnet flow
  parseMagnet: (uri: string): Promise<MagnetParseResult> =>
    ipcRenderer.invoke(IPC.MagnetParse, uri),

  startPreview: (source: string): Promise<MetadataPreview> =>
    ipcRenderer.invoke(IPC.PreviewStart, source),

  /** Starts a preview from dropped `.torrent` bytes. */
  startPreviewFromFile: (bytes: Uint8Array): Promise<MetadataPreview> =>
    ipcRenderer.invoke(IPC.TorrentFileRead, bytes),

  cancelPreview: (previewId: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.PreviewCancel, previewId),

  commitPreview: (request: {
    previewId: string
    downloadPath: string
    priorities: Record<number, FilePriority>
    startPaused: boolean
  }): Promise<OperationResult> => ipcRenderer.invoke(IPC.PreviewCommit, request),

  // ---------------------------------------------------------------- torrents
  listTorrents: (): Promise<{ torrents: TorrentSnapshot[]; stats: SessionStats }> =>
    ipcRenderer.invoke(IPC.TorrentList),

  torrentDetails: (infoHash: string): Promise<TorrentDetails | null> =>
    ipcRenderer.invoke(IPC.TorrentDetails, infoHash),

  pause: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentPause, infoHash),

  resume: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentResume, infoHash),

  forceStart: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentForceStart, infoHash),

  remove: (infoHash: string, mode: RemoveMode): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentRemove, { infoHash, mode }),

  recheck: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentRecheck, infoHash),

  reannounce: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentReannounce, infoHash),

  setFilePriority: (
    infoHash: string,
    fileIndex: number,
    priority: FilePriority
  ): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentSetFilePriority, { infoHash, fileIndex, priority }),

  setSeedingGoal: (infoHash: string, goal: SeedingGoal | null): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentSetSeedingGoal, { infoHash, goal }),

  openDownloadFolder: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentOpenFolder, infoHash),

  openFile: (infoHash: string, fileIndex: number): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentOpenFile, { infoHash, fileIndex }),

  copyMagnet: (infoHash: string): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.TorrentCopyMagnet, infoHash),

  pauseAll: (): Promise<OperationResult> => ipcRenderer.invoke(IPC.TorrentPauseAll),
  resumeAll: (): Promise<OperationResult> => ipcRenderer.invoke(IPC.TorrentResumeAll),

  // ---------------------------------------------------------------- settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SettingsGet),
  updateSettings: (patch: SettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SettingsUpdate, patch),
  setTheme: (theme: ThemePreference): Promise<OperationResult> =>
    ipcRenderer.invoke(IPC.AppSetTheme, theme),

  // ----------------------------------------------------------------- dialogs
  chooseFolder: (currentPath?: string): Promise<ChooseFolderResult> =>
    ipcRenderer.invoke(IPC.DialogChooseFolder, currentPath),

  confirmRemoval: (payload: {
    name: string
    mode: RemoveMode
  }): Promise<{ confirmed: boolean }> => ipcRenderer.invoke(IPC.DialogConfirmRemove, payload),

  // --------------------------------------------------------------- clipboard
  readMagnetFromClipboard: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.ClipboardReadMagnet),

  // -------------------------------------------------------------------- logs
  openLogsFolder: (): Promise<OperationResult> => ipcRenderer.invoke(IPC.LogsOpenFolder),
  readLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke(IPC.LogsRead),

  // --------------------------------------------------------------- app info
  appInfo: (): Promise<{
    version: string
    engineVersion: string
    utpSupported: boolean
    homeDir: string
    defaultDownloadPath: string
    logPath: string
    platform: string
    arch: string
    electronVersion: string
    nodeVersion: string
  }> => ipcRenderer.invoke(IPC.AppInfo),

  // ------------------------------------------------------------------ events
  onTorrentsUpdate: (
    handler: (payload: { torrents: TorrentSnapshot[]; stats: SessionStats }) => void
  ): (() => void) => subscribe(IPC.EventTorrentsUpdate, handler),

  onPreviewUpdate: (handler: (preview: MetadataPreview) => void): (() => void) =>
    subscribe(IPC.EventPreviewUpdate, handler),

  onSettingsChanged: (handler: (settings: AppSettings) => void): (() => void) =>
    subscribe(IPC.EventSettingsChanged, handler),

  onLogEntry: (handler: (entry: LogEntry) => void): (() => void) =>
    subscribe(IPC.EventLogEntry, handler),

  onNavigate: (handler: (payload: { route: string }) => void): (() => void) =>
    subscribe(IPC.EventNavigate, handler),

  onExternalMagnet: (
    handler: (payload: { uri: string; requiresConfirmation: boolean }) => void
  ): (() => void) => subscribe(IPC.EventMagnetExternal, handler),

  onErrorDialog: (handler: (payload: { title: string; message: string }) => void): (() => void) =>
    subscribe(IPC.EventDialogError, handler)
} as const

export type TorrentDownloaderApi = typeof api

contextBridge.exposeInMainWorld('torrentApi', api)
