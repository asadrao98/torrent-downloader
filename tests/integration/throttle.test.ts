/**
 * Does the bandwidth limit actually limit anything?
 *
 * A settings field that quietly does nothing is worse than no field at all, so
 * this measures real throughput on a loopback swarm rather than trusting that
 * the engine's throttle API works.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { appendFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { initLogger } from '@main/logger.js'
import { WebTorrentEngine } from '@main/torrent-engine.js'
import type { EngineConfig } from '@main/torrent-engine.js'
import { startLocalSwarm, makeTempDir, waitFor } from './helpers/local-swarm.js'
import type { LocalSwarm } from './helpers/local-swarm.js'

/** Vitest hides console output from passing tests, so measurements go to a file. */
function record(line: string): void {
  appendFileSync('/tmp/throttle-results.txt', line + '\n')
}

const BASE: EngineConfig = {
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

/** 3 MB is big enough that a 300 KB/s cap is unmistakable on loopback. */
const PAYLOAD_BYTES = 3 * 1024 * 1024
const LIMIT = 300 * 1024

let logDir: string

beforeAll(async () => {
  logDir = await makeTempDir('logs')
  initLogger(logDir)
})

afterAll(async () => {
  await fs.rm(logDir, { recursive: true, force: true })
})

async function timeDownload(config: EngineConfig): Promise<{ seconds: number; bytes: number }> {
  const swarm: LocalSwarm = await startLocalSwarm({
    name: 'Throttle Test',
    files: [{ path: 'payload.bin', size: PAYLOAD_BYTES }]
  })
  const dir = await makeTempDir('throttle')
  const engine = new WebTorrentEngine()
  await engine.start(config)

  try {
    const started = Date.now()
    await engine.add({
      infoHash: swarm.infoHash,
      torrentFile: swarm.torrentFile,
      downloadPath: dir,
      priorities: {},
      bitfield: null,
      announce: [],
      urlList: []
    })

    await waitFor(
      () => (engine.stats(swarm.infoHash)?.progress ?? 0) >= 1,
      120_000,
      'payload to download'
    )
    const seconds = (Date.now() - started) / 1000
    const bytes = engine.stats(swarm.infoHash)?.downloaded ?? 0
    return { seconds, bytes }
  } finally {
    await engine.destroy()
    await swarm.stop()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('global download limit', () => {
  it('downloads a 3 MB payload quickly when unlimited', async () => {
    const { seconds, bytes } = await timeDownload(BASE)
    expect(bytes).toBe(PAYLOAD_BYTES)
    // Loopback with no cap should be far faster than the throttled case.
    record(`[throttle] unlimited: ${seconds.toFixed(2)}s`)
    expect(seconds).toBeLessThan(20)
  }, 150_000)

  it('honours a 300 KB/s cap set at startup', async () => {
    const { seconds, bytes } = await timeDownload({ ...BASE, downloadLimit: LIMIT })
    expect(bytes).toBe(PAYLOAD_BYTES)

    const observed = bytes / seconds
    record(
      `[throttle] limited: ${seconds.toFixed(2)}s -> ${(observed / 1024).toFixed(0)} KB/s ` +
        `(cap ${(LIMIT / 1024).toFixed(0)} KB/s)`
    )

    // The floor: 3 MB at 300 KB/s cannot finish faster than ~10s.
    expect(seconds).toBeGreaterThan(7)
    // And the measured rate must be in the neighbourhood of the cap, not wildly
    // over it. Allow generous headroom for burst behaviour at the start.
    expect(observed).toBeLessThan(LIMIT * 2)
  }, 150_000)

  it('applies a limit changed at runtime', async () => {
    const swarm = await startLocalSwarm({
      name: 'Runtime Throttle',
      files: [{ path: 'payload.bin', size: PAYLOAD_BYTES }]
    })
    const dir = await makeTempDir('throttle-rt')
    const engine = new WebTorrentEngine()
    await engine.start(BASE)

    try {
      // Clamp the rate before the transfer starts.
      engine.applyConfig({ ...BASE, downloadLimit: LIMIT })

      const started = Date.now()
      await engine.add({
        infoHash: swarm.infoHash,
        torrentFile: swarm.torrentFile,
        downloadPath: dir,
        priorities: {},
        bitfield: null,
        announce: [],
        urlList: []
      })
      await waitFor(
        () => (engine.stats(swarm.infoHash)?.progress ?? 0) >= 1,
        120_000,
        'throttled payload'
      )
      const seconds = (Date.now() - started) / 1000
      record(`[throttle] runtime-applied: ${seconds.toFixed(2)}s`)
      expect(seconds).toBeGreaterThan(7)
    } finally {
      await engine.destroy()
      await swarm.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
