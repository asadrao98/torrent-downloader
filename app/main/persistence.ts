/**
 * Torrent session persistence.
 *
 * Two things are stored per torrent:
 *
 *  1. A record in `torrents.json` -- where it downloads to, which files were
 *     selected, how much has been transferred, and the piece bitfield.
 *  2. The raw `.torrent` file under `torrents/<infoHash>.torrent`.
 *
 * Keeping the `.torrent` blob is what makes restart cheap: on relaunch we hand
 * the engine a fully parsed torrent instead of a magnet, so there is no second
 * trip to the swarm for metadata. Combined with the saved bitfield and file
 * modification times, WebTorrent's fast-resume path verifies one piece per file
 * rather than rehashing gigabytes.
 */

import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type { FilePriority, SeedingGoal } from '@shared/types.js'
import { readBytes, readJson, removeFile, writeBytesAtomic, writeJsonAtomic } from './atomic-file.js'

/** Bumped when the record shape changes incompatibly. */
export const SESSION_SCHEMA_VERSION = 1

export interface PersistedTorrent {
  infoHash: string
  /** Best known name; the magnet's `dn` until metadata arrives. */
  name: string
  magnetUri: string
  downloadPath: string
  addedAt: number
  completedAt: number | null
  /** User-requested paused state, preserved across restarts. */
  paused: boolean
  /** Bypasses the active-torrent queue. */
  forceStarted: boolean
  /** Per-file priority by file index. Absent indices default to `normal`. */
  priorities: Record<string, FilePriority>
  /** Base64 piece bitfield for fast resume, or null when nothing is verified. */
  bitfield: string | null
  downloaded: number
  uploaded: number
  /**
   * Per-torrent seeding override; null means inherit the global setting.
   * There is deliberately no per-torrent bandwidth limit: WebTorrent throttles
   * per client, so such a field could never actually be enforced.
   */
  seedingGoal: SeedingGoal | null
  /** Whether a `.torrent` blob exists for this info hash. */
  hasTorrentFile: boolean
  /** When seeding began, used for the seed-time goal. */
  seedingStartedAt: number | null
  /** Persisted so an errored torrent still shows its reason after a restart. */
  errorMessage: string | null
}

interface SessionFile {
  version: number
  torrents: PersistedTorrent[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_PRIORITIES = new Set<FilePriority>(['skip', 'low', 'normal', 'high'])

/**
 * Validates one persisted record. Returns null when it is unusable, so a single
 * corrupt entry cannot stop the whole session from loading.
 */
export function validatePersistedTorrent(raw: unknown): PersistedTorrent | null {
  if (!isRecord(raw)) return null

  const infoHash = raw.infoHash
  if (typeof infoHash !== 'string' || !/^[0-9a-f]{40}$/.test(infoHash)) return null

  const downloadPath = raw.downloadPath
  if (typeof downloadPath !== 'string' || !downloadPath.startsWith('/')) return null

  const magnetUri = raw.magnetUri
  if (typeof magnetUri !== 'string' || !magnetUri.startsWith('magnet:')) return null

  const priorities: Record<string, FilePriority> = {}
  if (isRecord(raw.priorities)) {
    for (const [key, value] of Object.entries(raw.priorities)) {
      if (!/^\d+$/.test(key)) continue
      if (typeof value === 'string' && VALID_PRIORITIES.has(value as FilePriority)) {
        priorities[key] = value as FilePriority
      }
    }
  }

  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback

  const nullableNum = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  let seedingGoal: SeedingGoal | null = null
  if (isRecord(raw.seedingGoal)) {
    const kind = raw.seedingGoal.kind
    if (kind === 'ratio' || kind === 'time' || kind === 'forever') {
      seedingGoal = {
        kind,
        ratio: num(raw.seedingGoal.ratio, 1),
        minutes: num(raw.seedingGoal.minutes, 30)
      }
    }
  }

  const bitfield =
    typeof raw.bitfield === 'string' && /^[A-Za-z0-9+/=]*$/.test(raw.bitfield) && raw.bitfield.length > 0
      ? raw.bitfield
      : null

  return {
    infoHash,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, 512) : infoHash,
    magnetUri,
    downloadPath,
    addedAt: num(raw.addedAt, Date.now()),
    completedAt: nullableNum(raw.completedAt),
    paused: raw.paused === true,
    forceStarted: raw.forceStarted === true,
    priorities,
    bitfield,
    downloaded: num(raw.downloaded, 0),
    uploaded: num(raw.uploaded, 0),
    seedingGoal,
    hasTorrentFile: raw.hasTorrentFile === true,
    seedingStartedAt: nullableNum(raw.seedingStartedAt),
    errorMessage:
      typeof raw.errorMessage === 'string' && raw.errorMessage.length > 0
        ? raw.errorMessage.slice(0, 1000)
        : null
  }
}

export class SessionStore {
  private readonly sessionFile: string
  private readonly torrentDir: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.sessionFile = join(dataDir, 'torrents.json')
    this.torrentDir = join(dataDir, 'torrents')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.torrentDir, { recursive: true })
  }

  /**
   * Loads every valid record. Invalid records are dropped and reported so the
   * caller can log how many were lost rather than failing to start.
   */
  async load(): Promise<{ torrents: PersistedTorrent[]; dropped: number }> {
    const raw = await readJson<SessionFile>(this.sessionFile)
    if (!raw || !Array.isArray(raw.torrents)) return { torrents: [], dropped: 0 }

    const torrents: PersistedTorrent[] = []
    let dropped = 0
    const seen = new Set<string>()

    for (const entry of raw.torrents) {
      const validated = validatePersistedTorrent(entry)
      if (!validated) {
        dropped += 1
        continue
      }
      // Duplicate info hashes would produce two engine handles for one torrent.
      if (seen.has(validated.infoHash)) {
        dropped += 1
        continue
      }
      seen.add(validated.infoHash)
      torrents.push(validated)
    }

    return { torrents, dropped }
  }

  /** Writes the whole list. Cheap enough at any realistic torrent count. */
  async save(torrents: PersistedTorrent[]): Promise<void> {
    const payload: SessionFile = { version: SESSION_SCHEMA_VERSION, torrents }
    this.writeQueue = this.writeQueue
      .then(() => writeJsonAtomic(this.sessionFile, payload))
      .catch(() => {
        /* caller logs */
      })
    return this.writeQueue
  }

  private torrentFilePath(infoHash: string): string {
    // infoHash is validated as 40 hex chars before reaching here, so it cannot
    // contain a path separator.
    return join(this.torrentDir, `${infoHash}.torrent`)
  }

  async saveTorrentFile(infoHash: string, bytes: Uint8Array): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new Error('refusing to write a non-hex info hash')
    await writeBytesAtomic(this.torrentFilePath(infoHash), bytes)
  }

  async readTorrentFile(infoHash: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{40}$/.test(infoHash)) return null
    return readBytes(this.torrentFilePath(infoHash))
  }

  async deleteTorrentFile(infoHash: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(infoHash)) return
    await removeFile(this.torrentFilePath(infoHash))
  }

  get paths(): { session: string; torrents: string; dataDir: string } {
    return { session: this.sessionFile, torrents: this.torrentDir, dataDir: this.dataDir }
  }
}
