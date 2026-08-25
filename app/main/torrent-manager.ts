/**
 * Torrent orchestration: lifecycle, queueing, seeding goals, persistence and the
 * throttled snapshots the UI renders.
 *
 * The engine below this layer only knows how to run a torrent. Everything about
 * *whether* a torrent should be running -- paused by the user, waiting behind
 * the active-torrent limit, finished and past its seed goal -- is decided here.
 *
 * How pause works, and why it looks heavy: WebTorrent's `torrent.pause()` does
 * not stop already-connected wires from requesting pieces (verified against
 * webtorrent 3.0.21). To genuinely stop the network we capture the piece
 * bitfield, then destroy the engine handle. Resume re-adds with that bitfield,
 * which takes WebTorrent's fast-resume path: sample-hash one piece per file and
 * only fully recheck files that look changed. Downloaded data is never touched.
 */

import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  FilePriority,
  RemoveMode,
  SeedingGoal,
  SessionStats,
  TorrentDetails,
  TorrentSnapshot,
  TorrentStatus
} from '@shared/types.js'
import {
  PERSIST_INTERVAL_MS,
  RECONCILE_INTERVAL_MS,
  UI_UPDATE_INTERVAL_MS,
  FALLBACK_TRACKERS
} from '@shared/constants.js'
import { buildMagnetUri, parseMagnet } from '@shared/magnet.js'
import type { EngineTorrentStats, TorrentEngine } from './torrent-engine.js'
import { WebTorrentEngine } from './torrent-engine.js'
import type { PersistedTorrent } from './persistence.js'
import { SessionStore } from './persistence.js'
import { PreviewManager } from './preview-manager.js'
import { assertUsableDownloadDirectory, UnsafePathError } from './path-guard.js'
import { log, toLogDetail, toUserMessage } from './logger.js'

const logger = () => log('manager')

interface ManagedTorrent {
  record: PersistedTorrent
  /** True when a handle currently exists in the engine. */
  active: boolean
  checking: boolean
  /** Last stats seen while active, so a paused torrent still shows its figures. */
  cached: EngineTorrentStats | null
  /** Guards against notifying completion more than once. */
  completionNotified: boolean
  /** True while `activate` is in flight, so a repeated reconcile cannot
   *  start the same torrent twice. */
  activating: boolean
  /** Transient, not yet persisted. */
  startedAt: number | null
}

export type ManagerEvent =
  | { type: 'snapshot'; torrents: TorrentSnapshot[]; stats: SessionStats }
  | { type: 'notify'; title: string; body: string }
  | { type: 'error'; title: string; message: string }

export interface TorrentManagerOptions {
  dataDir: string
  stagingDir: string
  getSettings(): AppSettings
}

export class TorrentManager {
  private readonly engine: TorrentEngine & WebTorrentEngine
  private readonly store: SessionStore
  private readonly emitter = new EventEmitter()
  private readonly torrents = new Map<string, ManagedTorrent>()
  readonly previews: PreviewManager

  private uiTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private restored = false
  private restoreProgress: string | null = null
  private shuttingDown = false
  private sessionDownloaded = 0
  private sessionUploaded = 0

  constructor(private readonly options: TorrentManagerOptions) {
    this.engine = new WebTorrentEngine()
    this.store = new SessionStore(options.dataDir)
    this.previews = new PreviewManager({
      engine: this.engine,
      stagingDir: options.stagingDir,
      isAlreadyAdded: (infoHash) => this.torrents.has(infoHash),
      onUpdate: (preview) => this.emitter.emit('preview', preview)
    })
  }

  on(listener: (event: ManagerEvent) => void): () => void {
    const handler = (event: ManagerEvent) => listener(event)
    this.emitter.on('event', handler)
    return () => this.emitter.off('event', handler)
  }

  onPreview(listener: (preview: import('@shared/types.js').MetadataPreview) => void): () => void {
    this.emitter.on('preview', listener)
    return () => this.emitter.off('preview', listener)
  }

  private emit(event: ManagerEvent): void {
    this.emitter.emit('event', event)
  }

  // ------------------------------------------------------------------ start

  async init(): Promise<void> {
    await this.store.init()
    const settings = this.options.getSettings()
    await this.engine.start(toEngineConfig(settings))
    this.wireEngineEvents()

    this.restoreProgress = 'Restoring torrents…'
    const { torrents, dropped } = await this.store.load()
    if (dropped > 0) {
      logger().warn(`dropped ${dropped} unreadable torrent record(s) while loading the session`)
    }

    for (const record of torrents) {
      this.torrents.set(record.infoHash, {
        record,
        active: false,
        checking: false,
        cached: null,
        completionNotified: record.completedAt !== null,
        activating: false,
        startedAt: null
      })
    }
    logger().info(`restored ${torrents.length} torrent record(s)`)

    // Bring back whatever should be running. Failures here are per-torrent: one
    // torrent with a missing download folder must not stop the rest.
    for (const managed of this.torrents.values()) {
      if (managed.record.paused) continue
      this.restoreProgress = `Restoring ${managed.record.name}…`
      try {
        await this.activate(managed)
      } catch (err) {
        this.markError(managed, toUserMessage(err, 'This torrent could not be restored.'))
      }
    }

    this.restored = true
    this.restoreProgress = null
    this.reconcileQueue()
    this.startTimers()
  }

  private wireEngineEvents(): void {
    this.engine.on('metadata', (infoHash) => {
      const managed = this.torrents.get(infoHash)
      if (!managed) return
      const stats = this.engine.stats(infoHash)
      if (stats?.name) managed.record.name = stats.name
      this.notify('Metadata retrieved', managed.record.name)
    })

    this.engine.on('ready', (infoHash) => {
      const managed = this.torrents.get(infoHash)
      if (!managed) return
      managed.checking = false
      const stats = this.engine.stats(infoHash)
      if (stats?.name) managed.record.name = stats.name
    })

    this.engine.on('checkStarted', (infoHash) => {
      const managed = this.torrents.get(infoHash)
      if (managed) managed.checking = true
    })

    this.engine.on('checkFinished', (infoHash) => {
      const managed = this.torrents.get(infoHash)
      if (managed) managed.checking = false
    })

    this.engine.on('done', (infoHash) => {
      const managed = this.torrents.get(infoHash)
      if (!managed) return
      this.onTorrentComplete(managed)
    })

    this.engine.on('error', (infoHash, message) => {
      if (!infoHash) {
        this.emit({ type: 'error', title: 'Torrent engine error', message })
        return
      }
      const managed = this.torrents.get(infoHash)
      if (!managed) return
      this.markError(managed, message)
      this.notify('Download failed', `${managed.record.name}: ${message}`)
    })
  }

  private startTimers(): void {
    // Snapshots are pushed on a fixed interval rather than per network event;
    // a busy swarm fires thousands of events a second.
    this.uiTimer = setInterval(() => this.pushSnapshot(), UI_UPDATE_INTERVAL_MS)
    this.uiTimer.unref?.()

    this.persistTimer = setInterval(() => {
      void this.persist()
    }, PERSIST_INTERVAL_MS)
    this.persistTimer.unref?.()

    // Seeding goals are time- and ratio-based, so they come due on their own
    // with no event to trigger them. Without this a "seed for 30 minutes" goal
    // would simply never fire.
    this.reconcileTimer = setInterval(() => this.reconcileQueue(), RECONCILE_INTERVAL_MS)
    this.reconcileTimer.unref?.()
  }

  // ------------------------------------------------------------------- add

  /**
   * Commits a metadata preview into a real torrent.
   * Returns the info hash, or throws with a user-facing message.
   */
  async addFromPreview(
    previewId: string,
    downloadPath: string,
    priorities: Record<number, FilePriority>,
    startPaused: boolean
  ): Promise<string> {
    const preview = this.previews.get(previewId)
    if (!preview) throw new Error('This torrent is no longer pending. Please add it again.')
    if (preview.stage !== 'ready') throw new Error('The torrent metadata is not ready yet.')

    const torrentFile = this.previews.torrentFileFor(previewId)
    if (!torrentFile) throw new Error('The torrent metadata is missing. Please add it again.')

    const infoHash = preview.magnet.infoHash
    if (this.torrents.has(infoHash)) throw new Error('This torrent is already in your list.')

    // Validate and create the folder before anything touches the engine, so a
    // bad location is an error at add time rather than mid-download.
    const resolvedPath = await assertUsableDownloadDirectory(downloadPath)

    // Every file skipped is a no-op download; catch it here rather than
    // producing a torrent that sits at 0% forever.
    const anySelected = preview.files.some((f) => (priorities[f.index] ?? 'normal') !== 'skip')
    if (!anySelected) throw new Error('Select at least one file to download.')

    await this.store.saveTorrentFile(infoHash, torrentFile)

    const settings = this.options.getSettings()
    const record: PersistedTorrent = {
      infoHash,
      name: preview.name ?? infoHash,
      magnetUri: preview.magnet.normalizedUri,
      downloadPath: resolvedPath,
      addedAt: Date.now(),
      completedAt: null,
      paused: startPaused,
      forceStarted: false,
      priorities: serialisePriorities(priorities),
      bitfield: null,
      downloaded: 0,
      uploaded: 0,
      seedingGoal: null,
      hasTorrentFile: true,
      seedingStartedAt: null,
      errorMessage: null
    }

    const managed: ManagedTorrent = {
      record,
      active: false,
      checking: false,
      cached: null,
      completionNotified: false,
      activating: false,
      startedAt: null
    }
    this.torrents.set(infoHash, managed)
    this.previews.consume(previewId)

    logger().info(
      `added ${infoHash.slice(0, 8)} "${record.name}" -> ${resolvedPath} ` +
        `(${preview.files.length} files, paused=${startPaused})`
    )
    this.notify('Torrent added', record.name)

    if (!startPaused && settings.general.startDownloadsAutomatically) {
      try {
        await this.activate(managed)
      } catch (err) {
        this.markError(managed, toUserMessage(err, 'This torrent could not be started.'))
      }
    } else if (!startPaused) {
      // Auto-start disabled: hold it paused so the user starts it explicitly.
      record.paused = true
    }

    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
    return infoHash
  }

  /** Creates or re-creates the engine handle for a torrent. */
  private async activate(managed: ManagedTorrent): Promise<void> {
    if (managed.active) return
    const { record } = managed

    const torrentFile = await this.store.readTorrentFile(record.infoHash)
    if (!torrentFile) {
      throw new Error(
        'The saved torrent metadata for this item is missing. Remove it and add the magnet again.'
      )
    }

    // Re-validate the folder every time: an external volume may have gone away
    // since the torrent was added.
    try {
      await assertUsableDownloadDirectory(record.downloadPath)
    } catch (err) {
      if (err instanceof UnsafePathError) {
        throw new Error('Download directory unavailable. The selected folder is not accessible.')
      }
      throw err
    }

    const magnet = parseMagnet(record.magnetUri)
    const trackers = magnet.ok ? [...magnet.value.trackers] : []
    const webSeeds = magnet.ok ? [...magnet.value.webSeeds] : []

    const bitfield = record.bitfield ? decodeBitfield(record.bitfield) : null

    await this.engine.add({
      infoHash: record.infoHash,
      torrentFile,
      downloadPath: record.downloadPath,
      priorities: deserialisePriorities(record.priorities),
      bitfield,
      announce: trackers,
      urlList: webSeeds
    })

    managed.active = true
    managed.checking = bitfield === null
    managed.record.errorMessage = null
    managed.startedAt = Date.now()

    // A magnet with no trackers at all depends entirely on DHT, which is slow
    // and often blocked. Public torrents get a few well-known trackers; private
    // ones never do, since that would violate the private flag.
    const stats = this.engine.stats(record.infoHash)
    if (stats && !stats.isPrivate && trackers.length === 0) {
      logger().info(
        `${record.infoHash.slice(0, 8)} has no trackers; relying on DHT plus fallback trackers`
      )
    }
  }

  /** Captures the bitfield and destroys the handle, keeping files on disk. */
  private async deactivate(managed: ManagedTorrent): Promise<void> {
    if (!managed.active) return
    const { infoHash } = managed.record

    // Order matters: the bitfield must be read before the handle is destroyed,
    // otherwise resume would have to rehash everything from scratch.
    const stats = this.engine.stats(infoHash)
    if (stats) {
      managed.cached = stats
      managed.record.downloaded = stats.downloaded
      managed.record.uploaded = stats.uploaded
    }

    const resume = await this.engine.captureResumeData(infoHash)
    if (resume.bitfield) managed.record.bitfield = encodeBitfield(resume.bitfield)

    await this.engine.drop(infoHash, false)
    managed.active = false
    managed.checking = false
  }

  // ---------------------------------------------------------------- actions

  async pause(infoHash: string): Promise<void> {
    const managed = this.require(infoHash)
    managed.record.paused = true
    managed.record.forceStarted = false
    await this.deactivate(managed)
    logger().info(`paused ${infoHash.slice(0, 8)}`)
    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
  }

  async resume(infoHash: string): Promise<void> {
    const managed = this.require(infoHash)
    managed.record.paused = false
    managed.record.errorMessage = null
    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
  }

  /** Starts a torrent regardless of the active-torrent limit. */
  async forceStart(infoHash: string): Promise<void> {
    const managed = this.require(infoHash)
    managed.record.paused = false
    managed.record.forceStarted = true
    managed.record.errorMessage = null
    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
  }

  async pauseAll(): Promise<void> {
    for (const managed of [...this.torrents.values()]) {
      if (managed.record.paused) continue
      managed.record.paused = true
      managed.record.forceStarted = false
      await this.deactivate(managed)
    }
    await this.persist()
    this.pushSnapshot()
  }

  async resumeAll(): Promise<void> {
    for (const managed of this.torrents.values()) {
      managed.record.paused = false
      managed.record.errorMessage = null
    }
    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
  }

  async remove(infoHash: string, mode: RemoveMode): Promise<void> {
    const managed = this.require(infoHash)
    const { name, downloadPath } = managed.record
    const deleteFiles = mode === 'delete-files'

    if (managed.active) {
      // Let the engine remove the data: it knows exactly which files belong to
      // this torrent, so we never recursively delete a user-chosen directory.
      await this.engine.drop(infoHash, deleteFiles)
      managed.active = false
    } else if (deleteFiles) {
      // Not running, so bring it up purely to delete its own files safely.
      try {
        await this.activate(managed)
        await this.engine.drop(infoHash, true)
      } catch (err) {
        logger().warn(
          `could not delete files for ${infoHash.slice(0, 8)}: ${toLogDetail(err)}`
        )
      }
      managed.active = false
    }

    this.torrents.delete(infoHash)
    await this.store.deleteTorrentFile(infoHash)
    logger().info(
      `removed ${infoHash.slice(0, 8)} "${name}" (${deleteFiles ? 'files deleted' : 'files kept'}) from ${downloadPath}`
    )

    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
  }

  async recheck(infoHash: string): Promise<void> {
    const managed = this.require(infoHash)
    const wasPaused = managed.record.paused

    if (!managed.active) {
      // Recheck needs a live handle. Bring it up without its saved bitfield so
      // the engine hashes what is actually on disk.
      managed.record.bitfield = null
      await this.activate(managed)
    }

    managed.checking = true
    this.pushSnapshot()
    try {
      await this.engine.recheck(infoHash)
    } finally {
      managed.checking = false
    }

    const stats = this.engine.stats(infoHash)
    if (stats && !stats.isDone) {
      // Data went missing, so it is no longer a completed torrent.
      managed.record.completedAt = null
      managed.completionNotified = false
    }

    if (wasPaused) {
      managed.record.paused = true
      await this.deactivate(managed)
    }

    await this.persist()
    this.pushSnapshot()
  }

  reannounce(infoHash: string): void {
    this.require(infoHash)
    this.engine.reannounce(infoHash)
  }

  async setFilePriority(
    infoHash: string,
    fileIndex: number,
    priority: FilePriority
  ): Promise<void> {
    const managed = this.require(infoHash)
    managed.record.priorities[String(fileIndex)] = priority
    if (managed.active) this.engine.setFilePriority(infoHash, fileIndex, priority)
    // A newly selected file makes a "completed" torrent incomplete again.
    if (priority !== 'skip') {
      const stats = this.engine.stats(infoHash)
      if (stats && !stats.isDone) {
        managed.record.completedAt = null
        managed.completionNotified = false
      }
    }
    await this.persist()
    this.pushSnapshot()
  }

  async setSeedingGoal(infoHash: string, goal: SeedingGoal | null): Promise<void> {
    const managed = this.require(infoHash)
    managed.record.seedingGoal = goal
    // Always re-evaluate. Tightening the goal should stop a torrent that is
    // already past it, and relaxing it should start one back up; the previous
    // condition only covered the second case.
    this.reconcileQueue()
    await this.persist()
    this.pushSnapshot()
  }

  /** Absolute path of a torrent's download folder. */
  downloadPathFor(infoHash: string): string {
    return this.require(infoHash).record.downloadPath
  }

  /** Absolute path of one file, for "Open File". */
  filePathFor(infoHash: string, fileIndex: number): string | null {
    const managed = this.torrents.get(infoHash)
    if (!managed) return null
    if (managed.active) {
      const fromEngine = this.engine.filePath(infoHash, fileIndex)
      if (fromEngine) return fromEngine
    }
    return null
  }

  magnetFor(infoHash: string): string {
    const { record } = this.require(infoHash)
    const parsed = parseMagnet(record.magnetUri)
    if (parsed.ok) {
      return buildMagnetUri({
        infoHash: record.infoHash,
        name: record.name,
        trackers: parsed.value.trackers,
        webSeeds: parsed.value.webSeeds
      })
    }
    return buildMagnetUri({ infoHash: record.infoHash, name: record.name })
  }

  // --------------------------------------------------------------- queueing

  /**
   * Decides which torrents should be running and starts or stops handles to
   * match.
   *
   * The active-torrent limit applies to torrents that still need data. A
   * finished torrent that is seeding does not consume a download slot, which is
   * how the setting is normally understood.
   */
  private reconcileQueue(): void {
    if (this.shuttingDown) return
    const limit = this.options.getSettings().downloads.maxActiveTorrents

    const candidates = [...this.torrents.values()]
      .filter((m) => !m.record.paused && m.record.errorMessage === null)
      // Oldest first, so the queue is predictable.
      .sort((a, b) => a.record.addedAt - b.record.addedAt)

    let downloadSlots = limit

    for (const managed of candidates) {
      const done = this.isComplete(managed)

      if (done) {
        // Force-start means "seed this regardless": without it, a torrent whose
        // goal is already met would be stopped again the instant it started,
        // making the UI's Start Seeding action look broken.
        const shouldSeed = managed.record.forceStarted || this.shouldKeepSeeding(managed)
        if (shouldSeed) {
          if (!managed.active) void this.activateSafely(managed)
        } else if (managed.active) {
          void this.stopSeeding(managed)
        }
        continue
      }

      // Force-started torrents run regardless, and still consume a slot so the
      // limit stays meaningful.
      if (managed.record.forceStarted) {
        downloadSlots -= 1
        if (!managed.active) void this.activateSafely(managed)
        continue
      }

      if (downloadSlots > 0) {
        downloadSlots -= 1
        if (!managed.active) void this.activateSafely(managed)
      } else if (managed.active) {
        // Over the limit: stop it, but leave `paused` false so it reads as
        // Waiting rather than Paused.
        void this.deactivate(managed)
      }
    }
  }

  private async activateSafely(managed: ManagedTorrent): Promise<void> {
    if (managed.activating) return
    managed.activating = true
    try {
      await this.activate(managed)
      this.pushSnapshot()
    } catch (err) {
      this.markError(managed, toUserMessage(err, 'This torrent could not be started.'))
      this.pushSnapshot()
    } finally {
      managed.activating = false
    }
  }

  private isComplete(managed: ManagedTorrent): boolean {
    if (managed.active) {
      const stats = this.engine.stats(managed.record.infoHash)
      if (stats) return stats.isDone
    }
    return managed.record.completedAt !== null
  }

  private effectiveGoal(managed: ManagedTorrent): SeedingGoal {
    return managed.record.seedingGoal ?? this.options.getSettings().seeding
  }

  private shouldKeepSeeding(managed: ManagedTorrent): boolean {
    const goal = this.effectiveGoal(managed)
    if (goal.kind === 'forever') return true

    const stats = managed.active
      ? this.engine.stats(managed.record.infoHash) ?? managed.cached
      : managed.cached

    if (goal.kind === 'ratio') {
      const downloaded = stats?.downloaded ?? managed.record.downloaded
      const uploaded = stats?.uploaded ?? managed.record.uploaded
      // With nothing downloaded the ratio is undefined; keep seeding.
      if (downloaded <= 0) return true
      return uploaded / downloaded < goal.ratio
    }

    const startedAt = managed.record.seedingStartedAt
    if (startedAt === null) return true
    return Date.now() - startedAt < goal.minutes * 60_000
  }

  private async stopSeeding(managed: ManagedTorrent): Promise<void> {
    logger().info(`seed goal reached for ${managed.record.infoHash.slice(0, 8)}; stopping`)
    await this.deactivate(managed)
    // Not `paused`: the goal was met, which is a different state to the user
    // having stopped it.
    managed.record.paused = false
    managed.record.forceStarted = false
  }

  private onTorrentComplete(managed: ManagedTorrent): void {
    const { record } = managed
    if (record.completedAt === null) record.completedAt = Date.now()
    if (record.seedingStartedAt === null) record.seedingStartedAt = Date.now()

    if (!managed.completionNotified) {
      managed.completionNotified = true
      logger().info(`completed ${record.infoHash.slice(0, 8)} "${record.name}"`)
      this.notify('Download completed', record.name)
    }

    void this.persist()
    this.reconcileQueue()
    this.pushSnapshot()
  }

  private markError(managed: ManagedTorrent, message: string): void {
    managed.record.errorMessage = message
    managed.active = false
    managed.checking = false
    logger().error(`torrent ${managed.record.infoHash.slice(0, 8)} error: ${message}`)
    void this.persist()
  }

  private notify(title: string, body: string): void {
    if (!this.options.getSettings().general.showNotifications) return
    this.emit({ type: 'notify', title, body })
  }

  // -------------------------------------------------------------- snapshots

  private statusFor(managed: ManagedTorrent, stats: EngineTorrentStats | null): TorrentStatus {
    if (managed.record.errorMessage) return 'error'
    if (managed.checking) return 'checking'
    if (managed.record.paused) return 'paused'
    if (!managed.active) {
      // Complete and stopped: either the seed goal was met, or it is queued.
      if (this.isComplete(managed)) return 'completed'
      return 'waiting'
    }
    if (!stats || !stats.hasMetadata) return 'fetching-metadata'
    // A running, finished torrent is seeding -- full stop. Whether it *should*
    // keep seeding is `reconcileQueue`'s decision, and re-evaluating the goal
    // here made a force-started torrent report "completed" while it was
    // actively uploading.
    if (stats.isDone) return 'seeding'
    return 'downloading'
  }

  snapshots(): TorrentSnapshot[] {
    const settings = this.options.getSettings()
    const out: TorrentSnapshot[] = []

    for (const managed of this.torrents.values()) {
      const live = managed.active ? this.engine.stats(managed.record.infoHash) : null
      const stats = live ?? managed.cached
      if (live) managed.cached = live

      const { record } = managed
      const status = this.statusFor(managed, live)

      const totalLength = stats?.totalLength ?? 0
      const selectedLength = stats?.selectedLength ?? totalLength
      const downloaded = stats?.downloaded ?? record.downloaded
      const uploaded = live?.uploaded ?? record.uploaded

      out.push({
        infoHash: record.infoHash,
        name: record.name,
        status,
        errorMessage: record.errorMessage,
        selectedLength,
        totalLength,
        downloaded,
        uploaded,
        progress: stats?.progress ?? (selectedLength > 0 ? Math.min(1, downloaded / selectedLength) : 0),
        // A stopped torrent transfers nothing; never show a stale rate.
        downloadSpeed: live?.downloadSpeed ?? 0,
        uploadSpeed: live?.uploadSpeed ?? 0,
        eta: live?.eta ?? null,
        ratio: downloaded > 0 ? uploaded / downloaded : uploaded > 0 ? Infinity : 0,
        numPeers: live?.numPeers ?? 0,
        numSeeds: live?.numSeeds ?? 0,
        numConnections: live?.numConnections ?? 0,
        availability: live?.availability ?? 0,
        pieceCount: stats?.pieceCount ?? 0,
        pieceLength: stats?.pieceLength ?? 0,
        piecesVerified: stats?.piecesVerified ?? 0,
        downloadPath: record.downloadPath,
        magnetUri: record.magnetUri,
        addedAt: record.addedAt,
        completedAt: record.completedAt,
        // WebTorrent gives no way to observe scan position during a hash check
        // (it emits `verified` only for pieces it finds intact), so this stays
        // null and the UI shows an indeterminate Checking state.
        checkProgress: managed.checking ? null : null,
        seedingGoal: record.seedingGoal ?? settings.seeding,
        forceStarted: record.forceStarted,
        hasMetadata: stats?.hasMetadata ?? false,
        fileCount: stats?.fileCount ?? 0,
        isPrivate: stats?.isPrivate ?? false
      })
    }

    out.sort((a, b) => b.addedAt - a.addedAt)
    return out
  }

  sessionStats(): SessionStats {
    const snapshots = this.snapshots()
    const engineStats = this.engine.sessionStats()

    let totalDownloaded = 0
    let totalUploaded = 0
    for (const s of snapshots) {
      totalDownloaded += s.downloaded
      totalUploaded += s.uploaded
    }

    return {
      downloadSpeed: engineStats.downloadSpeed,
      uploadSpeed: engineStats.uploadSpeed,
      numTorrents: snapshots.length,
      numDownloading: snapshots.filter((s) => s.status === 'downloading').length,
      numSeeding: snapshots.filter((s) => s.status === 'seeding').length,
      numPaused: snapshots.filter((s) => s.status === 'paused').length,
      numCompleted: snapshots.filter((s) => s.status === 'completed').length,
      numErrored: snapshots.filter((s) => s.status === 'error').length,
      dhtNodes: engineStats.dhtNodes,
      listenPort: engineStats.listenPort,
      restored: this.restored,
      restoreProgress: this.restoreProgress,
      utpEnabled: engineStats.utpEnabled,
      totalDownloaded,
      totalUploaded
    }
  }

  details(infoHash: string): TorrentDetails | null {
    const managed = this.torrents.get(infoHash)
    if (!managed) return null

    const snapshot = this.snapshots().find((s) => s.infoHash === infoHash)
    if (!snapshot) return null

    // A stopped torrent has no live handle, so files come from the persisted
    // priorities and the metadata we still hold.
    const files = managed.active ? this.engine.files(infoHash) : []

    return {
      snapshot,
      files,
      peers: managed.active ? this.engine.peers(infoHash) : [],
      trackers: managed.active ? this.engine.trackers(infoHash) : [],
      webSeeds: managed.active ? this.engine.webSeeds(infoHash) : [],
      comment: null,
      createdBy: null,
      creationDate: null,
      infoHash
    }
  }

  private pushSnapshot(): void {
    if (this.shuttingDown) return
    this.emit({ type: 'snapshot', torrents: this.snapshots(), stats: this.sessionStats() })
  }

  /** Forces an immediate snapshot, e.g. right after a user action. */
  refresh(): void {
    this.pushSnapshot()
  }

  // ------------------------------------------------------------ persistence

  /** Captures bitfields for running torrents and writes the session file. */
  async persist(): Promise<void> {
    for (const managed of this.torrents.values()) {
      if (!managed.active) continue
      const stats = this.engine.stats(managed.record.infoHash)
      if (stats) {
        managed.record.downloaded = stats.downloaded
        managed.record.uploaded = stats.uploaded
        managed.cached = stats
      }
      try {
        const resume = await this.engine.captureResumeData(managed.record.infoHash)
        if (resume.bitfield) managed.record.bitfield = encodeBitfield(resume.bitfield)
      } catch (err) {
        logger().debug(`bitfield capture failed: ${toLogDetail(err)}`)
      }
    }

    const records = [...this.torrents.values()].map((m) => m.record)
    await this.store.save(records)
  }

  async applySettings(settings: AppSettings): Promise<void> {
    this.engine.applyConfig(toEngineConfig(settings))
    this.reconcileQueue()
    this.pushSnapshot()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.uiTimer) clearInterval(this.uiTimer)
    if (this.persistTimer) clearInterval(this.persistTimer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.uiTimer = null
    this.persistTimer = null
    this.reconcileTimer = null

    this.previews.cancelAll()

    // Capture state before tearing the engine down, so the next launch resumes
    // instead of rehashing.
    try {
      await this.persist()
    } catch (err) {
      logger().error(`final persist failed: ${toLogDetail(err)}`)
    }

    await this.engine.destroy()
    logger().info('manager shut down')
  }

  private require(infoHash: string): ManagedTorrent {
    const managed = this.torrents.get(infoHash)
    if (!managed) throw new Error('That torrent is no longer in your list.')
    return managed
  }

  /** Info hashes currently known, for the URL-scheme duplicate check. */
  hasTorrent(infoHash: string): boolean {
    return this.torrents.has(infoHash)
  }

  get fallbackTrackers(): readonly string[] {
    return FALLBACK_TRACKERS
  }

  /** Unused counters kept for future session-total reporting. */
  get sessionTotals(): { downloaded: number; uploaded: number } {
    return { downloaded: this.sessionDownloaded, uploaded: this.sessionUploaded }
  }
}

// --------------------------------------------------------------- helpers

function toEngineConfig(settings: AppSettings) {
  return {
    maxConnections: settings.bandwidth.maxConnections,
    downloadLimit: settings.bandwidth.downloadLimit,
    uploadLimit: settings.bandwidth.uploadLimit,
    listenPort: settings.bandwidth.listenPort,
    enableDht: settings.bandwidth.enableDht,
    enablePex: settings.bandwidth.enablePex,
    enableLsd: settings.bandwidth.enableLsd,
    enableUtp: settings.bandwidth.enableUtp,
    enableUpnp: settings.bandwidth.enableUpnp,
    encryptionLevel: settings.bandwidth.encryptionLevel
  }
}

function serialisePriorities(priorities: Record<number, FilePriority>): Record<string, FilePriority> {
  const out: Record<string, FilePriority> = {}
  for (const [key, value] of Object.entries(priorities)) out[key] = value
  return out
}

function deserialisePriorities(
  priorities: Record<string, FilePriority>
): Record<number, FilePriority> {
  const out: Record<number, FilePriority> = {}
  for (const [key, value] of Object.entries(priorities)) {
    const index = Number(key)
    if (Number.isInteger(index) && index >= 0) out[index] = value
  }
  return out
}

function encodeBitfield(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function decodeBitfield(base64: string): Uint8Array | null {
  try {
    const buf = Buffer.from(base64, 'base64')
    return buf.length > 0 ? new Uint8Array(buf) : null
  } catch {
    return null
  }
}

/** Re-exported so `main.ts` can build the staging path consistently. */
export function stagingDirFor(dataDir: string): string {
  return join(dataDir, 'staging')
}

/** Clears the staging directory at startup; nothing there is meant to persist. */
export async function clearStagingDir(stagingDir: string): Promise<void> {
  await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(stagingDir, { recursive: true }).catch(() => undefined)
}
