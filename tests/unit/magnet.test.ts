import { describe, it, expect } from 'vitest'
import {
  parseMagnet,
  isMagnetUri,
  extractMagnetUri,
  decodeBase32,
  isValidTrackerUrl,
  isValidWebSeedUrl,
  isValidPeerAddress,
  buildMagnetUri,
  stripUnsafeDisplayChars
} from '@shared/magnet.js'

const HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
const HASH_UPPER = HASH.toUpperCase()

/** Right-to-left override; the character used to fake a file extension. */
const RLO = String.fromCodePoint(0x202e)
const NUL = String.fromCodePoint(0)

function ok(uri: string) {
  const result = parseMagnet(uri)
  if (!result.ok) throw new Error(`expected parse to succeed, got ${result.code}: ${result.message}`)
  return result.value
}

function fail(uri: string) {
  const result = parseMagnet(uri)
  if (result.ok) throw new Error('expected parse to fail, but it succeeded')
  return result
}

/** RFC 4648 base32 encoder, used to build a base32 magnet for the test. */
function toBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(value >>> bits) & 31]
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

describe('parseMagnet — valid input', () => {
  it('parses a bare info-hash magnet', () => {
    const m = ok(`magnet:?xt=urn:btih:${HASH}`)
    expect(m.infoHash).toBe(HASH)
    expect(m.name).toBeNull()
    expect(m.trackers).toEqual([])
  })

  it('lowercases an uppercase hex info hash', () => {
    expect(ok(`magnet:?xt=urn:btih:${HASH_UPPER}`).infoHash).toBe(HASH)
  })

  it('accepts a 32-character base32 info hash and converts it to hex', () => {
    const b32 = toBase32(Uint8Array.from(Buffer.from(HASH, 'hex')))
    expect(b32).toHaveLength(32)
    expect(ok(`magnet:?xt=urn:btih:${b32}`).infoHash).toBe(HASH)
  })

  it('extracts the display name', () => {
    expect(ok(`magnet:?xt=urn:btih:${HASH}&dn=Ubuntu+22.04`).name).toBe('Ubuntu 22.04')
  })

  it('decodes URL-encoded parameters', () => {
    const m = ok(
      `magnet:?xt=urn%3Abtih%3A${HASH}&dn=My%20File%20%282024%29&tr=udp%3A%2F%2Ftracker.example.com%3A1337%2Fannounce`
    )
    expect(m.infoHash).toBe(HASH)
    expect(m.name).toBe('My File (2024)')
    expect(m.trackers).toEqual(['udp://tracker.example.com:1337/announce'])
  })

  it('collects multiple trackers and dedupes them', () => {
    const m = ok(
      `magnet:?xt=urn:btih:${HASH}` +
        '&tr=udp%3A%2F%2Fa.example.com%3A1337%2Fannounce' +
        '&tr=udp%3A%2F%2Fb.example.com%3A1337%2Fannounce' +
        '&tr=udp%3A%2F%2Fa.example.com%3A1337%2Fannounce'
    )
    expect(m.trackers).toEqual([
      'udp://a.example.com:1337/announce',
      'udp://b.example.com:1337/announce'
    ])
  })

  it('collects web seeds, peer addresses, keywords and exact length', () => {
    const m = ok(
      `magnet:?xt=urn:btih:${HASH}` +
        '&ws=https%3A%2F%2Fcdn.example.com%2Ffile.iso' +
        '&x.pe=203.0.113.5%3A51413' +
        '&x.pe=%5B2001%3Adb8%3A%3A1%5D%3A6881' +
        '&kt=linux+iso' +
        '&xl=4509715968'
    )
    expect(m.webSeeds).toEqual(['https://cdn.example.com/file.iso'])
    expect(m.peerAddresses).toEqual(['203.0.113.5:51413', '[2001:db8::1]:6881'])
    expect(m.keywords).toEqual(['linux', 'iso'])
    expect(m.exactLength).toBe(4509715968)
  })

  it('handles a hybrid v1+v2 magnet by using the v1 hash', () => {
    const v2 = '1220'.padEnd(68, 'a')
    const m = ok(`magnet:?xt=urn:btmh:${v2}&xt=urn:btih:${HASH}`)
    expect(m.infoHash).toBe(HASH)
  })

  it('records unrecognised parameters instead of discarding them', () => {
    const m = ok(`magnet:?xt=urn:btih:${HASH}&as=https%3A%2F%2Fexample.com%2Ff&xs=whatever`)
    const keys = m.extraParams.map((p) => p.key)
    expect(keys).toContain('as')
    expect(keys).toContain('xs')
  })

  it('produces a normalized URI that round-trips', () => {
    const m = ok(`magnet:?xt=urn:btih:${HASH_UPPER}&dn=Test&tr=udp%3A%2F%2Ft.example.com%3A80%2Fa`)
    const again = ok(m.normalizedUri)
    expect(again.infoHash).toBe(m.infoHash)
    expect(again.name).toBe(m.name)
    expect(again.trackers).toEqual(m.trackers)
  })
})

describe('parseMagnet — rejects invalid input', () => {
  it('rejects empty input', () => {
    expect(fail('').code).toBe('empty')
    expect(fail('   ').code).toBe('empty')
  })

  it('rejects non-magnet strings', () => {
    expect(fail('hello world').code).toBe('not-a-magnet')
    expect(fail('ftp://example.com/x.torrent').code).toBe('not-a-magnet')
  })

  it('gives a targeted message when a web address was pasted', () => {
    const result = fail('https://example.com/some/page')
    expect(result.code).toBe('not-a-magnet')
    expect(result.message).toMatch(/web address/i)
  })

  it('rejects a magnet with no xt parameter', () => {
    expect(fail('magnet:?dn=NoHash&tr=udp%3A%2F%2Ft.example.com%3A80%2Fa').code).toBe(
      'missing-info-hash'
    )
  })

  it('rejects a malformed info hash', () => {
    expect(fail('magnet:?xt=urn:btih:nothex').code).toBe('invalid-info-hash')
    expect(fail(`magnet:?xt=urn:btih:${HASH.slice(0, 39)}`).code).toBe('invalid-info-hash')
    expect(fail(`magnet:?xt=urn:btih:${HASH}ff`).code).toBe('invalid-info-hash')
    expect(fail(`magnet:?xt=urn:btih:${'z'.repeat(40)}`).code).toBe('invalid-info-hash')
  })

  it('rejects a v2-only magnet with an explanatory code', () => {
    expect(fail(`magnet:?xt=urn:btmh:${'1220'.padEnd(68, 'a')}`).code).toBe(
      'unsupported-info-hash-version'
    )
  })

  it('rejects an absurdly long URI', () => {
    expect(fail(`magnet:?xt=urn:btih:${HASH}&dn=${'a'.repeat(70_000)}`).code).toBe('malformed-uri')
  })

  // Untrusted-input hardening: a magnet must not smuggle a javascript:/file:
  // URL into the tracker list we hand to the engine.
  it('drops trackers with disallowed schemes', () => {
    const m = ok(
      `magnet:?xt=urn:btih:${HASH}` +
        '&tr=javascript%3Aalert(1)' +
        '&tr=file%3A%2F%2F%2Fetc%2Fpasswd' +
        '&tr=data%3Atext%2Fhtml%2Cx' +
        '&tr=udp%3A%2F%2Fgood.example.com%3A1337%2Fannounce'
    )
    expect(m.trackers).toEqual(['udp://good.example.com:1337/announce'])
  })

  it('drops web seeds that are not http(s)', () => {
    const m = ok(`magnet:?xt=urn:btih:${HASH}&ws=file%3A%2F%2F%2Fetc%2Fpasswd&ws=ftp%3A%2F%2Fx%2Fy`)
    expect(m.webSeeds).toEqual([])
  })

  it('drops malformed peer addresses', () => {
    const m = ok(
      `magnet:?xt=urn:btih:${HASH}&x.pe=notanaddress&x.pe=1.2.3.4%3A99999&x.pe=1.2.3.4%3A0`
    )
    expect(m.peerAddresses).toEqual([])
  })

  it('strips bidi overrides from the display name', () => {
    const m = ok(`magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(`safe${RLO}name`)}`)
    expect(m.name).toBe('safename')
  })

  it('strips a NUL byte from the display name', () => {
    const m = ok(`magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(`a${NUL}b`)}`)
    expect(m.name).toBe('ab')
  })
})

describe('helpers', () => {
  it('isMagnetUri agrees with parseMagnet', () => {
    expect(isMagnetUri(`magnet:?xt=urn:btih:${HASH}`)).toBe(true)
    expect(isMagnetUri('nope')).toBe(false)
  })

  it('extracts a magnet from surrounding text', () => {
    const text = `Here you go: <magnet:?xt=urn:btih:${HASH}&dn=Thing> enjoy.`
    expect(extractMagnetUri(text)).toBe(`magnet:?xt=urn:btih:${HASH}&dn=Thing`)
  })

  it('strips trailing punctuation when extracting', () => {
    expect(extractMagnetUri(`see magnet:?xt=urn:btih:${HASH}.`)).toBe(`magnet:?xt=urn:btih:${HASH}`)
  })

  it('returns null when there is no magnet in the text', () => {
    expect(extractMagnetUri('just some words')).toBeNull()
  })

  it('decodeBase32 rejects invalid alphabets', () => {
    expect(decodeBase32('0189')).toBeNull()
    expect(decodeBase32('')).toBeNull()
  })

  it('validates tracker, web seed and peer address forms', () => {
    expect(isValidTrackerUrl('udp://t.example.com:1337/announce')).toBe(true)
    expect(isValidTrackerUrl('wss://t.example.com')).toBe(true)
    expect(isValidTrackerUrl('udp://')).toBe(false)
    expect(isValidWebSeedUrl('http://x.example.com/a')).toBe(true)
    expect(isValidWebSeedUrl('udp://x.example.com/a')).toBe(false)
    expect(isValidPeerAddress('10.0.0.1:6881')).toBe(true)
    expect(isValidPeerAddress('10.0.0.1')).toBe(false)
  })

  it('buildMagnetUri emits parseable output', () => {
    const uri = buildMagnetUri({
      infoHash: HASH,
      name: 'A B',
      trackers: ['udp://t.example.com:80/a'],
      webSeeds: ['https://cdn.example.com/f'],
      peerAddresses: ['1.2.3.4:6881']
    })
    const m = ok(uri)
    expect(m.name).toBe('A B')
    expect(m.trackers).toHaveLength(1)
    expect(m.webSeeds).toHaveLength(1)
    expect(m.peerAddresses).toHaveLength(1)
  })

  it('stripUnsafeDisplayChars keeps ordinary unicode', () => {
    expect(stripUnsafeDisplayChars('Ubuntu 日本語 — ok')).toBe('Ubuntu 日本語 — ok')
  })
})
