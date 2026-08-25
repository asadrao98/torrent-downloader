/**
 * A self-contained BitTorrent swarm on loopback, for integration tests.
 *
 * Runs a real HTTP tracker and a real seeding WebTorrent client, so tests
 * exercise genuine tracker announces, the real peer wire protocol and real
 * piece verification -- just deterministically, without depending on a public
 * swarm being reachable or well-seeded.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Server } from 'bittorrent-tracker'
import WebTorrent from 'webtorrent'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LocalSwarm {
  announceUrl: string
  torrentFile: Uint8Array
  infoHash: string
  magnetUri: string
  name: string
  files: Array<{ path: string; length: number; sha256: string }>
  /**
   * Files in the order they appear in the torrent metadata, which is NOT the
   * order they were created in -- create-torrent sorts them. Per-file options
   * are keyed by this index, so tests must map through here rather than
   * assuming creation order.
   */
  metadataFiles: Array<{ index: number; path: string; name: string; length: number }>
  /** Metadata index of a file, by its basename. Throws if absent. */
  indexOfFile(name: string): number
  seedDir: string
  /**
   * Destroys only the seeding client, leaving the tracker up. Lets a test prove
   * something could NOT have been downloaded, rather than racing a fast loopback
   * transfer.
   */
  stopSeeder(): Promise<void>
  stop(): Promise<void>
}

export interface SwarmFileSpec {
  path: string
  size: number
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `td-test-${prefix}-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function startTracker(): Promise<{ server: any; announceUrl: string }> {
  // No `filter`: bittorrent-tracker's filter is callback-based
  // -- `(infoHash, params, cb)` -- so a synchronous `() => true` silently never
  // completes the announce. The default allows everything, which is what we want.
  const server: any = new Server({
    udp: false,
    http: true,
    ws: false,
    stats: false
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Port 0 lets the OS pick a free port, so parallel runs cannot collide.
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.http.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, announceUrl: `http://127.0.0.1:${port}/announce` }
}

export async function startLocalSwarm(options: {
  name: string
  files: SwarmFileSpec[]
  /** Rewrites the paths in the torrent metadata, for hostile-path tests. */
  metadataPathOverride?: (originalPath: string, index: number) => string[]
}): Promise<LocalSwarm> {
  const { server, announceUrl } = await startTracker()

  const seedRoot = await makeTempDir('seed')
  const contentRoot = join(seedRoot, options.name)
  await fs.mkdir(contentRoot, { recursive: true })

  const files: Array<{ path: string; length: number; sha256: string }> = []

  for (const spec of options.files) {
    const abs = join(contentRoot, spec.path)
    await fs.mkdir(dirname(abs), { recursive: true })
    // Incompressible content, so a truncated or shuffled download fails by hash
    // rather than passing by luck.
    const bytes = randomBytes(spec.size)
    await fs.writeFile(abs, bytes)
    files.push({ path: spec.path, length: spec.size, sha256: sha256(bytes) })
  }

  const seedClient: any = new WebTorrent({
    dht: false,
    lsd: false,
    utp: false,
    natUpnp: false,
    natPmp: false
  })

  const torrent: any = await new Promise((resolve, reject) => {
    seedClient.once('error', reject)
    seedClient.seed(
      contentRoot,
      {
        name: options.name,
        announce: [announceUrl],
        // A small piece length yields a multi-piece torrent from a small
        // payload, which is what makes resume and partial tests meaningful.
        pieceLength: 16 * 1024,
        private: false
      },
      (t: any) => resolve(t)
    )
  })

  let torrentFile = new Uint8Array(torrent.torrentFile)

  // For hostile-path tests we rewrite the advertised metadata paths and
  // re-encode. The seeder keeps serving identical bytes; only the paths change,
  // which is exactly the attack the app must defend against.
  if (options.metadataPathOverride) {
    const bencode = (await import('bencode')).default
    const decoded: any = bencode.decode(torrentFile)
    const infoFiles = decoded.info.files
    if (Array.isArray(infoFiles)) {
      infoFiles.forEach((f: any, index: number) => {
        const original = (f['path.utf-8'] ?? f.path ?? [])
          .map((p: Uint8Array) => Buffer.from(p).toString('utf8'))
          .join('/')
        const replacement = options.metadataPathOverride!(original, index)
        f.path = replacement.map((seg) => Buffer.from(seg, 'utf8'))
        delete f['path.utf-8']
      })
    }
    torrentFile = new Uint8Array(bencode.encode(decoded))
  }

  // Derive the authoritative file order from the bytes we will actually hand to
  // the engine (after any path override), so indices always line up.
  const parseTorrent = (await import('parse-torrent')).default
  const parsedFinal: any = await parseTorrent(torrentFile)
  const metadataFiles = parsedFinal.files.map((f: any, index: number) => {
    const path = String(f.path)
    const segments = path.split('/')
    return { index, path, name: segments[segments.length - 1]!, length: Number(f.length) || 0 }
  })

  const infoHash = String(torrent.infoHash)
  const magnetUri =
    `magnet:?xt=urn:btih:${infoHash}` +
    `&dn=${encodeURIComponent(options.name)}` +
    `&tr=${encodeURIComponent(announceUrl)}`

  return {
    announceUrl,
    torrentFile,
    infoHash,
    magnetUri,
    name: options.name,
    files,
    metadataFiles,
    indexOfFile(name: string) {
      const match = metadataFiles.find((f: { name: string }) => f.name === name)
      if (!match) {
        throw new Error(
          `no file named ${name} in torrent metadata; have: ` +
            metadataFiles.map((f: { name: string }) => f.name).join(', ')
        )
      }
      return match.index
    },
    seedDir: contentRoot,
    async stopSeeder() {
      await new Promise<void>((resolve) => {
        try {
          seedClient.destroy(() => resolve())
        } catch {
          resolve()
        }
      })
    },
    async stop() {
      await new Promise<void>((resolve) => {
        try {
          seedClient.destroy(() => resolve())
        } catch {
          resolve()
        }
      })
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
      await fs.rm(seedRoot, { recursive: true, force: true })
    }
  }
}

/** Polls `check` until true, or throws after `timeoutMs`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
