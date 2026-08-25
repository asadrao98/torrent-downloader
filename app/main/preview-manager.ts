/**
 * The step between "paste a magnet" and "start downloading".
 *
 * A magnet carries no file list, so the info dict has to be pulled off the swarm
 * before the user can choose files or a folder. This manager owns that
 * intermediate state: one preview per pending add, progressing through
 * validating -> connecting -> fetching-metadata -> ready.
 *
 * Nothing is written to the download folder during a preview. Metadata is
 * fetched with every file deselected and pointed at a staging directory, and the
 * raw `.torrent` bytes are kept in memory so committing the preview does not
 * need a second trip to the swarm.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import parseTorrent from 'parse-torrent'
import type {
  FileTreeNode,
  MetadataPreview,
  ParsedMagnet,
  TorrentFileInfo
} from '@shared/types.js'
import { buildMagnetUri, parseMagnet } from '@shared/magnet.js'
import { sanitizeTorrentPaths } from '@shared/path-safety.js'
import { METADATA_TIMEOUT_MS, NO_PEERS_WARNING_MS } from '@shared/constants.js'
import type { EngineMetadataResult, TorrentEngine } from './torrent-engine.js'
import { log, toLogDetail, toUserMessage } from './logger.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const logger = () => log('preview')

interface PreviewEntry {
  view: MetadataPreview
  /** Raw `.torrent` bytes, present once metadata is known. */
  torrentFile: Uint8Array | null
  signal: { aborted: boolean }
  timer: NodeJS.Timeout | null
}

export interface PreviewManagerDeps {
  engine: TorrentEngine
  /** Directory used for metadata-only adds. Nothing should ever be written there. */
  stagingDir: string
  isAlreadyAdded(infoHash: string): boolean
  onUpdate(preview: MetadataPreview): void
}

/** Builds a directory tree from a flat, already-sanitised file list. */
export function buildFileTree(files: TorrentFileInfo[], rootName: string): FileTreeNode {
  const root: FileTreeNode = {
    name: rootName,
    path: '',
    isDirectory: true,
    length: 0,
    children: []
  }

  for (const file of files) {
    const segments = file.path.split('/').filter((s) => s.length > 0)
    // A single-file torrent's path is just the file name; keep it at the root.
    let cursor = root
    for (let depth = 0; depth < segments.length; depth += 1) {
      const segment = segments[depth]!
      const isLeaf = depth === segments.length - 1
      const childPath = segments.slice(0, depth + 1).join('/')

      if (isLeaf) {
        cursor.children!.push({
          name: segment,
          path: childPath,
          isDirectory: false,
          length: file.length,
          fileIndex: file.index
        })
      } else {
        let next = cursor.children!.find((c) => c.isDirectory && c.name === segment)
        if (!next) {
          next = { name: segment, path: childPath, isDirectory: true, length: 0, children: [] }
          cursor.children!.push(next)
        }
        cursor = next
      }
    }
  }

  // Roll directory sizes up from their contents, and sort folders before files.
  const finalise = (node: FileTreeNode): number => {
    if (!node.isDirectory) return node.length
    let total = 0
    for (const child of node.children ?? []) total += finalise(child)
    node.length = total
    node.children?.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return total
  }
  finalise(root)

  return root
}

export class PreviewManager {
  private readonly previews = new Map<string, PreviewEntry>()

  constructor(private readonly deps: PreviewManagerDeps) {}

  /** Live view of a preview, for the renderer to poll or for commit. */
  get(previewId: string): MetadataPreview | null {
    return this.previews.get(previewId)?.view ?? null
  }

  torrentFileFor(previewId: string): Uint8Array | null {
    return this.previews.get(previewId)?.torrentFile ?? null
  }

  private emit(entry: PreviewEntry): void {
    try {
      this.deps.onUpdate(entry.view)
    } catch (err) {
      logger().warn(`preview listener threw: ${toLogDetail(err)}`)
    }
  }

  /**
   * Starts a preview from a magnet URI. Returns immediately with a
   * `fetching-metadata` view; progress arrives through `onUpdate`.
   */
  startFromMagnet(magnetUri: string): MetadataPreview {
    const parsed = parseMagnet(magnetUri)
    const previewId = randomUUID()

    if (!parsed.ok) {
      const view: MetadataPreview = {
        previewId,
        stage: 'error',
        statusText: 'Invalid magnet link',
        magnet: emptyMagnet(),
        name: null,
        totalLength: null,
        fileCount: null,
        files: [],
        tree: null,
        pieceCount: null,
        pieceLength: null,
        isPrivate: false,
        comment: null,
        createdBy: null,
        creationDate: null,
        numPeers: 0,
        errorMessage: parsed.message,
        alreadyAdded: false
      }
      const entry: PreviewEntry = { view, torrentFile: null, signal: { aborted: false }, timer: null }
      this.previews.set(previewId, entry)
      return view
    }

    const magnet = parsed.value
    const alreadyAdded = this.deps.isAlreadyAdded(magnet.infoHash)

    const view: MetadataPreview = {
      previewId,
      stage: alreadyAdded ? 'error' : 'connecting',
      statusText: alreadyAdded ? 'Already added' : 'Connecting to peers…',
      magnet,
      name: magnet.name,
      totalLength: magnet.exactLength,
      fileCount: null,
      files: [],
      tree: null,
      pieceCount: null,
      pieceLength: null,
      isPrivate: false,
      comment: null,
      createdBy: null,
      creationDate: null,
      numPeers: 0,
      errorMessage: alreadyAdded ? 'This torrent is already in your list.' : null,
      alreadyAdded
    }

    const entry: PreviewEntry = { view, torrentFile: null, signal: { aborted: false }, timer: null }

    // Starting a second preview for the same torrent while the first is still
    // running would leave two handles fighting over one info hash. Retrying an
    // add is a normal thing to do, so supersede the old attempt rather than
    // failing the new one.
    this.cancelPreviewsFor(magnet.infoHash)

    this.previews.set(previewId, entry)

    if (alreadyAdded) return view

    void this.fetchMetadata(entry, magnet)
    return view
  }

  /**
   * Starts a preview from `.torrent` bytes. Metadata is already present, so this
   * resolves synchronously into a `ready` view.
   */
  async startFromTorrentFile(bytes: Uint8Array): Promise<MetadataPreview> {
    const previewId = randomUUID()

    let parsed: any
    try {
      parsed = await parseTorrent(bytes)
    } catch (err) {
      logger().warn(`could not parse dropped torrent file: ${toLogDetail(err)}`)
      const view = errorPreview(previewId, 'This file is not a valid .torrent file.')
      this.previews.set(previewId, {
        view,
        torrentFile: null,
        signal: { aborted: false },
        timer: null
      })
      return view
    }

    const infoHash = String(parsed.infoHash ?? '')
    if (!/^[0-9a-f]{40}$/.test(infoHash)) {
      const view = errorPreview(previewId, 'This torrent file has no usable info hash.')
      this.previews.set(previewId, {
        view,
        torrentFile: null,
        signal: { aborted: false },
        timer: null
      })
      return view
    }

    const trackers: string[] = Array.isArray(parsed.announce) ? parsed.announce.map(String) : []
    const webSeeds: string[] = Array.isArray(parsed.urlList) ? parsed.urlList.map(String) : []
    const name = String(parsed.name ?? infoHash)

    const magnet: ParsedMagnet = {
      infoHash,
      name,
      trackers,
      webSeeds,
      peerAddresses: [],
      keywords: [],
      exactLength: Number(parsed.length) || null,
      normalizedUri: buildMagnetUri({ infoHash, name, trackers, webSeeds }),
      extraParams: []
    }

    const files = describeFiles(parsed)
    const alreadyAdded = this.deps.isAlreadyAdded(infoHash)

    const view: MetadataPreview = {
      previewId,
      stage: alreadyAdded ? 'error' : 'ready',
      statusText: alreadyAdded ? 'Already added' : 'Metadata read from file',
      magnet,
      name,
      totalLength: files.reduce((sum, f) => sum + f.length, 0),
      fileCount: files.length,
      files,
      tree: buildFileTree(files, name),
      pieceCount: Array.isArray(parsed.pieces) ? parsed.pieces.length : null,
      pieceLength: Number(parsed.pieceLength) || null,
      isPrivate: Boolean(parsed.private),
      comment: typeof parsed.comment === 'string' ? parsed.comment : null,
      createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : null,
      creationDate: parsed.created instanceof Date ? parsed.created.getTime() : null,
      numPeers: 0,
      errorMessage: alreadyAdded ? 'This torrent is already in your list.' : null,
      alreadyAdded
    }

    this.previews.set(previewId, {
      view,
      torrentFile: bytes,
      signal: { aborted: false },
      timer: null
    })
    return view
  }

  private async fetchMetadata(entry: PreviewEntry, magnet: ParsedMagnet): Promise<void> {
    const { previewId } = entry.view
    const staging = join(this.deps.stagingDir, previewId)

    entry.view.stage = 'fetching-metadata'
    entry.view.statusText = 'Retrieving torrent metadata…'
    this.emit(entry)

    // Warn (but keep trying) when the swarm looks unreachable.
    const noPeersTimer = setTimeout(() => {
      if (entry.view.stage === 'fetching-metadata' && entry.view.numPeers === 0) {
        entry.view.statusText = 'Still looking for peers…'
        this.emit(entry)
      }
    }, NO_PEERS_WARNING_MS)
    noPeersTimer.unref?.()

    const timeoutTimer = setTimeout(() => {
      entry.signal.aborted = true
    }, METADATA_TIMEOUT_MS)
    timeoutTimer.unref?.()
    entry.timer = timeoutTimer

    try {
      const result = await this.deps.engine.fetchMetadata(
        magnet.infoHash,
        magnet.normalizedUri,
        staging,
        entry.signal,
        (numPeers) => {
          if (entry.view.numPeers === numPeers) return
          entry.view.numPeers = numPeers
          if (numPeers > 0 && entry.view.stage === 'fetching-metadata') {
            entry.view.statusText =
              numPeers === 1 ? 'Found 1 peer, retrieving metadata…' : `Found ${numPeers} peers, retrieving metadata…`
          }
          this.emit(entry)
        }
      )
      this.applyMetadata(entry, result)
    } catch (err) {
      const message = toUserMessage(err, 'Unable to retrieve torrent metadata.')
      const cancelled = /cancelled/i.test(message)
      entry.view.stage = 'error'
      entry.view.statusText = cancelled ? 'Cancelled' : 'Could not retrieve metadata'
      entry.view.errorMessage = cancelled
        ? 'Cancelled.'
        : 'No peers providing metadata could be reached. The torrent may be dead, or your network may be blocking peer connections.'
      logger().warn(`metadata fetch failed for ${magnet.infoHash.slice(0, 8)}: ${message}`)
      this.emit(entry)
    } finally {
      clearTimeout(noPeersTimer)
      clearTimeout(timeoutTimer)
      entry.timer = null
      // The staging directory should be empty, but remove it either way so a
      // cancelled preview leaves nothing behind.
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private applyMetadata(entry: PreviewEntry, result: EngineMetadataResult): void {
    entry.torrentFile = result.torrentFile
    entry.view.stage = 'ready'
    entry.view.statusText = 'Found metadata'
    entry.view.name = result.name
    entry.view.totalLength = result.totalLength
    entry.view.fileCount = result.files.length
    entry.view.files = result.files
    entry.view.tree = buildFileTree(result.files, result.name)
    entry.view.pieceCount = result.pieceCount
    entry.view.pieceLength = result.pieceLength
    entry.view.isPrivate = result.isPrivate
    entry.view.comment = result.comment
    entry.view.createdBy = result.createdBy
    entry.view.creationDate = result.creationDate
    entry.view.errorMessage = null
    logger().info(
      `metadata ready for ${result.infoHash.slice(0, 8)}: ${result.files.length} file(s), ` +
        `${result.totalLength} bytes`
    )
    this.emit(entry)
  }

  /** Aborts any in-flight preview for a given info hash. */
  private cancelPreviewsFor(infoHash: string): void {
    for (const [id, existing] of this.previews) {
      if (existing.view.magnet.infoHash !== infoHash) continue
      logger().debug(`superseding an earlier preview for ${infoHash.slice(0, 8)}`)
      this.cancel(id)
    }
  }

  cancel(previewId: string): void {
    const entry = this.previews.get(previewId)
    if (!entry) return
    entry.signal.aborted = true
    if (entry.timer) clearTimeout(entry.timer)
    this.previews.delete(previewId)
  }

  /** Removes a preview once it has been committed. */
  consume(previewId: string): void {
    this.previews.delete(previewId)
  }

  /** Aborts every in-flight preview, for shutdown. */
  cancelAll(): void {
    for (const id of [...this.previews.keys()]) this.cancel(id)
  }
}

function emptyMagnet(): ParsedMagnet {
  return {
    infoHash: '',
    name: null,
    trackers: [],
    webSeeds: [],
    peerAddresses: [],
    keywords: [],
    exactLength: null,
    normalizedUri: '',
    extraParams: []
  }
}

function errorPreview(previewId: string, message: string): MetadataPreview {
  return {
    previewId,
    stage: 'error',
    statusText: 'Could not read torrent',
    magnet: emptyMagnet(),
    name: null,
    totalLength: null,
    fileCount: null,
    files: [],
    tree: null,
    pieceCount: null,
    pieceLength: null,
    isPrivate: false,
    comment: null,
    createdBy: null,
    creationDate: null,
    numPeers: 0,
    errorMessage: message,
    alreadyAdded: false
  }
}

/** Sanitises a parsed torrent's file list into the shape the UI expects. */
function describeFiles(parsed: any): TorrentFileInfo[] {
  const rawPaths: string[] = (parsed.files ?? []).map((f: any) => String(f.path))
  const sanitized = sanitizeTorrentPaths(rawPaths)
  return (parsed.files ?? []).map((f: any, index: number) => {
    const safe = sanitized[index]!
    const segments = safe.path.split('/')
    return {
      index,
      path: safe.path,
      name: segments[segments.length - 1]!,
      length: Number(f.length) || 0,
      downloaded: 0,
      progress: 0,
      priority: 'normal' as const,
      sanitized: safe.sanitized,
      originalPath: safe.originalPath
    }
  })
}
