/** Shared constants and IPC channel names. No Node/DOM imports. */

import type { AppSettings } from './types.js'

export const APP_NAME = 'Torrent Downloader'
export const APP_ID = 'com.local.torrent-downloader'

/** How often the main process pushes a torrent snapshot to the renderer. */
export const UI_UPDATE_INTERVAL_MS = 500
/** How often we persist torrent state (bitfields are the expensive part). */
export const PERSIST_INTERVAL_MS = 15_000
/**
 * How often the queue and seeding goals are re-evaluated. Ratio and time goals
 * come due on their own, with no event to trigger them, so this has to be a
 * timer rather than purely event-driven.
 */
export const RECONCILE_INTERVAL_MS = 3_000
/** Peers/trackers tabs poll faster only while the details panel is open. */
export const DETAILS_POLL_INTERVAL_MS = 1_000

/** Sentinel for "no limit" in bandwidth settings. */
export const UNLIMITED = -1

export const BYTES_PER_KB = 1024
export const BYTES_PER_MB = 1024 * 1024

/** Guards against a runaway torrent list in the UI. */
export const MAX_PEERS_IN_DETAILS = 200

/** Timeout for pulling the info dict off the swarm before we give up. */
export const METADATA_TIMEOUT_MS = 120_000
/** How long we wait before telling the user we cannot find any peers at all. */
export const NO_PEERS_WARNING_MS = 30_000

/**
 * Trackers appended to non-private magnets that arrive with no announce list.
 * A magnet with only an info hash relies on DHT alone, which is slow and often
 * fails behind NAT; these are long-standing public trackers. Private torrents
 * never receive extra trackers (that would violate the private flag).
 */
export const FALLBACK_TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
]

export const DEFAULT_SETTINGS: Omit<AppSettings, 'downloads'> & {
  downloads: Omit<AppSettings['downloads'], 'defaultPath'>
} = {
  general: {
    launchAtLogin: false,
    startDownloadsAutomatically: true,
    showNotifications: true,
    confirmTorrentRemoval: true,
    showInMenuBar: true,
    confirmExternalMagnets: true
  },
  downloads: {
    askForLocation: false,
    maxActiveTorrents: 5
  },
  bandwidth: {
    downloadLimit: UNLIMITED,
    uploadLimit: UNLIMITED,
    maxConnections: 200,
    listenPort: 0,
    enableDht: true,
    enablePex: true,
    enableLsd: true,
    enableUtp: true,
    enableUpnp: true,
    encryptionLevel: 1
  },
  seeding: {
    kind: 'ratio',
    ratio: 1,
    minutes: 30
  },
  appearance: {
    theme: 'system'
  },
  advanced: {
    verboseLogging: false
  }
}

/** Every IPC channel, in one place, so the preload allowlist cannot drift. */
export const IPC = {
  // renderer -> main (invoke)
  MagnetParse: 'magnet:parse',
  PreviewStart: 'preview:start',
  PreviewCancel: 'preview:cancel',
  PreviewCommit: 'preview:commit',
  TorrentList: 'torrent:list',
  TorrentDetails: 'torrent:details',
  TorrentPause: 'torrent:pause',
  TorrentResume: 'torrent:resume',
  TorrentForceStart: 'torrent:force-start',
  TorrentRemove: 'torrent:remove',
  TorrentRecheck: 'torrent:recheck',
  TorrentReannounce: 'torrent:reannounce',
  TorrentSetFilePriority: 'torrent:set-file-priority',
  TorrentSetSeedingGoal: 'torrent:set-seeding-goal',
  TorrentOpenFolder: 'torrent:open-folder',
  TorrentOpenFile: 'torrent:open-file',
  TorrentCopyMagnet: 'torrent:copy-magnet',
  TorrentPauseAll: 'torrent:pause-all',
  TorrentResumeAll: 'torrent:resume-all',
  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  DialogChooseFolder: 'dialog:choose-folder',
  DialogConfirmRemove: 'dialog:confirm-remove',
  ClipboardReadMagnet: 'clipboard:read-magnet',
  LogsOpenFolder: 'logs:open-folder',
  LogsRead: 'logs:read',
  AppInfo: 'app:info',
  AppSetTheme: 'app:set-theme',
  TorrentFileRead: 'torrent-file:read',

  // main -> renderer (send)
  EventTorrentsUpdate: 'torrents:update',
  EventPreviewUpdate: 'preview:update',
  EventSettingsChanged: 'settings:changed',
  EventLogEntry: 'log:entry',
  EventNavigate: 'nav:goto',
  EventMagnetExternal: 'magnet:external',
  EventDialogError: 'dialog:error'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
