/**
 * Ambient declarations for the BitTorrent packages, which ship no types.
 *
 * These describe only the surface this app actually uses, and the engine keeps
 * them behind `app/main/torrent-engine.ts` so the loose typing cannot leak into
 * the rest of the codebase.
 */

declare module 'webtorrent' {
  interface WebTorrentClient {
    add(torrentId: unknown, opts?: Record<string, unknown>): unknown
    seed(input: unknown, opts?: Record<string, unknown>, cb?: (torrent: unknown) => void): unknown
    remove(torrentId: unknown, opts?: Record<string, unknown>, cb?: (err?: Error) => void): void
    destroy(cb?: (err?: Error) => void): void
    throttleDownload(rate: number): void
    throttleUpload(rate: number): void
    on(event: string, listener: (...args: never[]) => void): void
    readonly downloadSpeed: number
    readonly uploadSpeed: number
    readonly progress: number
    readonly torrents: unknown[]
    torrentPort: number
    maxConns: number
    dht: unknown
    [key: string]: unknown
  }

  interface WebTorrentConstructor {
    new (opts?: Record<string, unknown>): WebTorrentClient
    /** True when the optional native `utp-native` addon loaded successfully. */
    UTP_SUPPORT: boolean
    WEBRTC_SUPPORT: boolean
    VERSION: string
  }

  const WebTorrent: WebTorrentConstructor
  export default WebTorrent
}

declare module 'parse-torrent' {
  /**
   * Resolves a magnet URI, `.torrent` bytes, or an already-parsed object into a
   * parsed torrent. The returned shape is intentionally loose; see
   * `app/main/torrent-engine.ts` for the fields relied on.
   */
  function parseTorrent(input: unknown): Promise<Record<string, unknown>>
  export default parseTorrent
  export function toMagnetURI(parsed: unknown): string
  export function toTorrentFile(parsed: unknown): Uint8Array
}

declare module 'bittorrent-tracker' {
  export class Server {
    constructor(opts?: Record<string, unknown>)
    listen(port: number, hostname?: string, cb?: () => void): void
    close(cb?: () => void): void
    on(event: string, listener: (...args: never[]) => void): void
    once(event: string, listener: (...args: never[]) => void): void
    http: { address(): { port: number } | string | null }
    [key: string]: unknown
  }
}

declare module 'bencode' {
  const bencode: {
    encode(value: unknown): Uint8Array
    decode(value: Uint8Array, encoding?: string): unknown
  }
  export default bencode
}

declare module 'bitfield' {
  export default class BitField {
    constructor(data: number | Uint8Array, opts?: { grow?: number })
    get(index: number): boolean
    set(index: number, value?: boolean): void
    buffer: Uint8Array
  }
}
