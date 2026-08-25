/**
 * Magnet URI parsing and validation.
 *
 * A magnet link is fully untrusted input: it arrives from the clipboard, a
 * dropped file, or the `magnet:` URL scheme (i.e. from any web page the user
 * clicks). Everything here is defensive -- we allowlist tracker schemes, cap
 * collection sizes, strip control characters from anything we will display, and
 * never hand a value onward without validating it first.
 *
 * Pure module: no Node, no DOM, no dependencies. Usable from both processes.
 */

import type { MagnetParseResult, ParsedMagnet } from './types.js'

/** Announce schemes we are willing to hand to the engine. */
const ALLOWED_TRACKER_PROTOCOLS = new Set(['http:', 'https:', 'udp:', 'ws:', 'wss:'])
/** Web seeds are plain HTTP range requests (BEP 19). */
const ALLOWED_WEB_SEED_PROTOCOLS = new Set(['http:', 'https:'])

/** Hardening caps. A hostile magnet should not be able to make us allocate freely. */
const MAX_URI_LENGTH = 64 * 1024
const MAX_TRACKERS = 200
const MAX_WEB_SEEDS = 50
const MAX_PEER_ADDRESSES = 50
const MAX_KEYWORDS = 32
const MAX_DISPLAY_NAME_LENGTH = 512

const HEX_INFO_HASH = /^[0-9a-f]{40}$/i
const BASE32_INFO_HASH = /^[A-Z2-7]{32}$/i
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Strips characters that have no business being rendered in our UI or written
 * to a log: C0/C1 controls, and the bidi overrides that let a name lie about
 * its own extension (the classic U+202E "exe<RLO>gnp." trick).
 */
export function stripUnsafeDisplayChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    // Bidi overrides / embeddings and the invisible formatting range.
    if (code >= 0x202a && code <= 0x202e) continue
    if (code >= 0x2066 && code <= 0x2069) continue
    if (code === 0x200e || code === 0x200f || code === 0x061c) continue
    out += ch
  }
  return out.trim()
}

/** Decodes RFC 4648 base32 (no padding required) into bytes. Returns null if invalid. */
export function decodeBase32(input: string): Uint8Array | null {
  const cleaned = input.toUpperCase().replace(/=+$/, '')
  if (cleaned.length === 0) return null

  let bits = 0
  let value = 0
  const out: number[] = []

  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  // Any leftover bits must be zero padding, not dropped data.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) {
    // Tolerate the common case where the encoder left non-zero padding bits;
    // the byte output is still well defined. Only reject impossible lengths.
    if (bits >= 5) return null
  }
  return new Uint8Array(out)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Normalises an `xt` value into a lowercase hex v1 info hash.
 * Returns the hash, or a reason it could not be used.
 */
function readExactTopic(
  xt: string
): { kind: 'v1'; infoHash: string } | { kind: 'v2' } | { kind: 'invalid' } | { kind: 'other' } {
  const trimmed = xt.trim()
  const lower = trimmed.toLowerCase()

  if (lower.startsWith('urn:btih:')) {
    const raw = trimmed.slice('urn:btih:'.length).trim()
    if (HEX_INFO_HASH.test(raw)) return { kind: 'v1', infoHash: raw.toLowerCase() }
    if (BASE32_INFO_HASH.test(raw)) {
      const bytes = decodeBase32(raw)
      if (bytes && bytes.length === 20) return { kind: 'v1', infoHash: bytesToHex(bytes) }
    }
    return { kind: 'invalid' }
  }

  // BitTorrent v2. `1220` is the multihash prefix for sha256/32.
  if (lower.startsWith('urn:btmh:')) return { kind: 'v2' }

  return { kind: 'other' }
}

/** Validates a tracker announce URL against the scheme allowlist. */
export function isValidTrackerUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    if (!ALLOWED_TRACKER_PROTOCOLS.has(url.protocol)) return false
    // A tracker with no host is unusable and often a sign of a malformed magnet.
    return url.hostname.length > 0
  } catch {
    return false
  }
}

/** Validates a BEP 19 web seed URL. */
export function isValidWebSeedUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    return ALLOWED_WEB_SEED_PROTOCOLS.has(url.protocol) && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Validates an `x.pe` peer address. Accepts `host:port` and `[v6]:port`.
 * The port must be a real port number.
 */
export function isValidPeerAddress(candidate: string): boolean {
  const trimmed = candidate.trim()
  const match = /^(\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5})$/.exec(trimmed)
  if (!match) return false
  const port = Number(match[2])
  return port > 0 && port <= 65535
}

function dedupe(values: string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= cap) break
  }
  return out
}

/** Rebuilds a canonical magnet URI from validated parts. */
export function buildMagnetUri(parts: {
  infoHash: string
  name?: string | null
  trackers?: string[]
  webSeeds?: string[]
  peerAddresses?: string[]
}): string {
  const params: string[] = [`xt=urn:btih:${parts.infoHash}`]
  if (parts.name) params.push(`dn=${encodeURIComponent(parts.name)}`)
  for (const tr of parts.trackers ?? []) params.push(`tr=${encodeURIComponent(tr)}`)
  for (const ws of parts.webSeeds ?? []) params.push(`ws=${encodeURIComponent(ws)}`)
  for (const pe of parts.peerAddresses ?? []) params.push(`x.pe=${encodeURIComponent(pe)}`)
  return `magnet:?${params.join('&')}`
}

/**
 * Parses and validates a magnet URI.
 *
 * Returns a discriminated result rather than throwing, so callers on both sides
 * of the IPC boundary can render a specific message without a try/catch.
 */
export function parseMagnet(input: string): MagnetParseResult {
  if (typeof input !== 'string') {
    return { ok: false, code: 'empty', message: 'No magnet link was provided.' }
  }

  const raw = input.trim()
  if (raw.length === 0) {
    return { ok: false, code: 'empty', message: 'No magnet link was provided.' }
  }
  if (raw.length > MAX_URI_LENGTH) {
    return {
      ok: false,
      code: 'malformed-uri',
      message: 'This magnet link is unreasonably long and was rejected.'
    }
  }
  if (!/^magnet:\?/i.test(raw)) {
    // Give a targeted message for the very common "pasted a web page" case.
    if (/^https?:\/\//i.test(raw)) {
      return {
        ok: false,
        code: 'not-a-magnet',
        message: 'That looks like a web address, not a magnet link. Magnet links start with "magnet:?".'
      }
    }
    return {
      ok: false,
      code: 'not-a-magnet',
      message: 'This is not a magnet link. Magnet links start with "magnet:?".'
    }
  }

  const queryStart = raw.indexOf('?')
  const query = raw.slice(queryStart + 1)

  let params: URLSearchParams
  try {
    params = new URLSearchParams(query)
  } catch {
    return { ok: false, code: 'malformed-uri', message: 'This magnet link could not be read.' }
  }

  // ----- info hash -------------------------------------------------------
  const topics = params.getAll('xt')
  if (topics.length === 0) {
    return {
      ok: false,
      code: 'missing-info-hash',
      message: 'This magnet link has no info hash (the "xt" parameter is missing).'
    }
  }

  let infoHash: string | null = null
  let sawV2 = false
  let sawInvalid = false
  for (const topic of topics) {
    const result = readExactTopic(topic)
    if (result.kind === 'v1') {
      infoHash = result.infoHash
      break // a hybrid magnet's v1 hash is the one WebTorrent can use
    }
    if (result.kind === 'v2') sawV2 = true
    if (result.kind === 'invalid') sawInvalid = true
  }

  if (!infoHash) {
    if (sawV2) {
      return {
        ok: false,
        code: 'unsupported-info-hash-version',
        message:
          'This is a BitTorrent v2-only magnet link. This app supports v1 and hybrid torrents.'
      }
    }
    if (sawInvalid) {
      return {
        ok: false,
        code: 'invalid-info-hash',
        message:
          'The info hash in this magnet link is not valid. It must be 40 hex characters or 32 base32 characters.'
      }
    }
    return {
      ok: false,
      code: 'missing-info-hash',
      message: 'This magnet link has no BitTorrent info hash.'
    }
  }

  // ----- display name ----------------------------------------------------
  const rawName = params.get('dn')
  let name: string | null = null
  if (rawName) {
    const cleaned = stripUnsafeDisplayChars(rawName).slice(0, MAX_DISPLAY_NAME_LENGTH)
    if (cleaned.length > 0) name = cleaned
  }

  // ----- trackers / web seeds / peers -----------------------------------
  const trackers = dedupe(
    params.getAll('tr').map((t) => t.trim()).filter(isValidTrackerUrl),
    MAX_TRACKERS
  )
  const webSeeds = dedupe(
    params.getAll('ws').map((w) => w.trim()).filter(isValidWebSeedUrl),
    MAX_WEB_SEEDS
  )
  const peerAddresses = dedupe(
    params.getAll('x.pe').map((p) => p.trim()).filter(isValidPeerAddress),
    MAX_PEER_ADDRESSES
  )
  const keywords = dedupe(
    params
      .getAll('kt')
      .flatMap((k) => k.split(/[\s+]+/))
      .map((k) => stripUnsafeDisplayChars(k))
      .filter((k) => k.length > 0),
    MAX_KEYWORDS
  )

  // ----- exact length ----------------------------------------------------
  let exactLength: number | null = null
  const rawLength = params.get('xl')
  if (rawLength && /^\d{1,19}$/.test(rawLength.trim())) {
    const parsed = Number(rawLength.trim())
    if (Number.isSafeInteger(parsed) && parsed >= 0) exactLength = parsed
  }

  // ----- everything else, for the details panel --------------------------
  const known = new Set(['xt', 'dn', 'tr', 'ws', 'x.pe', 'kt', 'xl'])
  const extraParams: Array<{ key: string; value: string }> = []
  for (const [key, value] of params.entries()) {
    if (known.has(key)) continue
    if (extraParams.length >= 32) break
    extraParams.push({
      key: stripUnsafeDisplayChars(key).slice(0, 64),
      value: stripUnsafeDisplayChars(value).slice(0, 256)
    })
  }

  const value: ParsedMagnet = {
    infoHash,
    name,
    trackers,
    webSeeds,
    peerAddresses,
    keywords,
    exactLength,
    normalizedUri: buildMagnetUri({ infoHash, name, trackers, webSeeds, peerAddresses }),
    extraParams
  }

  return { ok: true, value }
}

/** Convenience predicate for the clipboard / drag-and-drop paths. */
export function isMagnetUri(input: string): boolean {
  return parseMagnet(input).ok
}

/**
 * Pulls the first magnet URI out of a blob of dropped or pasted text.
 * Browsers and mail clients love to wrap links in angle brackets or trailing
 * punctuation, so we trim those.
 */
export function extractMagnetUri(text: string): string | null {
  const match = /magnet:\?[^\s"'<>\]]+/i.exec(text)
  if (!match) return null
  const candidate = match[0].replace(/[.,;)]+$/, '')
  return parseMagnet(candidate).ok ? candidate : null
}
