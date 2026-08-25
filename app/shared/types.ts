/**
 * Types shared between the main process, the preload bridge and the renderer.
 * This module MUST stay free of any Node or DOM imports so both sides can use it.
 */

export type TorrentStatus =
  | 'waiting'            // queued behind maxActiveTorrents
  | 'fetching-metadata'  // magnet added, pulling the info dict from peers via ut_metadata
  | 'checking'           // hashing existing data on disk (resume or explicit recheck)
  | 'downloading'
  | 'seeding'
  | 'completed'          // finished and no longer seeding (ratio/time goal met, or seeding off)
  | 'paused'
  | 'error'

export const TORRENT_STATUSES: readonly TorrentStatus[] = [
  'waiting',
  'fetching-metadata',
  'checking',
  'downloading',
  'seeding',
  'completed',
  'paused',
  'error'
]

/** Per-file download priority. `skip` means the file is deselected entirely. */
export type FilePriority = 'skip' | 'low' | 'normal' | 'high'

export const FILE_PRIORITIES: readonly FilePriority[] = ['skip', 'low', 'normal', 'high']

/** Maps our priority names onto the numeric priority WebTorrent's `file.select()` takes. */
export const FILE_PRIORITY_WEIGHT: Record<Exclude<FilePriority, 'skip'>, number> = {
  low: 0,
  normal: 1,
  high: 2
}

// ---------------------------------------------------------------------------
// Magnet parsing
// ---------------------------------------------------------------------------

export interface ParsedMagnet {
  /** 40-character lowercase hex info hash (v1 / BTIH). */
  infoHash: string
  /** `dn` display name, if the magnet carried one. */
  name: string | null
  /** `tr` tracker announce URLs, deduped, only http/https/udp/ws/wss. */
  trackers: string[]
  /** `ws` web seed URLs (BEP 19), only http/https. */
  webSeeds: string[]
  /** `x.pe` peer addresses, `host:port`. */
  peerAddresses: string[]
  /** `kt` keyword topic. */
  keywords: string[]
  /** `xl` exact length in bytes, if present. */
  exactLength: number | null
  /** The normalised magnet URI we will actually hand to the engine. */
  normalizedUri: string
  /** Parameters we recognised but do not act on, for display in the details panel. */
  extraParams: Array<{ key: string; value: string }>
}

export type MagnetParseFailureCode =
  | 'empty'
  | 'not-a-magnet'
  | 'malformed-uri'
  | 'missing-info-hash'
  | 'invalid-info-hash'
  | 'unsupported-info-hash-version'

export type MagnetParseResult =
  | { ok: true; value: ParsedMagnet }
  | { ok: false; code: MagnetParseFailureCode; message: string }

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface TorrentFileInfo {
  index: number
  /** Sanitised path relative to the torrent root, using forward slashes. */
  path: string
  /** Final path component. */
  name: string
  length: number
  /** Bytes of this file verified on disk. */
  downloaded: number
  /** 0..1 */
  progress: number
  priority: FilePriority
  /** True when the file was renamed during sanitisation (illegal or traversing path). */
  sanitized: boolean
  /** Original, untrusted path exactly as it appeared in the torrent metadata. */
  originalPath: string
}

/** A node in the file tree the metadata screen renders. */
export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  length: number
  /** Only set for files. */
  fileIndex?: number
  children?: FileTreeNode[]
}

// ---------------------------------------------------------------------------
// Peers / trackers
// ---------------------------------------------------------------------------

export interface PeerInfo {
  /** `ip:port`. Reported by the engine; may be a hostname for web seeds. */
  address: string
  /** How the peer was discovered / what transport it uses, e.g. `tcpOutgoing`. */
  type: string
  /** Peer's client name from the extended handshake, when it sent one. */
  client: string | null
  /** 0..1, from the peer's bitfield. */
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  /** True when this connection negotiated MSE/PE encryption. */
  encrypted: boolean
  /** We are choking them / they are choking us. */
  choking: boolean
  choked: boolean
}

export type TrackerStatus = 'working' | 'announcing' | 'idle' | 'error' | 'disabled'

export interface TrackerInfo {
  url: string
  status: TrackerStatus
  /** Last message from the tracker, error text included. */
  message: string | null
  seeds: number | null
  peers: number | null
  /** Epoch ms. */
  lastAnnounce: number | null
  nextAnnounce: number | null
}

// ---------------------------------------------------------------------------
// Torrents
// ---------------------------------------------------------------------------

/**
 * The throttled per-torrent snapshot pushed to the renderer. Everything the
 * torrent list and details panel need, and nothing that requires a round trip.
 */
export interface TorrentSnapshot {
  infoHash: string
  name: string
  status: TorrentStatus
  /** Set when status === 'error'. User-facing text, never a raw stack. */
  errorMessage: string | null

  /** Total length of *selected* files. */
  selectedLength: number
  /** Total length of every file in the torrent. */
  totalLength: number
  /** Verified bytes belonging to selected files. */
  downloaded: number
  uploaded: number
  /** 0..1, over the selected files. */
  progress: number

  downloadSpeed: number
  uploadSpeed: number
  /** Seconds remaining, or null when unknown / not downloading. */
  eta: number | null
  ratio: number

  numPeers: number
  numSeeds: number
  /** Wires currently connected. */
  numConnections: number
  /** Average copies of the swarm's pieces visible to us. */
  availability: number

  pieceCount: number
  pieceLength: number
  /** Count of verified pieces. */
  piecesVerified: number

  downloadPath: string
  magnetUri: string
  addedAt: number
  completedAt: number | null

  /** True while a hash check is running; `checkProgress` is 0..1. */
  checkProgress: number | null

  seedingGoal: SeedingGoal
  /** Whether the user force-started this, bypassing the active-torrent queue. */
  forceStarted: boolean

  hasMetadata: boolean
  fileCount: number
  isPrivate: boolean
}

/** The fuller payload for the details panel, fetched on demand. */
export interface TorrentDetails {
  snapshot: TorrentSnapshot
  files: TorrentFileInfo[]
  peers: PeerInfo[]
  trackers: TrackerInfo[]
  webSeeds: string[]
  comment: string | null
  createdBy: string | null
  creationDate: number | null
  infoHash: string
}

// ---------------------------------------------------------------------------
// Metadata preview (the screen between "paste magnet" and "start download")
// ---------------------------------------------------------------------------

export type PreviewStage = 'validating' | 'connecting' | 'fetching-metadata' | 'ready' | 'error'

export interface MetadataPreview {
  /** Correlates the preview with the pending engine handle in the main process. */
  previewId: string
  stage: PreviewStage
  /** Progress text for the "Retrieving torrent metadata..." UI. */
  statusText: string
  magnet: ParsedMagnet
  /** Populated once stage === 'ready'. */
  name: string | null
  totalLength: number | null
  fileCount: number | null
  files: TorrentFileInfo[]
  tree: FileTreeNode | null
  pieceCount: number | null
  pieceLength: number | null
  isPrivate: boolean
  comment: string | null
  createdBy: string | null
  creationDate: number | null
  /** Number of peers we are talking to while fetching metadata. */
  numPeers: number
  errorMessage: string | null
  /** True when this torrent is already in the session. */
  alreadyAdded: boolean
}

/** What the renderer sends to actually start the download. */
export interface CommitPreviewRequest {
  previewId: string
  downloadPath: string
  /** Priority per file index. Files absent from the map default to `normal`. */
  priorities: Record<number, FilePriority>
  startPaused: boolean
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark'

export type SeedingGoalKind = 'ratio' | 'time' | 'forever'

export interface SeedingGoal {
  kind: SeedingGoalKind
  /** Upload/download ratio to stop at, when kind === 'ratio'. */
  ratio: number
  /** Minutes to seed for, when kind === 'time'. */
  minutes: number
}

export interface GeneralSettings {
  launchAtLogin: boolean
  startDownloadsAutomatically: boolean
  showNotifications: boolean
  confirmTorrentRemoval: boolean
  showInMenuBar: boolean
  /** When a magnet arrives via the `magnet:` URL scheme or a dropped file. */
  confirmExternalMagnets: boolean
}

export interface DownloadSettings {
  defaultPath: string
  askForLocation: boolean
  maxActiveTorrents: number
}

export interface BandwidthSettings {
  /** Bytes/second. -1 means unlimited. */
  downloadLimit: number
  uploadLimit: number
  maxConnections: number
  /** BitTorrent listen port. 0 = let the OS choose. */
  listenPort: number
  enableDht: boolean
  enablePex: boolean
  enableLsd: boolean
  enableUtp: boolean
  enableUpnp: boolean
  /** 0 = no encryption, 1 = prefer encryption with plaintext fallback, 2 = require. */
  encryptionLevel: 0 | 1 | 2
}

export interface AppearanceSettings {
  theme: ThemePreference
}

export interface AdvancedSettings {
  /** Verbose engine logging to the log file. */
  verboseLogging: boolean
}

export interface AppSettings {
  general: GeneralSettings
  downloads: DownloadSettings
  bandwidth: BandwidthSettings
  seeding: SeedingGoal
  appearance: AppearanceSettings
  advanced: AdvancedSettings
}

/** A deep-partial patch, which is what `settings:update` accepts. */
export type SettingsPatch = {
  [K in keyof AppSettings]?: Partial<AppSettings[K]>
}

// ---------------------------------------------------------------------------
// Engine / session status
// ---------------------------------------------------------------------------

export interface SessionStats {
  downloadSpeed: number
  uploadSpeed: number
  numTorrents: number
  numDownloading: number
  numSeeding: number
  numPaused: number
  numCompleted: number
  numErrored: number
  /** Nodes in the DHT routing table, or null when DHT is disabled. */
  dhtNodes: number | null
  listenPort: number | null
  /** True once the engine has finished restoring persisted torrents. */
  restored: boolean
  /** Set while restoring, for the "Restoring torrents..." splash. */
  restoreProgress: string | null
  utpEnabled: boolean
  totalDownloaded: number
  totalUploaded: number
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  time: number
  level: LogLevel
  scope: string
  message: string
}

// ---------------------------------------------------------------------------
// IPC payloads
// ---------------------------------------------------------------------------

export interface AddTorrentRequest {
  /** A magnet URI, or the absolute path of a `.torrent` file. */
  source: string
  /** Raw bytes of a dropped `.torrent` file, when the renderer has them. */
  torrentFileBytes?: Uint8Array
}

export type RemoveMode = 'keep-files' | 'delete-files'

export interface OperationResult {
  ok: boolean
  /** User-facing error text when ok === false. */
  error?: string
  /** Machine-readable code for the renderer to branch on. */
  code?: string
}

export interface ChooseFolderResult {
  canceled: boolean
  path: string | null
}

/** Filters for the torrent list sidebar. */
export type TorrentFilter = 'all' | 'downloading' | 'seeding' | 'completed' | 'paused' | 'errors'

export interface NotificationPayload {
  title: string
  body: string
}

/** Events the main process pushes to the renderer. */
export interface MainToRendererEvents {
  'torrents:update': { torrents: TorrentSnapshot[]; stats: SessionStats }
  'preview:update': MetadataPreview
  'settings:changed': AppSettings
  'log:entry': LogEntry
  'nav:goto': { route: string }
  /** A magnet arrived from outside the app (URL scheme, dropped file, second instance). */
  'magnet:external': { uri: string; requiresConfirmation: boolean }
  'dialog:error': { title: string; message: string }
}
