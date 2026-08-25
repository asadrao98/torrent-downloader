/**
 * Engine integration tests against a real BitTorrent swarm on loopback.
 *
 * These are not mocks. A real HTTP tracker runs, a real seeding client serves
 * pieces over the real peer wire protocol, and the engine under test verifies
 * every piece by hash. What is deterministic is only *who* is in the swarm.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { initLogger } from '@main/logger.js'
import { WebTorrentEngine, engineSupportsUtp, engineVersion } from '@main/torrent-engine.js'
import type { EngineConfig } from '@main/torrent-engine.js'
import { startLocalSwarm, makeTempDir, sha256, waitFor } from './helpers/local-swarm.js'
import type { LocalSwarm } from './helpers/local-swarm.js'

/** Offline-friendly config: no DHT, no LSD, no port mapping. */
const TEST_CONFIG: EngineConfig = {
  maxConnections: 50,
  downloadLimit: -1,
  uploadLimit: -1,
  listenPort: 0,
  enableDht: false,
  enableLsd: false,
  enablePex: false,
  enableUtp: false,
  enableUpnp: false,
  encryptionLevel: 1
}

let logDir: string

beforeAll(async () => {
  logDir = await makeTempDir('logs')
  initLogger(logDir)
})

afterAll(async () => {
  await fs.rm(logDir, { recursive: true, force: true })
})

describe('engine build capabilities', () => {
  it('reports the installed engine version and uTP availability', () => {
    // Recorded so a regression in the optional native addon is visible.
    expect(engineVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof engineSupportsUtp()).toBe('boolean')
  })
})

describe('metadata retrieval from a magnet link', () => {
  let swarm: LocalSwarm
  let engine: WebTorrentEngine
  let staging: string

  beforeAll(async () => {
    swarm = await startLocalSwarm({
      name: 'Metadata Test',
      files: [
        { path: 'big.bin', size: 300 * 1024 },
        { path: 'nested/small.txt', size: 4 * 1024 }
      ]
    })
    engine = new WebTorrentEngine()
    await engine.start(TEST_CONFIG)
    staging = await makeTempDir('staging')
  }, 60_000)

  afterAll(async () => {
    await engine.destroy()
    await swarm.stop()
    await fs.rm(staging, { recursive: true, force: true })
  })

  it('pulls the info dict off the swarm and reports the real torrent name', async () => {
    const result = await engine.fetchMetadata(
      swarm.infoHash,
      swarm.magnetUri,
      staging,
      { aborted: false },
      () => undefined
    )

    expect(result.infoHash).toBe(swarm.infoHash)
    expect(result.name).toBe('Metadata Test')
    expect(result.files).toHaveLength(2)
    expect(result.totalLength).toBe(304 * 1024)
    expect(result.pieceCount).toBeGreaterThan(1)
    expect(result.pieceLength).toBe(16 * 1024)
    expect(result.isPrivate).toBe(false)

    const paths = result.files.map((f) => f.path).sort()
    expect(paths).toEqual(['Metadata Test/big.bin', 'Metadata Test/nested/small.txt'])
  }, 60_000)

  it('writes nothing to disk while only fetching metadata', async () => {
    // The metadata screen must not create files before the user has chosen a
    // download folder, so the staging directory has to stay empty.
    const entries = await fs.readdir(staging)
    expect(entries).toEqual([])
  })

  it('reports peer progress while connecting', async () => {
    const seen: number[] = []
    await engine.fetchMetadata(swarm.infoHash, swarm.magnetUri, staging, { aborted: false }, (n: number) =>
      seen.push(n)
    )
    // Peer counts are sampled on a timer; on loopback metadata can arrive
    // before the first tick, so only assert the callback contract holds.
    expect(seen.every((n) => Number.isInteger(n) && n >= 0)).toBe(true)
  }, 60_000)

  // Regression: retrying an add while the previous attempt was still tearing
  // down produced "Cannot add duplicate torrent" and left the user unable to add
  // the torrent at all until they restarted the app.
  it('allows the same magnet to be previewed repeatedly', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await engine.fetchMetadata(
        swarm.infoHash,
        swarm.magnetUri,
        staging,
        { aborted: false },
        () => undefined
      )
      expect(result.infoHash).toBe(swarm.infoHash)
    }
  }, 90_000)

  it('recovers when a previous preview is cancelled mid-flight', async () => {
    // Abort one attempt, then immediately start another for the same torrent.
    const aborted = { aborted: false }
    const inFlight = engine
      .fetchMetadata(swarm.infoHash, swarm.magnetUri, staging, aborted, () => undefined)
      .catch(() => null)
    aborted.aborted = true
    await inFlight

    const result = await engine.fetchMetadata(
      swarm.infoHash,
      swarm.magnetUri,
      staging,
      { aborted: false },
      () => undefined
    )
    expect(result.infoHash).toBe(swarm.infoHash)
  }, 90_000)

  it('surfaces a cancellation instead of hanging', async () => {
    const signal = { aborted: true }
    await expect(
      engine.fetchMetadata(swarm.infoHash, swarm.magnetUri, staging, signal, () => undefined)
    ).rejects.toThrow(/cancelled/i)
  }, 30_000)
})

describe('downloading, selective files, resume and recheck', () => {
  let swarm: LocalSwarm
  let engine: WebTorrentEngine
  let downloadDir: string

  const NAME = 'Download Test'

  beforeAll(async () => {
    swarm = await startLocalSwarm({
      name: NAME,
      files: [
        { path: 'wanted-a.bin', size: 200 * 1024 },
        { path: 'wanted-b.bin', size: 120 * 1024 },
        { path: 'skipped.bin', size: 180 * 1024 }
      ]
    })
    engine = new WebTorrentEngine()
    await engine.start(TEST_CONFIG)
    downloadDir = await makeTempDir('download')
  }, 60_000)

  afterAll(async () => {
    await engine.destroy()
    await swarm.stop()
    await fs.rm(downloadDir, { recursive: true, force: true })
  })

  it('downloads only the selected files and verifies their contents', async () => {
    // Indices must come from the torrent metadata order, not creation order.
    const skippedIndex = swarm.indexOfFile('skipped.bin')

    await engine.add({
      infoHash: swarm.infoHash,
      torrentFile: swarm.torrentFile,
      downloadPath: downloadDir,
      priorities: { [skippedIndex]: 'skip' },
      bitfield: null,
      announce: [],
      urlList: []
    })

    await waitFor(
      () => {
        const stats = engine.stats(swarm.infoHash)
        return Boolean(stats && stats.progress >= 1)
      },
      120_000,
      'selected files to finish downloading'
    )

    const stats = engine.stats(swarm.infoHash)!
    expect(stats.progress).toBe(1)
    // The progress bar must measure the selected subset, not the whole torrent.
    expect(stats.selectedLength).toBe(320 * 1024)
    expect(stats.totalLength).toBe(500 * 1024)

    // Every wanted file must be byte-identical to what the seeder holds.
    for (const file of swarm.files) {
      if (file.path === 'skipped.bin') continue
      const bytes = await fs.readFile(join(downloadDir, NAME, file.path))
      expect(sha256(new Uint8Array(bytes))).toBe(file.sha256)
    }
  }, 150_000)

  it('does not fully download a skipped file', async () => {
    const files = engine.files(swarm.infoHash)
    const skipped = files.find((f) => f.name === 'skipped.bin')!
    expect(skipped.priority).toBe('skip')
    // Pieces straddling a selected/skipped boundary are legitimately fetched,
    // so assert it is not *complete* rather than that it is empty.
    expect(skipped.downloaded).toBeLessThan(skipped.length)
  })

  it('captures resume data with a correctly sized bitfield', async () => {
    const resume = await engine.captureResumeData(swarm.infoHash)
    const stats = engine.stats(swarm.infoHash)!
    expect(resume.bitfield).not.toBeNull()
    expect(resume.bitfield!.length).toBe(Math.ceil(stats.pieceCount / 8))
  })

  it('resumes from saved state without re-downloading', async () => {
    const skippedIndex = swarm.indexOfFile('skipped.bin')
    const resume = await engine.captureResumeData(swarm.infoHash)
    const before = engine.stats(swarm.infoHash)!

    // This is how pause is implemented: capture resume data, then destroy the
    // handle so the network genuinely stops.
    await engine.drop(swarm.infoHash, false)
    expect(engine.has(swarm.infoHash)).toBe(false)
    expect(engine.stats(swarm.infoHash)).toBeNull()

    await engine.add({
      infoHash: swarm.infoHash,
      torrentFile: swarm.torrentFile,
      downloadPath: downloadDir,
      priorities: { [skippedIndex]: 'skip' },
      bitfield: resume.bitfield,
      announce: [],
      urlList: []
    })

    await waitFor(
      () => {
        const s = engine.stats(swarm.infoHash)
        return Boolean(s && s.progress >= 1)
      },
      60_000,
      'resumed torrent to report complete'
    )

    const after = engine.stats(swarm.infoHash)!
    expect(after.progress).toBe(1)
    expect(after.piecesVerified).toBe(before.piecesVerified)
  }, 90_000)

  it('rechecks files on disk and stays complete', async () => {
    await engine.recheck(swarm.infoHash)
    const stats = engine.stats(swarm.infoHash)!
    expect(stats.progress).toBe(1)
  }, 120_000)

  it('detects corruption on recheck and repairs it', async () => {
    const target = join(downloadDir, NAME, 'wanted-b.bin')
    const original = await fs.readFile(target)

    // Corrupt the middle of the file, then force a full hash check.
    const corrupted = Buffer.from(original)
    corrupted.fill(0, 1024, 40 * 1024)
    await fs.writeFile(target, corrupted)

    await engine.recheck(swarm.infoHash)

    const afterCheck = engine.stats(swarm.infoHash)!
    // The check must notice the damage rather than trusting the old bitfield.
    expect(afterCheck.progress).toBeLessThan(1)

    // And the engine must re-fetch the bad pieces from the swarm.
    await waitFor(
      () => {
        const s = engine.stats(swarm.infoHash)
        return Boolean(s && s.progress >= 1)
      },
      120_000,
      'corrupted pieces to be re-downloaded'
    )

    const repaired = await fs.readFile(target)
    const expected = swarm.files.find((f) => f.path === 'wanted-b.bin')!
    expect(sha256(new Uint8Array(repaired))).toBe(expected.sha256)
  }, 180_000)

  it('reports peers and trackers for the details panel', () => {
    const peers = engine.peers(swarm.infoHash)
    expect(peers.length).toBeGreaterThan(0)
    expect(peers[0]!.address).toMatch(/127\.0\.0\.1/)

    const trackers = engine.trackers(swarm.infoHash)
    expect(trackers.length).toBeGreaterThan(0)
    expect(trackers.some((t) => t.url.includes('127.0.0.1'))).toBe(true)
  })

  it('changes a file priority at runtime', () => {
    const files = engine.files(swarm.infoHash)
    const skipped = files.find((f) => f.name === 'skipped.bin')!
    engine.setFilePriority(swarm.infoHash, skipped.index, 'high')
    const updated = engine.files(swarm.infoHash).find((f) => f.index === skipped.index)!
    expect(updated.priority).toBe('high')
  })

  it('refuses to add the same torrent twice', async () => {
    await expect(
      engine.add({
        infoHash: swarm.infoHash,
        torrentFile: swarm.torrentFile,
        downloadPath: downloadDir,
        priorities: {},
        bitfield: null,
        announce: [],
        urlList: []
      })
    ).rejects.toThrow(/already/i)
  })
})

/**
 * Regression test for a real correctness bug found while building this.
 *
 * WebTorrent's `opts.fileModtimes` looks like a companion to `opts.bitfield`,
 * but when the mtimes match it calls `_markAllVerified()` -- marking every piece
 * verified and ignoring the saved bitfield completely. Passing both made a
 * partially downloaded torrent come back reporting 100%, which would also mean
 * advertising and serving pieces we never actually verified.
 *
 * The engine therefore passes the bitfield alone. This test fails if that ever
 * regresses.
 */
describe('resume must never report a partial torrent as complete', () => {
  let swarm: LocalSwarm
  let engine: WebTorrentEngine
  let downloadDir: string
  const NAME = 'Partial Resume'

  beforeAll(async () => {
    swarm = await startLocalSwarm({
      name: NAME,
      files: [
        { path: 'first.bin', size: 160 * 1024 },
        { path: 'second.bin', size: 160 * 1024 }
      ]
    })
    engine = new WebTorrentEngine()
    await engine.start(TEST_CONFIG)
    downloadDir = await makeTempDir('partial')
  }, 60_000)

  afterAll(async () => {
    await engine.destroy()
    await swarm.stop()
    await fs.rm(downloadDir, { recursive: true, force: true })
  })

  it('knows it is still incomplete after a resume', async () => {
    const firstIndex = swarm.indexOfFile('first.bin')
    const secondIndex = swarm.indexOfFile('second.bin')

    // Download only one of the two files, so the torrent as a whole is partial
    // and its files sit on disk with fresh mtimes -- the exact shape that
    // triggered the false-complete bug.
    await engine.add({
      infoHash: swarm.infoHash,
      torrentFile: swarm.torrentFile,
      downloadPath: downloadDir,
      priorities: { [secondIndex]: 'skip' },
      bitfield: null,
      announce: [],
      urlList: []
    })

    await waitFor(
      () => (engine.stats(swarm.infoHash)?.progress ?? 0) >= 1,
      120_000,
      'the selected file to finish'
    )

    const partial = await engine.captureResumeData(swarm.infoHash)
    const pieceCount = engine.stats(swarm.infoHash)!.pieceCount
    const verifiedBefore = engine.stats(swarm.infoHash)!.piecesVerified
    // Sanity: the scenario is only meaningful if the torrent really is partial.
    expect(verifiedBefore).toBeLessThan(pieceCount)

    await engine.drop(swarm.infoHash, false)

    // Take the seeder away. Now the second file CANNOT be obtained, so if the
    // engine reports it as complete that is definitively the false-complete bug
    // rather than a very fast loopback download.
    await swarm.stopSeeder()

    await engine.add({
      infoHash: swarm.infoHash,
      torrentFile: swarm.torrentFile,
      downloadPath: downloadDir,
      priorities: { [firstIndex]: 'normal', [secondIndex]: 'normal' },
      bitfield: partial.bitfield,
      announce: [],
      urlList: []
    })

    // Let fast-resume verification settle.
    await waitFor(
      () => engine.stats(swarm.infoHash) !== null,
      30_000,
      'the resumed torrent to report stats'
    )
    await new Promise((r) => setTimeout(r, 2500))

    const stats = engine.stats(swarm.infoHash)!
    const files = engine.files(swarm.infoHash)
    const second = files.find((f) => f.index === secondIndex)!
    const first = files.find((f) => f.index === firstIndex)!

    // The heart of the regression: a file that was never downloaded must not be
    // reported as complete just because the on-disk mtimes look untouched.
    expect(second.downloaded).toBeLessThan(second.length)
    expect(stats.progress).toBeLessThan(1)
    expect(stats.isDone).toBe(false)
    expect(stats.piecesVerified).toBeLessThan(stats.pieceCount)

    // And the data we did have must survive the round trip untouched.
    expect(first.downloaded).toBe(first.length)
  }, 180_000)

  it('preserves already-downloaded data across the resume', async () => {
    const bytes = await fs.readFile(join(downloadDir, NAME, 'first.bin'))
    const expected = swarm.files.find((f) => f.path === 'first.bin')!
    expect(sha256(new Uint8Array(bytes))).toBe(expected.sha256)
  })
})

/**
 * Regression: a skipped file sitting between two wanted files must not stop the
 * wanted ones completing.
 *
 * WebTorrent's `Selections.remove()` subtracts piece ranges, and adjacent files
 * share the piece on their boundary -- so deselecting the middle file trimmed
 * that piece off its neighbours' selections. The torrent then stalled a few
 * kilobytes short of complete, with no peer or error to explain why.
 */
describe('a skipped file must not strip boundary pieces from its neighbours', () => {
  let swarm: LocalSwarm
  let engine: WebTorrentEngine
  let downloadDir: string
  const NAME = 'Boundary Test'

  beforeAll(async () => {
    swarm = await startLocalSwarm({
      name: NAME,
      // Sizes chosen so no file lands on a piece boundary: every file shares a
      // piece with the one before and after it.
      files: [
        { path: 'a-wanted.bin', size: 40 * 1024 + 300 },
        { path: 'b-skipped.bin', size: 150 * 1024 + 700 },
        { path: 'c-wanted.bin', size: 220 * 1024 + 500 }
      ]
    })
    engine = new WebTorrentEngine()
    await engine.start(TEST_CONFIG)
    downloadDir = await makeTempDir('boundary')
  }, 60_000)

  afterAll(async () => {
    await engine.destroy()
    await swarm.stop()
    await fs.rm(downloadDir, { recursive: true, force: true })
  })

  it('reaches exactly 100% with the middle file skipped', async () => {
    const skipIndex = swarm.indexOfFile('b-skipped.bin')

    await engine.add({
      infoHash: swarm.infoHash,
      torrentFile: swarm.torrentFile,
      downloadPath: downloadDir,
      priorities: { [skipIndex]: 'skip' },
      bitfield: null,
      announce: [],
      urlList: []
    })

    await waitFor(
      () => (engine.stats(swarm.infoHash)?.progress ?? 0) >= 1,
      90_000,
      'the selected files to reach 100%'
    )

    const stats = engine.stats(swarm.infoHash)!
    expect(stats.progress).toBe(1)
    expect(stats.isDone).toBe(true)

    // Both wanted files must be byte-perfect, including the bytes that live in
    // a piece shared with the skipped file.
    for (const name of ['a-wanted.bin', 'c-wanted.bin']) {
      const expected = swarm.files.find((f) => f.path === name)!
      const bytes = await fs.readFile(join(downloadDir, NAME, name))
      expect(bytes.length).toBe(expected.length)
      expect(sha256(new Uint8Array(bytes))).toBe(expected.sha256)
    }
  }, 120_000)

  it('still completes when a file is skipped at runtime', async () => {
    // Switching a file to skip mid-session takes the destructive deselect path.
    const skipIndex = swarm.indexOfFile('b-skipped.bin')
    engine.setFilePriority(swarm.infoHash, skipIndex, 'normal')
    engine.setFilePriority(swarm.infoHash, skipIndex, 'skip')

    await waitFor(
      () => (engine.stats(swarm.infoHash)?.progress ?? 0) >= 1,
      90_000,
      'progress to remain complete after a runtime skip'
    )
    expect(engine.stats(swarm.infoHash)!.progress).toBe(1)
  }, 120_000)
})
