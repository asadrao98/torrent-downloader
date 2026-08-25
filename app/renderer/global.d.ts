import type { TorrentDownloaderApi } from '../preload/preload.js'

declare global {
  interface Window {
    /** The only channel to the main process. See app/preload/preload.ts. */
    torrentApi: TorrentDownloaderApi
  }
}

export {}
