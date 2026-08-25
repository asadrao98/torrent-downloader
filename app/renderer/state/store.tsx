/**
 * Renderer state.
 *
 * Deliberately plain React: the main process pushes a full snapshot every 500ms,
 * so there is no client-side cache to reconcile and no need for a state library.
 * Everything here is either a copy of what the main process last said, or local
 * UI state (route, toasts, dialogs).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  AppSettings,
  LogEntry,
  MetadataPreview,
  SessionStats,
  TorrentFilter,
  TorrentSnapshot
} from '@shared/types.js'

export interface AppInfo {
  version: string
  engineVersion: string
  utpSupported: boolean
  homeDir: string
  defaultDownloadPath: string
  logPath: string
  platform: string
  arch: string
  electronVersion: string
  nodeVersion: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  title: string
  message?: string
}

export interface Route {
  name: 'torrents' | 'add' | 'details' | 'settings' | 'logs'
  filter: TorrentFilter
  infoHash: string | null
  /** Set when the route asked us to pre-fill from the clipboard. */
  paste: boolean
}

const DEFAULT_ROUTE: Route = { name: 'torrents', filter: 'all', infoHash: null, paste: false }

export function parseRoute(path: string): Route {
  const [pathname, query] = path.split('?')
  const parts = (pathname ?? '').split('/').filter(Boolean)
  const paste = new URLSearchParams(query ?? '').get('paste') === '1'

  if (parts[0] === 'add') return { ...DEFAULT_ROUTE, name: 'add', paste }
  if (parts[0] === 'settings') return { ...DEFAULT_ROUTE, name: 'settings' }
  if (parts[0] === 'logs') return { ...DEFAULT_ROUTE, name: 'logs' }
  if (parts[0] === 'torrent' && parts[1]) {
    return { ...DEFAULT_ROUTE, name: 'details', infoHash: parts[1] }
  }
  if (parts[0] === 'torrents') {
    const filter = parts[1]
    const valid: TorrentFilter[] = [
      'all',
      'downloading',
      'seeding',
      'completed',
      'paused',
      'errors'
    ]
    return {
      ...DEFAULT_ROUTE,
      name: 'torrents',
      filter: valid.includes(filter as TorrentFilter) ? (filter as TorrentFilter) : 'all'
    }
  }
  return DEFAULT_ROUTE
}

interface AppState {
  torrents: TorrentSnapshot[]
  stats: SessionStats | null
  settings: AppSettings | null
  info: AppInfo | null
  logs: LogEntry[]
  preview: MetadataPreview | null
  route: Route
  toasts: Toast[]
  /** A magnet that arrived from outside the app and needs confirming. */
  externalMagnet: string | null
  ready: boolean
}

interface AppActions {
  navigate(path: string): void
  toast(toast: Omit<Toast, 'id'>): void
  dismissToast(id: number): void
  setPreview(preview: MetadataPreview | null): void
  refreshSettings(): Promise<void>
  refreshLogs(): Promise<void>
  clearExternalMagnet(): void
}

const StateContext = createContext<AppState | null>(null)
const ActionsContext = createContext<AppActions | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [torrents, setTorrents] = useState<TorrentSnapshot[]>([])
  const [stats, setStats] = useState<SessionStats | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [preview, setPreview] = useState<MetadataPreview | null>(null)
  const [route, setRoute] = useState<Route>(DEFAULT_ROUTE)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [externalMagnet, setExternalMagnet] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const toastId = useRef(1)

  const toast = useCallback((next: Omit<Toast, 'id'>) => {
    const id = toastId.current++
    setToasts((current) => [...current, { ...next, id }])
    // Errors stay long enough to read; confirmations get out of the way.
    const ttl = next.kind === 'error' ? 8000 : 3200
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id))
    }, ttl)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const navigate = useCallback((path: string) => {
    setRoute(parseRoute(path))
  }, [])

  const refreshSettings = useCallback(async () => {
    const next = await window.torrentApi.getSettings()
    setSettings(next)
  }, [])

  const refreshLogs = useCallback(async () => {
    const entries = await window.torrentApi.readLogs()
    setLogs(entries)
  }, [])

  const clearExternalMagnet = useCallback(() => setExternalMagnet(null), [])

  // Initial load and subscriptions.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [initialSettings, appInfo, listing] = await Promise.all([
          window.torrentApi.getSettings(),
          window.torrentApi.appInfo(),
          window.torrentApi.listTorrents()
        ])
        if (cancelled) return
        setSettings(initialSettings)
        setInfo(appInfo)
        setTorrents(listing.torrents)
        setStats(listing.stats)
        setReady(true)
      } catch {
        if (!cancelled) setReady(true)
      }
    })()

    const offTorrents = window.torrentApi.onTorrentsUpdate((payload) => {
      setTorrents(payload.torrents)
      setStats(payload.stats)
    })

    const offPreview = window.torrentApi.onPreviewUpdate((next) => {
      // Ignore updates for a preview the user has already moved on from.
      setPreview((current) => (current && current.previewId !== next.previewId ? current : next))
    })

    const offSettings = window.torrentApi.onSettingsChanged((next) => setSettings(next))

    const offLog = window.torrentApi.onLogEntry((entry) => {
      setLogs((current) => [...current.slice(-499), entry])
    })

    const offNav = window.torrentApi.onNavigate(({ route: path }) => setRoute(parseRoute(path)))

    const offMagnet = window.torrentApi.onExternalMagnet(({ uri }) => setExternalMagnet(uri))

    const offError = window.torrentApi.onErrorDialog(({ title, message }) => {
      toast({ kind: 'error', title, message })
    })

    return () => {
      cancelled = true
      offTorrents()
      offPreview()
      offSettings()
      offLog()
      offNav()
      offMagnet()
      offError()
    }
  }, [toast])

  // Reflect the theme choice on the root element so CSS can honour an explicit
  // light/dark override rather than only the OS setting.
  useEffect(() => {
    const theme = settings?.appearance.theme ?? 'system'
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [settings?.appearance.theme])

  const state = useMemo<AppState>(
    () => ({
      torrents,
      stats,
      settings,
      info,
      logs,
      preview,
      route,
      toasts,
      externalMagnet,
      ready
    }),
    [torrents, stats, settings, info, logs, preview, route, toasts, externalMagnet, ready]
  )

  const actions = useMemo<AppActions>(
    () => ({
      navigate,
      toast,
      dismissToast,
      setPreview,
      refreshSettings,
      refreshLogs,
      clearExternalMagnet
    }),
    [navigate, toast, dismissToast, refreshSettings, refreshLogs, clearExternalMagnet]
  )

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  )
}

export function useAppState(): AppState {
  const value = useContext(StateContext)
  if (!value) throw new Error('useAppState used outside AppProvider')
  return value
}

export function useAppActions(): AppActions {
  const value = useContext(ActionsContext)
  if (!value) throw new Error('useAppActions used outside AppProvider')
  return value
}

/** Applies a sidebar filter to the torrent list. */
export function filterTorrents(
  torrents: TorrentSnapshot[],
  filter: TorrentFilter
): TorrentSnapshot[] {
  switch (filter) {
    case 'downloading':
      // "Downloading" covers everything actively working towards completion,
      // including the metadata and checking phases -- that is what a user means.
      return torrents.filter(
        (t) =>
          t.status === 'downloading' ||
          t.status === 'fetching-metadata' ||
          t.status === 'checking' ||
          t.status === 'waiting'
      )
    case 'seeding':
      return torrents.filter((t) => t.status === 'seeding')
    case 'completed':
      return torrents.filter((t) => t.status === 'completed' || t.status === 'seeding')
    case 'paused':
      return torrents.filter((t) => t.status === 'paused')
    case 'errors':
      return torrents.filter((t) => t.status === 'error')
    default:
      return torrents
  }
}

/**
 * Wraps an IPC action so every failure surfaces as a toast instead of an
 * unhandled rejection, and callers stay one-liners.
 */
export function useOperation() {
  const { toast } = useAppActions()
  return useCallback(
    async (
      run: () => Promise<{ ok: boolean; error?: string }>,
      options?: { success?: string; failure?: string }
    ): Promise<boolean> => {
      try {
        const result = await run()
        if (!result.ok) {
          toast({
            kind: 'error',
            title: options?.failure ?? 'Action failed',
            message: result.error
          })
          return false
        }
        if (options?.success) toast({ kind: 'success', title: options.success })
        return true
      } catch (err) {
        toast({
          kind: 'error',
          title: options?.failure ?? 'Action failed',
          message: err instanceof Error ? err.message : String(err)
        })
        return false
      }
    },
    [toast]
  )
}
