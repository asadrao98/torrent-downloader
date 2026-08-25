/**
 * App shell: sidebar, title bar, routing, drag-and-drop and global overlays.
 */

import { useCallback, useEffect, useState } from 'react'
import { formatSpeed } from '@shared/format.js'
import { Sidebar } from './components/Sidebar.js'
import { Button, Dialog, Spinner, Toasts } from './components/Primitives.js'
import { SpeedLimitButton } from './components/SpeedLimitButton.js'
import { IconFile, IconMagnet } from './components/Icons.js'
import { AddTorrentPage } from './pages/AddTorrentPage.js'
import { TorrentsPage } from './pages/TorrentsPage.js'
import { TorrentDetailsPage } from './pages/TorrentDetailsPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { LogsPage } from './pages/LogsPage.js'
import { useAppActions, useAppState, useOperation } from './state/store.js'

const TITLES: Record<string, string> = {
  all: 'All Torrents',
  downloading: 'Downloading',
  seeding: 'Seeding',
  completed: 'Completed',
  paused: 'Paused',
  errors: 'Errors'
}

export function App() {
  const state = useAppState()
  const { navigate, dismissToast, setPreview, clearExternalMagnet, toast } = useAppActions()
  const run = useOperation()

  const [dragging, setDragging] = useState(false)

  const { route, torrents, stats, externalMagnet, ready, settings } = state

  // ------------------------------------------------------------ drag & drop

  useEffect(() => {
    let depth = 0

    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent) => {
      event.preventDefault()
      depth += 1
      if (hasFiles(event)) setDragging(true)
    }

    const onDragOver = (event: DragEvent) => {
      // Without this the drop never fires and the OS animates the file back.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent) => {
      event.preventDefault()
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      depth = 0
      setDragging(false)
      void handleDrop(event)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = useCallback(
    async (event: DragEvent) => {
      const transfer = event.dataTransfer
      if (!transfer) return

      // A dropped magnet link arrives as text.
      const text = transfer.getData('text/plain') || transfer.getData('text/uri-list')
      if (text && text.includes('magnet:')) {
        const parsed = await window.torrentApi.parseMagnet(text.trim())
        if (!parsed.ok) {
          toast({ kind: 'error', title: 'Invalid magnet link', message: parsed.message })
          return
        }
        navigate('/add')
        setPreview(await window.torrentApi.startPreview(text.trim()))
        return
      }

      const file = transfer.files?.[0]
      if (!file) return

      if (!file.name.toLowerCase().endsWith('.torrent')) {
        toast({
          kind: 'error',
          title: 'Unsupported file',
          message: 'Drop a .torrent file, or paste a magnet link instead.'
        })
        return
      }

      // The renderer is sandboxed and has no filesystem access, so the bytes are
      // read here and sent over IPC rather than passing a path.
      const bytes = new Uint8Array(await file.arrayBuffer())
      navigate('/add')
      setPreview(await window.torrentApi.startPreviewFromFile(bytes))
    },
    [navigate, setPreview, toast]
  )

  // -------------------------------------------------------------- title bar

  const title =
    route.name === 'add'
      ? 'Add Torrent'
      : route.name === 'settings'
        ? 'Settings'
        : route.name === 'logs'
          ? 'Logs'
          : route.name === 'details'
            ? 'Torrent Details'
            : (TITLES[route.filter] ?? 'Torrents')

  if (!ready) {
    return (
      <div className="splash">
        <Spinner />
        <span>Starting Torrent Downloader…</span>
      </div>
    )
  }

  const restoring = stats && !stats.restored

  return (
    <div className="app">
      <Sidebar route={route} torrents={torrents} stats={stats} onNavigate={navigate} />

      <div className="main">
        <header className="titlebar">
          <div className="titlebar__title">{title}</div>
          <div className="titlebar__spacer" />
          <div className="titlebar__actions">
            {stats && (stats.downloadSpeed > 0 || stats.uploadSpeed > 0) ? (
              <span className="tiny nums" style={{ marginRight: 4 }}>
                ↓ {formatSpeed(stats.downloadSpeed)} · ↑ {formatSpeed(stats.uploadSpeed)}
              </span>
            ) : null}
            {settings ? (
              <SpeedLimitButton
                settings={settings}
                onOpenSettings={() => navigate('/settings')}
              />
            ) : null}
            {torrents.length > 0 ? (
              <>
                <Button onClick={() => void run(() => window.torrentApi.pauseAll())}>
                  Pause All
                </Button>
                <Button onClick={() => void run(() => window.torrentApi.resumeAll())}>
                  Resume All
                </Button>
              </>
            ) : null}
            <Button variant="primary" onClick={() => navigate('/add')}>
              <IconMagnet size={13} /> Add Torrent
            </Button>
          </div>
        </header>

        {restoring ? (
          <div className="splash">
            <Spinner />
            <span>{stats?.restoreProgress ?? 'Restoring torrents…'}</span>
          </div>
        ) : route.name === 'add' ? (
          <AddTorrentPage />
        ) : route.name === 'settings' ? (
          <SettingsPage />
        ) : route.name === 'logs' ? (
          <LogsPage />
        ) : route.name === 'details' && route.infoHash ? (
          <TorrentDetailsPage infoHash={route.infoHash} />
        ) : (
          <div className="content content--flush">
            <TorrentsPage />
          </div>
        )}
      </div>

      {dragging ? (
        <div className="dropzone" role="presentation">
          <div className="dropzone__inner">
            <IconFile size={28} />
            <strong>Drop a .torrent file here</strong>
            <span className="tiny">Magnet links can be dropped as text too.</span>
          </div>
        </div>
      ) : null}

      {externalMagnet ? (
        <ExternalMagnetDialog
          uri={externalMagnet}
          onDismiss={clearExternalMagnet}
          onAccept={async () => {
            clearExternalMagnet()
            navigate('/add')
            setPreview(await window.torrentApi.startPreview(externalMagnet))
          }}
        />
      ) : null}

      <Toasts toasts={state.toasts} onDismiss={dismissToast} />
    </div>
  )
}

/**
 * Confirmation for a magnet opened from another app (a browser, usually).
 * Clicking a link on a web page must never silently start a download.
 */
function ExternalMagnetDialog({
  uri,
  onDismiss,
  onAccept
}: {
  uri: string
  onDismiss: () => void
  onAccept: () => Promise<void>
}) {
  const [name, setName] = useState<string | null>(null)
  const [infoHash, setInfoHash] = useState<string>('')

  useEffect(() => {
    void (async () => {
      const parsed = await window.torrentApi.parseMagnet(uri)
      if (parsed.ok) {
        setName(parsed.value.name)
        setInfoHash(parsed.value.infoHash)
      }
    })()
  }, [uri])

  return (
    <Dialog
      title="Add Torrent"
      onDismiss={onDismiss}
      actions={
        <>
          <Button onClick={onDismiss}>Cancel</Button>
          <Button variant="primary" onClick={() => void onAccept()}>
            Add Torrent
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Another app asked to open this magnet link. Nothing will be downloaded until you choose the
        files and confirm.
      </p>
      <div className="stack">
        <div className="row row--between">
          <span className="tiny">Name</span>
          <span className="truncate" style={{ maxWidth: '60%' }}>
            {name ?? 'Not provided by the link'}
          </span>
        </div>
        <div className="row row--between">
          <span className="tiny">Info hash</span>
          <span className="mono truncate" style={{ maxWidth: '60%' }}>
            {infoHash}
          </span>
        </div>
      </div>
    </Dialog>
  )
}
