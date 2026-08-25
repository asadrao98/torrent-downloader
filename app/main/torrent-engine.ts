/**
 * The BitTorrent engine boundary.
 *
 * Everything WebTorrent-specific lives behind `TorrentEngine`. Nothing above
 * this file imports `webtorrent`, so the engine can be replaced (with a
 * libtorrent or librqbit sidecar, say) by writing one more implementation of
 * this interface.
 *
 * Two engine behaviours drove the design here, both verified against
 * webtorrent 3.0.21 rather than assumed:
 *
 *  1. `torrent.pause()` does NOT stop transfers. It blocks new peers and new
 *     outgoing connections, but the piece-request loop never consults the flag,
 *     so already-connected wires keep downloading. A pause that actually stops
 *     the network therefore has to destroy the torrent handle and re-add it on
 *     resume -- which is what "stop" means in Transmission or qBittorrent too.
 *
 *  2. That makes fast resume essential rather than optional. WebTorrent supports
 *     it via `opts.bitfield`, which trusts a saved bitfield while sample-hashing
 *     one piece per file. So we persist the bitfield BEFORE destroying a handle,
 *     always. (`opts.fileModtimes` is deliberately never used -- see `add`.)
 */

import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import type { FilePriority, PeerInfo, TorrentFileInfo, TrackerInfo, TrackerStatus } from '@shared/types.js'
import { FILE_PRIORITY_WEIGHT } from '@shared/types.js'
import { MAX_PEERS_IN_DETAILS } from '@shared/constants.js'
import { sanitizeTorrentPaths } from '@shared/path-safety.js'
import { fileVerifiedBytes, selectedPieceIndices } from '@shared/piece-math.js'
import { assertFileWithinRoot } from './path-guard.js'
import { log, toLogDetail, toUserMessage } from './logger.js'

// WebTorrent ships no types; we describe only the surface we actually use.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTorrent = any
type AnyClient = any

const logger = () => log('engine')

export interface EngineConfig {
  maxConnections: number
  /** Bytes/second, or -1 for unlimited. */
  downloadLimit: number
  uploadLimit: number
  listenPort: number
  enableDht: boolean
  enablePex: boolean
  enableLsd: boolean
  enableUtp: boolean
  enableUpnp: boolean
  encryptionLevel: 0 | 1 | 2
}

export interface EngineAddSpec {
  infoHash: string
  /** Raw `.torrent` bytes. Always present: magnets go through `fetchMetadata` first. */
  torrentFile: Uint8Array
  downloadPath: string
  /** Priority per file index; missing indices are treated as `normal`. */
  priorities: Record<number, FilePriority>
  /** Saved bitfield for fast resume. */
  bitfield: Uint8Array | null
  /** Extra trackers (from the magnet) and web seeds to merge in. */
  announce: string[]
  urlList: string[]
}

export interface EngineMetadataResult {
  infoHash: string
  name: string
  torrentFile: Uint8Array
  totalLength: number
  pieceCount: number
  pieceLength: number
  isPrivate: boolean
  comment: string | null
  createdBy: string | null
  creationDate: number | null
  files: TorrentFileInfo[]
}

/** Live counters read off a torrent handle. */
export interface EngineTorrentStats {
  hasMetadata: boolean
  name: string
  totalLength: number
  selectedLength: number
  downloaded: number
  uploaded: number
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  numPeers: number
  numSeeds: number
  numConnections: number
  availability: number
  pieceCount: number
  pieceLength: number
  piecesVerified: number
  ratio: number
  eta: number | null
  isDone: boolean
  isPrivate: boolean
  fileCount: number
  timeRemaining: number | null
}

export interface EngineEvents {
  metadata: (infoHash: string) => void
  ready: (infoHash: string) => void
  done: (infoHash: string) => void
  error: (infoHash: string, message: string) => void
  warning: (infoHash: string, message: string) => void
  /** Fired while a hash check is running. */
  verified: (infoHash: string, pieceIndex: number) => void
  checkStarted: (infoHash: string) => void
  checkFinished: (infoHash: string) => void
}

export interface TorrentEngine {
  start(config: EngineConfig): Promise<void>
  destroy(): Promise<void>
  applyConfig(config: EngineConfig): void

  fetchMetadata(
    infoHash: string,
    magnetUri: string,
    stagingDir: string,
    signal: { aborted: boolean },
    onProgress: (numPeers: number) => void
  ): Promise<EngineMetadataResult>

  add(spec: EngineAddSpec): Promise<void>
  /** Destroys the handle. Files are kept unless `deleteFiles` is set. */
  drop(infoHash: string, deleteFiles: boolean): Promise<void>
  has(infoHash: string): boolean

  stats(infoHash: string): EngineTorrentStats | null
  files(infoHash: string): TorrentFileInfo[]
  peers(infoHash: string): PeerInfo[]
  trackers(infoHash: string): TrackerInfo[]
  webSeeds(infoHash: string): string[]

  setFilePriority(infoHash: string, fileIndex: number, priority: FilePriority): void
  recheck(infoHash: string): Promise<void>
  reannounce(infoHash: string): void

  /** Piece bitfield, captured for persistence before a handle is destroyed. */
  captureResumeData(infoHash: string): Promise<{ bitfield: Uint8Array | null }>

  sessionStats(): { downloadSpeed: number; uploadSpeed: number; dhtNodes: number | null; listenPort: number | null; utpEnabled: boolean }

  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): void
}

/** Per-tracker state accumulated from the tracker client's events. */
interface TrackerState {
  status: TrackerStatus
  message: string | null
  seeds: number | null
  peers: number | null
  lastAnnounce: number | null
  nextAnnounce: number | null
}

interface TrackedTorrent {
  infoHash: string
  torrent: AnyTorrent
  /** Sanitised file metadata, computed once at add time. */
  fileInfo: Array<{ path: string; originalPath: string; sanitized: boolean }>
  priorities: Record<number, FilePriority>
  trackerStates: Map<string, TrackerState>
  checking: boolean
  /** Cached so a destroyed handle can still report its last known name. */
  lastKnownName: string
}

export class WebTorrentEngine implements TorrentEngine {
  private client: AnyClient | null = null
  private readonly emitter = new EventEmitter()
  private readonly torrents = new Map<string, TrackedTorrent>()
  private config: EngineConfig | null = null

  constructor() {
    // Engine-level listener count can exceed the default 10 with many torrents.
    this.emitter.setMaxListeners(0)
  }

  // -------------------------------------------------------------- lifecycle

  async start(config: EngineConfig): Promise<void> {
    if (this.client) return
    this.config = config

    const clientOpts: Record<string, unknown> = {
      maxConns: config.maxConnections,
      // WebTorrent takes -1 for "no limit", which is also our sentinel.
      downloadLimit: config.downloadLimit,
      uploadLimit: config.uploadLimit,
      torrentPort: config.listenPort,
      dht: config.enableDht,
      lsd: config.enableLsd,
      utPex: config.enablePex,
      utp: config.enableUtp,
      natUpnp: config.enableUpnp ? 'permanent' : false,
      natPmp: config.enableUpnp,
      // 0 = plaintext only, 1 = prefer MSE with plaintext fallback, 2 = require MSE.
      secure: config.encryptionLevel,
      tracker: true,
      webSeeds: true
    }

    this.client = new WebTorrent(clientOpts as never)

    this.client.on('error', (err: unknown) => {
      // Client-level errors are fatal to the session; surface them loudly.
      logger().error(`client error: ${toLogDetail(err)}`)
      this.emitter.emit('error', '', toUserMessage(err, 'The torrent engine reported an error.'))
    })

    this.client.on('torrent', (torrent: AnyTorrent) => {
      logger().debug(`client reports torrent ready: ${torrent.infoHash}`)
    })

    logger().info(
      `engine started (utp=${WebTorrent.UTP_SUPPORT && config.enableUtp}, dht=${config.enableDht}, ` +
        `pex=${config.enablePex}, lsd=${config.enableLsd}, encryption=${config.encryptionLevel}, ` +
        `maxConns=${config.maxConnections}, port=${config.listenPort || 'auto'})`
    )
  }

  async destroy(): Promise<void> {
    const client = this.client
    if (!client) return
    this.client = null
    this.torrents.clear()
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      // Never let a hung engine block quit.
      const timer = setTimeout(done, 8_000)
      timer.unref?.()
      client.destroy(() => {
        clearTimeout(timer)
        done()
      })
    })
    logger().info('engine destroyed')
  }

  applyConfig(config: EngineConfig): void {
    const previous = this.config
    this.config = config
    if (!this.client) return

    if (!previous || previous.downloadLimit !== config.downloadLimit) {
      this.client.throttleDownload(config.downloadLimit)
      logger().info(`download limit set to ${config.downloadLimit}`)
    }
    if (!previous || previous.uploadLimit !== config.uploadLimit) {
      this.client.throttleUpload(config.uploadLimit)
      logger().info(`upload limit set to ${config.uploadLimit}`)
    }
    if (!previous || previous.maxConnections !== config.maxConnections) {
      this.client.maxConns = config.maxConnections
    }
    // DHT/uTP/port/encryption changes need a fresh client; the settings UI says so.
  }

  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
  }

  has(infoHash: string): boolean {
    return this.torrents.has(infoHash)
  }

  // ------------------------------------------------------------- metadata

  /**
   * Pulls the info dict for a magnet off the swarm, then hands back the raw
   * `.torrent` bytes and a sanitised file list.
   *
   * The torrent is added fully deselected and pointed at a staging directory, so
   * nothing is written to disk: metadata retrieval must not create files before
   * the user has even chosen a download folder. The handle is destroyed before
   * returning; the caller re-adds from the returned bytes once the user commits.
   */
  async fetchMetadata(
    infoHash: string,
    magnetUri: string,
    stagingDir: string,
    signal: { aborted: boolean },
    onProgress: (numPeers: number) => void
  ): Promise<EngineMetadataResult> {
    const client = this.requireClient()
    if (signal.aborted) throw new Error('cancelled')

    // Retrying a preview (or cancelling and re-adding the same magnet) can race
    // the teardown of the previous attempt: its handle may still be registered
    // with the client, and WebTorrent rejects a second add for the same info
    // hash with "Cannot add duplicate torrent". Clear the orphan first.
    //
    // Anything left here is necessarily a stale preview handle -- a torrent the
    // user has actually added is in `this.torrents`, and the caller refuses to
    // preview one of those.
    if (!this.torrents.has(infoHash)) {
      await this.discardOrphanedHandle(infoHash)
    }

    await fs.mkdir(stagingDir, { recursive: true })

    return new Promise<EngineMetadataResult>((resolve, reject) => {
      let settled = false
      let progressTimer: NodeJS.Timeout | null = null
      let torrent: AnyTorrent = null

      const cleanup = () => {
        if (progressTimer) clearInterval(progressTimer)
        progressTimer = null
        if (torrent && !torrent.destroyed) {
          try {
            // destroyStore: false -- there is nothing to delete, but be explicit.
            torrent.destroy({ destroyStore: false })
          } catch (err) {
            logger().warn(`preview cleanup failed: ${toLogDetail(err)}`)
          }
        }
      }

      const finish = (err: Error | null, value?: EngineMetadataResult) => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve(value!)
      }

      try {
        torrent = client.add(magnetUri, {
          path: stagingDir,
          // Nothing is selected, so no piece is ever requested or written.
          deselect: true,
          storeCacheSlots: 0
        })
      } catch (err) {
        finish(new Error(toUserMessage(err, 'This torrent could not be added.')))
        return
      }

      progressTimer = setInterval(() => {
        if (signal.aborted) {
          finish(new Error('cancelled'))
          return
        }
        if (torrent && !torrent.destroyed) onProgress(torrent.numPeers ?? 0)
      }, 500)
      progressTimer.unref?.()

      torrent.on('error', (err: unknown) => {
        finish(new Error(toUserMessage(err, 'This torrent could not be read.')))
      })

      torrent.on('metadata', () => {
        try {
          const bytes = new Uint8Array(torrent.torrentFile)
          const result = this.describeMetadata(torrent, bytes)
          finish(null, result)
        } catch (err) {
          finish(new Error(toUserMessage(err, 'The torrent metadata could not be read.')))
        }
      })
    })
  }

  /**
   * Destroys any handle the client still holds for this info hash that we are
   * not tracking. Files are never touched -- a preview writes nothing.
   */
  private async discardOrphanedHandle(infoHash: string): Promise<void> {
    const client = this.client
    if (!client) return

    const existing = (client.torrents as AnyTorrent[]).find(
      (t: AnyTorrent) => t?.infoHash === infoHash
    )
    if (!existing || existing.destroyed) return

    logger().debug(`clearing a stale preview handle for ${infoHash.slice(0, 8)}`)
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const timer = setTimeout(done, 5_000)
      timer.unref?.()
      try {
        existing.destroy({ destroyStore: false }, () => {
          clearTimeout(timer)
          done()
        })
      } catch {
        clearTimeout(timer)
        done()
      }
    })
  }

  /** Builds the metadata result, sanitising every path in the file list. */
  private describeMetadata(torrent: AnyTorrent, bytes: Uint8Array): EngineMetadataResult {
    const rawPaths: string[] = torrent.files.map((f: AnyTorrent) => String(f.path))
    const sanitized = sanitizeTorrentPaths(rawPaths)

    const files: TorrentFileInfo[] = torrent.files.map((f: AnyTorrent, index: number) => {
      const safe = sanitized[index]!
      const segments = safe.path.split('/')
      return {
        index,
        path: safe.path,
        name: segments[segments.length - 1]!,
        length: Number(f.length) || 0,
        downloaded: 0,
        progress: 0,
        priority: 'normal' as FilePriority,
        sanitized: safe.sanitized,
        originalPath: safe.originalPath
      }
    })

    const totalLength = files.reduce((sum, f) => sum + f.length, 0)

    return {
      infoHash: String(torrent.infoHash),
      name: String(torrent.name ?? torrent.infoHash),
      torrentFile: bytes,
      totalLength,
      pieceCount: torrent.pieces?.length ?? 0,
      pieceLength: Number(torrent.pieceLength) || 0,
      isPrivate: Boolean(torrent.private),
      comment: typeof torrent.comment === 'string' ? torrent.comment : null,
      createdBy: typeof torrent.createdBy === 'string' ? torrent.createdBy : null,
      creationDate: torrent.created instanceof Date ? torrent.created.getTime() : null,
      files
    }
  }

  // ------------------------------------------------------------------ add

  async add(spec: EngineAddSpec): Promise<void> {
    const client = this.requireClient()

    if (this.torrents.has(spec.infoHash)) {
      throw new Error('This torrent is already in the list.')
    }

    // Parse ourselves so we can rewrite the file paths before the engine ever
    // opens a file. `encodeTorrentFile` re-encodes from the untouched raw info
    // dict, so rewriting `files[].path` cannot change the info hash, the piece
    // hashes, or the byte offsets -- only where the bytes land on disk.
    let parsed: AnyTorrent
    try {
      parsed = await parseTorrent(spec.torrentFile)
    } catch (err) {
      throw new Error(toUserMessage(err, 'This torrent file could not be read.'))
    }

    if (String(parsed.infoHash) !== spec.infoHash) {
      throw new Error('The torrent data does not match its info hash.')
    }

    const rawPaths: string[] = parsed.files.map((f: AnyTorrent) => String(f.path))
    const sanitized = sanitizeTorrentPaths(rawPaths)

    for (let i = 0; i < parsed.files.length; i += 1) {
      const safe = sanitized[i]!
      // Second layer: resolve against the real download root and refuse anything
      // that escapes it, including via a pre-existing symlink.
      assertFileWithinRoot(spec.downloadPath, safe.path)
      parsed.files[i].path = safe.path
      if (safe.sanitized) {
        logger().warn(
          `sanitised path in ${spec.infoHash.slice(0, 8)}: ` +
            `${JSON.stringify(safe.originalPath)} -> ${JSON.stringify(safe.path)} ` +
            `(${safe.reasons.join('; ')})`
        )
      }
    }

    const addOpts: Record<string, unknown> = {
      path: spec.downloadPath,
      // Start with nothing selected, then apply the user's per-file choices.
      deselect: true,
      announce: spec.announce,
      urlList: spec.urlList,
      storeCacheSlots: 8
    }

    // Fast resume: the saved bitfield routes WebTorrent through
    // `_verifyPiecesUsingBitfield`, which trusts the bitfield but sample-hashes
    // one piece per file and fully rechecks any file whose sample fails.
    //
    // We deliberately do NOT pass `opts.fileModtimes`. It reads like a companion
    // to the bitfield, but it is not: when the mtimes match, WebTorrent calls
    // `_markAllVerified()`, which marks EVERY piece verified and ignores the
    // bitfield entirely. On a partially downloaded torrent that reports a false
    // 100% and would serve unverified data to peers. Verified against
    // webtorrent 3.0.21, lib/torrent.js `_onMetadata`.
    if (spec.bitfield) addOpts.bitfield = spec.bitfield

    const torrent: AnyTorrent = client.add(parsed, addOpts as never)

    const tracked: TrackedTorrent = {
      infoHash: spec.infoHash,
      torrent,
      fileInfo: sanitized.map((s) => ({
        path: s.path,
        originalPath: s.originalPath,
        sanitized: s.sanitized
      })),
      priorities: { ...spec.priorities },
      trackerStates: new Map(),
      checking: !spec.bitfield,
      lastKnownName: String(parsed.name ?? spec.infoHash)
    }
    this.torrents.set(spec.infoHash, tracked)

    this.wireTorrentEvents(tracked)

    // `metadata` has already fired for a pre-parsed torrent by the time the
    // caller gets here, so apply selection as soon as files exist.
    this.applyPriorities(tracked)
  }

  private wireTorrentEvents(tracked: TrackedTorrent): void {
    const { torrent, infoHash } = tracked

    torrent.on('metadata', () => {
      tracked.lastKnownName = String(torrent.name ?? infoHash)
      this.emitter.emit('metadata', infoHash)
    })

    torrent.on('ready', () => {
      tracked.checking = false
      tracked.lastKnownName = String(torrent.name ?? infoHash)
      // Re-apply: a rehash can reset selections via `_markUnverified`.
      this.applyPriorities(tracked)
      this.emitter.emit('checkFinished', infoHash)
      this.emitter.emit('ready', infoHash)
    })

    torrent.on('done', () => {
      this.emitter.emit('done', infoHash)
    })

    torrent.on('error', (err: unknown) => {
      logger().error(`torrent ${infoHash.slice(0, 8)} error: ${toLogDetail(err)}`)
      this.emitter.emit(
        'error',
        infoHash,
        toUserMessage(err, 'The torrent engine reported an error.')
      )
    })

    torrent.on('warning', (err: unknown) => {
      // Warnings are noisy (every unreachable tracker produces one), so they go
      // to the log at debug level and never to a dialog.
      logger().debug(`torrent ${infoHash.slice(0, 8)} warning: ${toUserMessage(err, 'warning')}`)
      this.emitter.emit('warning', infoHash, toUserMessage(err, 'warning'))
    })

    torrent.on('verified', (index: number) => {
      this.emitter.emit('verified', infoHash, index)
    })

    // Per-tracker state for the Trackers tab. `update` carries the announce URL;
    // `warning` and `error` do not, so a failing tracker cannot be attributed
    // precisely -- it stays `idle` until it produces a successful announce.
    const trackerClient = torrent.discovery?.tracker
    if (trackerClient && typeof trackerClient.on === 'function') {
      trackerClient.on('update', (data: Record<string, unknown>) => {
        const url = typeof data.announce === 'string' ? data.announce : null
        if (!url) return
        const complete = typeof data.complete === 'number' ? data.complete : null
        const incomplete = typeof data.incomplete === 'number' ? data.incomplete : null
        const intervalMs =
          typeof data.interval === 'number' && data.interval > 0 ? data.interval * 1000 : null
        tracked.trackerStates.set(url, {
          status: 'working',
          message: null,
          seeds: complete,
          peers: incomplete,
          lastAnnounce: Date.now(),
          nextAnnounce: intervalMs ? Date.now() + intervalMs : null
        })
      })
    }

    torrent.on('trackerAnnounce', () => {
      logger().debug(`tracker announce for ${infoHash.slice(0, 8)}`)
    })
  }

  /**
   * Applies the stored per-file priorities.
   *
   * The torrent was added with `deselect: true`, so nothing is selected until
   * this runs. Note a BitTorrent detail worth knowing: a piece straddling the
   * boundary between a selected and a skipped file still gets downloaded,
   * because the selected file needs it. That is correct, not a bug.
   */
  private applyPriorities(tracked: TrackedTorrent): void {
    const { torrent, priorities } = tracked
    if (!torrent.files || torrent.files.length === 0) return

    // Only ever ADD selections here. The torrent is added with `deselect: true`,
    // so a skipped file is already unselected and calling `file.deselect()` on
    // it is not merely redundant -- it is destructive.
    //
    // WebTorrent's `Selections.remove()` subtracts piece ranges rather than
    // removing whole entries. Files share the piece on their boundary, so
    // deselecting a skipped file trims that piece off its neighbour's
    // selection: the neighbour then stops just short of complete, missing
    // exactly the bytes it held in the shared piece.
    torrent.files.forEach((file: AnyTorrent, index: number) => {
      const priority = priorities[index] ?? 'normal'
      if (priority !== 'skip') {
        file.select(FILE_PRIORITY_WEIGHT[priority])
      }
    })
  }

  setFilePriority(infoHash: string, fileIndex: number, priority: FilePriority): void {
    const tracked = this.torrents.get(infoHash)
    if (!tracked) return
    tracked.priorities[fileIndex] = priority
    const file = tracked.torrent.files?.[fileIndex]
    if (!file) return

    if (priority === 'skip') {
      try {
        file.deselect()
      } catch {
        /* no-op */
      }
      // Deselecting subtracts this file's piece range from any selection that
      // overlaps it, which can strip a boundary piece from a neighbouring file
      // we still want. Re-assert every wanted file's selection to put it back.
      this.applyPriorities(tracked)
    } else {
      file.select(FILE_PRIORITY_WEIGHT[priority])
    }
  }

  // ------------------------------------------------------------ drop / stop

  /**
   * Destroys the handle. This is how both "pause" and "remove" are implemented,
   * because it is the only way to genuinely stop network transfer (see the note
   * at the top of this file).
   */
  async drop(infoHash: string, deleteFiles: boolean): Promise<void> {
    const tracked = this.torrents.get(infoHash)
    if (!tracked) return
    this.torrents.delete(infoHash)

    const { torrent } = tracked
    if (torrent.destroyed) return

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const timer = setTimeout(done, 10_000)
      timer.unref?.()
      try {
        torrent.destroy({ destroyStore: deleteFiles }, () => {
          clearTimeout(timer)
          done()
        })
      } catch (err) {
        logger().error(`destroy failed for ${infoHash.slice(0, 8)}: ${toLogDetail(err)}`)
        clearTimeout(timer)
        done()
      }
    })

    logger().info(
      `dropped ${infoHash.slice(0, 8)} (${deleteFiles ? 'files deleted' : 'files kept'})`
    )
  }

  /** Captures resume data. MUST be called before `drop` on a pause. */
  async captureResumeData(infoHash: string): Promise<{ bitfield: Uint8Array | null }> {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return { bitfield: null }

    const { torrent } = tracked

    let bitfield: Uint8Array | null = null
    try {
      const buf = torrent.bitfield?.buffer
      // WebTorrent only accepts a bitfield of exactly ceil(pieces/8) bytes.
      if (buf && torrent.pieces) {
        const expected = Math.ceil(torrent.pieces.length / 8)
        if (buf.length === expected) bitfield = new Uint8Array(buf)
      }
    } catch (err) {
      logger().warn(`could not read bitfield for ${infoHash.slice(0, 8)}: ${toLogDetail(err)}`)
    }

    return { bitfield }
  }

  // --------------------------------------------------------------- recheck

  /**
   * Full hash check of everything on disk.
   *
   * Engine limitation worth stating plainly: WebTorrent emits `verified` for
   * pieces it finds intact but nothing for pieces it finds missing, so there is
   * no way to derive how far through the scan it is. We therefore report an
   * indeterminate Checking state with a running count of verified pieces rather
   * than inventing a percentage.
   */
  async recheck(infoHash: string): Promise<void> {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) {
      throw new Error('This torrent is not running, so it cannot be checked.')
    }

    tracked.checking = true
    this.emitter.emit('checkStarted', infoHash)

    await new Promise<void>((resolve, reject) => {
      try {
        tracked.torrent.rescanFiles((err: unknown) => {
          tracked.checking = false
          this.emitter.emit('checkFinished', infoHash)
          if (err) reject(new Error(toUserMessage(err, 'The file check failed.')))
          else resolve()
        })
      } catch (err) {
        tracked.checking = false
        this.emitter.emit('checkFinished', infoHash)
        reject(new Error(toUserMessage(err, 'The file check could not be started.')))
      }
    })

    // A check can invalidate pieces, which resets selections.
    this.applyPriorities(tracked)
  }

  reannounce(infoHash: string): void {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return
    const { torrent } = tracked
    try {
      torrent.discovery?.tracker?.update?.()
      torrent.discovery?.dht?.announce?.(infoHash, torrent.client?.torrentPort ?? 0)
      logger().info(`forced reannounce for ${infoHash.slice(0, 8)}`)
    } catch (err) {
      logger().warn(`reannounce failed for ${infoHash.slice(0, 8)}: ${toLogDetail(err)}`)
    }
  }

  // ------------------------------------------------------------ inspection

  stats(infoHash: string): EngineTorrentStats | null {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return null
    const t = tracked.torrent

    const hasMetadata = Boolean(t.files && t.files.length > 0 && t.pieces)
    const totalLength = Number(t.length) || 0

    // "Selected" is what the progress bar should measure: a torrent with files
    // skipped is complete when the selected files are complete.
    let selectedLength = 0
    if (hasMetadata) {
      t.files.forEach((f: AnyTorrent, index: number) => {
        const priority = tracked.priorities[index] ?? 'normal'
        if (priority !== 'skip') selectedLength += Number(f.length) || 0
      })
    }

    // Byte accounting is done with our own overlap math rather than
    // `file.downloaded`, whose off-by-one-piece bug makes any piece-aligned file
    // report one piece short -- which shows up as a progress bar stuck near
    // 99%. See app/shared/piece-math.ts.
    const downloadedSelected = hasMetadata
      ? t.files.reduce((sum: number, f: AnyTorrent, index: number) => {
          const priority = tracked.priorities[index] ?? 'normal'
          if (priority === 'skip') return sum
          return sum + this.verifiedBytesForFile(t, f)
        }, 0)
      : 0

    const uploaded = Number(t.uploaded) || 0
    const downloadedTotal = Number(t.downloaded) || 0

    // Pin progress to exactly 1 only when every needed piece is verified, so the
    // bar can neither stall short of 100% nor claim 100% prematurely.
    const complete = this.selectedSetComplete(t, tracked.priorities)
    const progress = complete
      ? 1
      : selectedLength > 0
        ? Math.min(0.9999, downloadedSelected / selectedLength)
        : 0

    const downloadSpeed = Number(t.downloadSpeed) || 0
    const remaining = Math.max(0, selectedLength - downloadedSelected)
    const eta = downloadSpeed > 0 && remaining > 0 ? remaining / downloadSpeed : null

    let piecesVerified = 0
    if (t.bitfield && t.pieces) {
      for (let i = 0; i < t.pieces.length; i += 1) {
        if (t.bitfield.get(i)) piecesVerified += 1
      }
    }

    // Seeds vs leeches, from the wires we actually hold.
    let numSeeds = 0
    const wires: AnyTorrent[] = Array.isArray(t.wires) ? t.wires : []
    for (const wire of wires) {
      if (wire?.isSeeder) numSeeds += 1
    }

    return {
      hasMetadata,
      name: String(t.name ?? tracked.lastKnownName),
      totalLength,
      selectedLength: selectedLength > 0 ? selectedLength : totalLength,
      downloaded: downloadedSelected,
      uploaded,
      progress,
      downloadSpeed,
      uploadSpeed: Number(t.uploadSpeed) || 0,
      numPeers: Number(t.numPeers) || 0,
      numSeeds,
      numConnections: wires.length,
      availability: this.computeAvailability(t),
      pieceCount: t.pieces?.length ?? 0,
      pieceLength: Number(t.pieceLength) || 0,
      piecesVerified,
      ratio: downloadedTotal > 0 ? uploaded / downloadedTotal : uploaded > 0 ? Infinity : 0,
      eta,
      isDone: complete || Boolean(t.done),
      isPrivate: Boolean(t.private),
      fileCount: t.files?.length ?? 0,
      timeRemaining: Number.isFinite(t.timeRemaining) ? Number(t.timeRemaining) / 1000 : null
    }
  }

  /**
   * Verified bytes belonging to one file, computed by intersecting the file's
   * byte range with each verified piece's byte range.
   */
  private verifiedBytesForFile(t: AnyTorrent, file: AnyTorrent): number {
    const bitfield = t.bitfield
    const pieceCount = t.pieces?.length ?? 0
    if (!bitfield || pieceCount === 0) return 0

    return fileVerifiedBytes(
      {
        fileOffset: Number(file.offset) || 0,
        fileLength: Number(file.length) || 0,
        pieceLength: Number(t.pieceLength) || 0,
        lastPieceLength: Number(t.lastPieceLength) || Number(t.pieceLength) || 0,
        pieceCount
      },
      (index) => Boolean(bitfield.get(index))
    )
  }

  /**
   * Whether every piece the selected files need has been verified. This -- not a
   * byte ratio -- is the authoritative completion test, since byte totals can
   * be shy of the file length while a shared boundary piece is outstanding.
   */
  private selectedSetComplete(t: AnyTorrent, priorities: Record<number, FilePriority>): boolean {
    const pieceCount = t.pieces?.length ?? 0
    if (!t.bitfield || pieceCount === 0 || !t.files) return false

    const needed = selectedPieceIndices(
      t.files.map((f: AnyTorrent, index: number) => ({
        offset: Number(f.offset) || 0,
        length: Number(f.length) || 0,
        selected: (priorities[index] ?? 'normal') !== 'skip'
      })),
      Number(t.pieceLength) || 0
    )
    if (needed.size === 0) return false

    for (const index of needed) {
      if (!t.bitfield.get(index)) return false
    }
    return true
  }

  /**
   * Average number of copies of each piece visible across our peers.
   * Below 1.0 means no complete copy of the torrent is reachable right now.
   */
  private computeAvailability(t: AnyTorrent): number {
    const pieceCount = t.pieces?.length ?? 0
    if (pieceCount === 0) return 0
    const wires: AnyTorrent[] = Array.isArray(t.wires) ? t.wires : []
    if (wires.length === 0) return 0

    let totalPieces = 0
    for (const wire of wires) {
      const peerPieces = wire?.peerPieces
      if (!peerPieces) continue
      if (wire.isSeeder) {
        totalPieces += pieceCount
        continue
      }
      // Counting every bit on every wire each tick would be O(peers x pieces);
      // sample instead so a 200-peer swarm stays cheap.
      const step = pieceCount > 4096 ? Math.ceil(pieceCount / 4096) : 1
      let seen = 0
      let sampled = 0
      for (let i = 0; i < pieceCount; i += step) {
        sampled += 1
        if (peerPieces.get(i)) seen += 1
      }
      totalPieces += sampled > 0 ? (seen / sampled) * pieceCount : 0
    }

    return totalPieces / pieceCount
  }

  files(infoHash: string): TorrentFileInfo[] {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return []
    const t = tracked.torrent
    if (!t.files) return []

    return t.files.map((f: AnyTorrent, index: number) => {
      const info = tracked.fileInfo[index]
      const path = info?.path ?? String(f.path)
      const segments = path.split('/')
      const length = Number(f.length) || 0
      const downloaded = this.verifiedBytesForFile(t, f)
      return {
        index,
        path,
        name: segments[segments.length - 1]!,
        length,
        downloaded,
        progress: length > 0 ? Math.min(1, downloaded / length) : 0,
        priority: tracked.priorities[index] ?? 'normal',
        sanitized: info?.sanitized ?? false,
        originalPath: info?.originalPath ?? path
      }
    })
  }

  peers(infoHash: string): PeerInfo[] {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return []
    const t = tracked.torrent
    const wires: AnyTorrent[] = Array.isArray(t.wires) ? t.wires : []
    const pieceCount = t.pieces?.length ?? 0

    return wires.slice(0, MAX_PEERS_IN_DETAILS).map((wire: AnyTorrent) => {
      let progress = 0
      if (wire.isSeeder) {
        progress = 1
      } else if (wire.peerPieces && pieceCount > 0) {
        const step = pieceCount > 2048 ? Math.ceil(pieceCount / 2048) : 1
        let seen = 0
        let sampled = 0
        for (let i = 0; i < pieceCount; i += step) {
          sampled += 1
          if (wire.peerPieces.get(i)) seen += 1
        }
        progress = sampled > 0 ? seen / sampled : 0
      }

      const handshake = wire.peerExtendedHandshake
      const rawClient = handshake && typeof handshake.v === 'string' ? handshake.v : null

      return {
        address: String(wire.remoteAddress ?? wire.peerAddress ?? 'unknown'),
        type: String(wire.type ?? 'tcp'),
        client: rawClient ? rawClient.slice(0, 64) : null,
        progress,
        downloadSpeed: typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0,
        uploadSpeed: typeof wire.uploadSpeed === 'function' ? wire.uploadSpeed() : 0,
        encrypted: Boolean(wire._encryptionMethod ?? wire._encryptor),
        choking: Boolean(wire.amChoking),
        choked: Boolean(wire.peerChoking)
      }
    })
  }

  trackers(infoHash: string): TrackerInfo[] {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return []
    const t = tracked.torrent

    const urls: string[] = Array.isArray(t.announce) ? t.announce.map(String) : []
    const seen = new Set<string>()
    const out: TrackerInfo[] = []

    for (const url of urls) {
      // bittorrent-tracker strips a trailing slash when it keys its own state.
      const key = url.endsWith('/') ? url.slice(0, -1) : url
      if (seen.has(key)) continue
      seen.add(key)

      const state = tracked.trackerStates.get(key) ?? tracked.trackerStates.get(url)
      out.push({
        url,
        status: state?.status ?? 'idle',
        message: state?.message ?? null,
        seeds: state?.seeds ?? null,
        peers: state?.peers ?? null,
        lastAnnounce: state?.lastAnnounce ?? null,
        nextAnnounce: state?.nextAnnounce ?? null
      })
    }

    return out
  }

  webSeeds(infoHash: string): string[] {
    const tracked = this.torrents.get(infoHash)
    if (!tracked || tracked.torrent.destroyed) return []
    const list = tracked.torrent.urlList
    return Array.isArray(list) ? list.map(String) : []
  }

  sessionStats(): {
    downloadSpeed: number
    uploadSpeed: number
    dhtNodes: number | null
    listenPort: number | null
    utpEnabled: boolean
  } {
    const client = this.client
    if (!client) {
      return { downloadSpeed: 0, uploadSpeed: 0, dhtNodes: null, listenPort: null, utpEnabled: false }
    }

    let dhtNodes: number | null = null
    try {
      const table = client.dht?.nodes ?? client.dht?._rpc?.nodes
      if (table && typeof table.toArray === 'function') dhtNodes = table.toArray().length
    } catch {
      dhtNodes = null
    }

    return {
      downloadSpeed: Number(client.downloadSpeed) || 0,
      uploadSpeed: Number(client.uploadSpeed) || 0,
      dhtNodes,
      listenPort: Number(client.torrentPort) || null,
      utpEnabled: Boolean(WebTorrent.UTP_SUPPORT && this.config?.enableUtp)
    }
  }

  /** Path a torrent's files live under, for "Open Download Folder". */
  torrentPath(infoHash: string): string | null {
    const tracked = this.torrents.get(infoHash)
    if (!tracked) return null
    return typeof tracked.torrent.path === 'string' ? tracked.torrent.path : null
  }

  /** Absolute path of one file, used by "Open File". */
  filePath(infoHash: string, fileIndex: number): string | null {
    const tracked = this.torrents.get(infoHash)
    if (!tracked) return null
    const root = tracked.torrent.path
    const info = tracked.fileInfo[fileIndex]
    if (typeof root !== 'string' || !info) return null
    return join(root, info.path)
  }

  private requireClient(): AnyClient {
    if (!this.client) throw new Error('The torrent engine is not running.')
    return this.client
  }
}

/** True when the installed engine build has native uTP available. */
export function engineSupportsUtp(): boolean {
  return Boolean((WebTorrent as unknown as { UTP_SUPPORT?: boolean }).UTP_SUPPORT)
}

export function engineVersion(): string {
  return String((WebTorrent as unknown as { VERSION?: string }).VERSION ?? 'unknown')
}
