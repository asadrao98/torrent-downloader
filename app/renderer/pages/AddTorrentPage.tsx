/**
 * The primary workflow: paste a magnet, watch metadata arrive, choose files and
 * a folder, start downloading.
 *
 * Metadata is never assumed to be available. A magnet carries only an info hash
 * (and sometimes a name), so the screen has an explicit retrieving state and
 * only shows the file list once the info dict has actually come off the swarm.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FilePriority, MetadataPreview } from '@shared/types.js'
import { formatBytes, prettyPath } from '@shared/format.js'
import { Button, EmptyState, Spinner } from '../components/Primitives.js'
import { FileTree, selectionSummary, type PriorityMap } from '../components/FileTree.js'
import { IconFolder, IconMagnet } from '../components/Icons.js'
import { useAppActions, useAppState, useOperation } from '../state/store.js'

export function AddTorrentPage() {
  const { preview, settings, info, route } = useAppState()
  const { setPreview, navigate, toast } = useAppActions()
  const run = useOperation()

  const [magnetText, setMagnetText] = useState('')
  const [magnetError, setMagnetError] = useState<string | null>(null)
  const [priorities, setPriorities] = useState<PriorityMap>({})
  const [downloadPath, setDownloadPath] = useState('')
  const [starting, setStarting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const homeDir = info?.homeDir ?? ''

  // Default the destination from settings, but only until the user picks one.
  useEffect(() => {
    if (downloadPath === '' && settings) setDownloadPath(settings.downloads.defaultPath)
  }, [settings, downloadPath])

  // Reset the per-file choices whenever a different torrent's metadata arrives.
  const previewIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!preview || preview.previewId === previewIdRef.current) return
    previewIdRef.current = preview.previewId
    setPriorities({})
  }, [preview])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const startPreview = useCallback(
    async (source: string) => {
      setMagnetError(null)
      const parsed = await window.torrentApi.parseMagnet(source)
      if (!parsed.ok) {
        setMagnetError(parsed.message)
        return
      }
      const next = await window.torrentApi.startPreview(source)
      setPreview(next)
    },
    [setPreview]
  )

  // The File > Paste Magnet menu item routes here with ?paste=1.
  const pasteHandled = useRef(false)
  useEffect(() => {
    if (!route.paste || pasteHandled.current) return
    pasteHandled.current = true
    void (async () => {
      const clipboardMagnet = await window.torrentApi.readMagnetFromClipboard()
      if (!clipboardMagnet) {
        toast({ kind: 'info', title: 'No magnet link on the clipboard' })
        return
      }
      setMagnetText(clipboardMagnet)
      await startPreview(clipboardMagnet)
    })()
  }, [route.paste, startPreview, toast])

  const onPaste = async () => {
    const clipboardMagnet = await window.torrentApi.readMagnetFromClipboard()
    if (!clipboardMagnet) {
      toast({
        kind: 'info',
        title: 'No magnet link found',
        message: 'The clipboard does not currently contain a valid magnet link.'
      })
      return
    }
    setMagnetText(clipboardMagnet)
    setMagnetError(null)
  }

  const onChooseFolder = async () => {
    const result = await window.torrentApi.chooseFolder(downloadPath)
    if (!result.canceled && result.path) setDownloadPath(result.path)
  }

  const onCancelPreview = async () => {
    if (preview) await window.torrentApi.cancelPreview(preview.previewId)
    setPreview(null)
    previewIdRef.current = null
  }

  const onStart = async (startPaused: boolean) => {
    if (!preview) return
    setStarting(true)
    const ok = await run(
      () =>
        window.torrentApi.commitPreview({
          previewId: preview.previewId,
          downloadPath,
          priorities,
          startPaused
        }),
      { failure: 'Could not start the download' }
    )
    setStarting(false)
    if (ok) {
      setPreview(null)
      previewIdRef.current = null
      setMagnetText('')
      navigate('/torrents/all')
    }
  }

  // -------------------------------------------------- metadata ready screen

  if (preview && preview.stage === 'ready' && preview.tree) {
    return (
      <MetadataScreen
        preview={preview}
        priorities={priorities}
        setPriorities={setPriorities}
        downloadPath={downloadPath}
        homeDir={homeDir}
        onChooseFolder={onChooseFolder}
        onCancel={onCancelPreview}
        onStart={onStart}
        starting={starting}
      />
    )
  }

  // --------------------------------------------------- retrieving metadata

  if (preview && (preview.stage === 'connecting' || preview.stage === 'fetching-metadata')) {
    return (
      <div className="content">
        <div className="card card--pad" style={{ maxWidth: 640, margin: '0 auto' }}>
          <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
            <Spinner />
            <div>
              <div className="section__title" style={{ marginBottom: 2 }}>
                Retrieving torrent metadata…
              </div>
              <div className="tiny">{preview.statusText}</div>
            </div>
          </div>

          <div className="stack">
            <MetaRow label="Name" value={preview.magnet.name ?? 'Not provided by the magnet link'} />
            <MetaRow label="Info hash" value={preview.magnet.infoHash} mono />
            <MetaRow
              label="Trackers"
              value={
                preview.magnet.trackers.length > 0
                  ? `${preview.magnet.trackers.length} announce URL${preview.magnet.trackers.length === 1 ? '' : 's'}`
                  : 'None — relying on DHT'
              }
            />
            <MetaRow label="Peers found" value={String(preview.numPeers)} />
          </div>

          <p className="section__hint" style={{ marginTop: 'var(--space-4)' }}>
            A magnet link contains no file list, so it has to be fetched from other peers. This can
            take a moment, and longer for a torrent with few seeders.
          </p>

          <div className="dialog__actions">
            <Button onClick={onCancelPreview}>Cancel</Button>
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------ error state

  if (preview && preview.stage === 'error') {
    return (
      <div className="content">
        <div className="card card--pad" style={{ maxWidth: 640, margin: '0 auto' }}>
          <div className="section__title">
            {preview.alreadyAdded ? 'Already in your list' : 'Unable to retrieve torrent metadata'}
          </div>
          <p className="section__hint">{preview.errorMessage}</p>
          {preview.magnet.infoHash ? (
            <div className="stack">
              <MetaRow label="Info hash" value={preview.magnet.infoHash} mono />
            </div>
          ) : null}
          <div className="dialog__actions">
            <Button
              onClick={() => {
                setPreview(null)
                previewIdRef.current = null
              }}
            >
              Back
            </Button>
            {!preview.alreadyAdded && magnetText ? (
              <Button variant="primary" onClick={() => void startPreview(magnetText)}>
                Try Again
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  // ----------------------------------------------------------- input screen

  return (
    <div className="content">
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div className="card card--pad">
          <h2 className="section__title">Paste Magnet Link</h2>
          <p className="section__hint">
            Paste a magnet link, or drop a <code>.torrent</code> file anywhere on this window.
          </p>

          <textarea
            ref={inputRef}
            className={`textarea${magnetError ? ' input--invalid' : ''}`}
            placeholder="magnet:?xt=urn:btih:…"
            value={magnetText}
            spellCheck={false}
            onChange={(event) => {
              setMagnetText(event.target.value)
              setMagnetError(null)
            }}
            onKeyDown={(event) => {
              // Cmd+Enter submits, which is the macOS convention for a textarea.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (magnetText.trim()) void startPreview(magnetText)
              }
            }}
          />

          {magnetError ? (
            <div
              className="torrent__error"
              role="alert"
              style={{ marginTop: 'var(--space-2)' }}
            >
              <strong>Invalid magnet link</strong>
              <div>{magnetError}</div>
            </div>
          ) : null}

          <div className="row" style={{ marginTop: 'var(--space-4)' }}>
            <Button onClick={onPaste}>
              <IconMagnet size={13} /> Paste Magnet
            </Button>
            <div className="titlebar__spacer" />
            <Button
              variant="primary"
              size="large"
              disabled={magnetText.trim().length === 0}
              onClick={() => void startPreview(magnetText)}
            >
              Add Torrent
            </Button>
          </div>
        </div>

        <p className="tiny" style={{ marginTop: 'var(--space-4)', lineHeight: 1.6 }}>
          Downloads go to {prettyPath(settings?.downloads.defaultPath ?? '', homeDir)} unless you
          choose somewhere else on the next screen. Nothing is written to disk until you press Start
          Download.
        </p>
      </div>
    </div>
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row row--between">
      <span className="tiny">{label}</span>
      <span className={`truncate${mono ? ' mono' : ''}`} style={{ maxWidth: '62%' }} title={value}>
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------- metadata screen

function MetadataScreen({
  preview,
  priorities,
  setPriorities,
  downloadPath,
  homeDir,
  onChooseFolder,
  onCancel,
  onStart,
  starting
}: {
  preview: MetadataPreview
  priorities: PriorityMap
  setPriorities: (next: PriorityMap) => void
  downloadPath: string
  homeDir: string
  onChooseFolder: () => void
  onCancel: () => void
  onStart: (startPaused: boolean) => void
  starting: boolean
}) {
  const summary = useMemo(
    () => selectionSummary(preview.files, priorities),
    [preview.files, priorities]
  )

  const setAll = (priority: FilePriority) => {
    const next: PriorityMap = {}
    for (const file of preview.files) next[file.index] = priority
    setPriorities(next)
  }

  const renamedCount = preview.files.filter((f) => f.sanitized).length

  return (
    <div className="content">
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        <div className="section">
          <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', letterSpacing: '-0.02em' }}>
            {preview.name}
          </h2>
          <div className="row row--wrap muted" style={{ marginTop: 'var(--space-2)' }}>
            <span>Size: {formatBytes(summary.totalBytes)}</span>
            <span>Files: {preview.fileCount}</span>
            {preview.pieceCount ? <span>Pieces: {preview.pieceCount}</span> : null}
            {preview.isPrivate ? <span className="pill pill--checking">Private torrent</span> : null}
          </div>
        </div>

        {renamedCount > 0 ? (
          <div
            className="card card--pad"
            style={{ marginBottom: 'var(--space-4)', borderColor: 'var(--orange)' }}
          >
            <strong>
              {renamedCount} file{renamedCount === 1 ? ' was' : 's were'} renamed for safety
            </strong>
            <p className="section__hint" style={{ marginTop: 4, marginBottom: 0 }}>
              This torrent asked to write files using paths that would have escaped your download
              folder or collided with each other. They will be saved under corrected names inside the
              folder you choose. Hover a file marked “renamed” to see the original path.
            </p>
          </div>
        ) : null}

        <div className="section">
          <div className="row row--between" style={{ marginBottom: 'var(--space-2)' }}>
            <div className="section__title" style={{ margin: 0 }}>
              Files
            </div>
            <div className="row">
              <Button onClick={() => setAll('normal')}>Select All</Button>
              <Button onClick={() => setAll('skip')}>Deselect All</Button>
            </div>
          </div>

          <FileTree
            tree={preview.tree!}
            priorities={priorities}
            onChange={setPriorities}
            files={preview.files}
          />

          <div className="row row--between" style={{ marginTop: 'var(--space-2)' }}>
            <span className="tiny">
              {summary.selectedCount} of {preview.fileCount} files selected
            </span>
            <span className="tiny nums">
              {formatBytes(summary.selectedBytes)} of {formatBytes(summary.totalBytes)}
            </span>
          </div>
        </div>

        <div className="section">
          <div className="section__title">Download to</div>
          <div className="row">
            <div
              className="input truncate"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              title={downloadPath}
            >
              <IconFolder size={13} />
              <span className="truncate">{prettyPath(downloadPath, homeDir)}</span>
            </div>
            <Button onClick={onChooseFolder}>Change Folder</Button>
          </div>
        </div>

        <div className="row row--between" style={{ paddingBottom: 'var(--space-8)' }}>
          <Button onClick={onCancel} disabled={starting}>
            Cancel
          </Button>
          <div className="row">
            <Button onClick={() => onStart(true)} disabled={starting || summary.selectedCount === 0}>
              Add Paused
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => onStart(false)}
              disabled={starting || summary.selectedCount === 0}
            >
              {starting ? 'Starting…' : 'Start Download'}
            </Button>
          </div>
        </div>

        {summary.selectedCount === 0 ? (
          <p className="tiny" style={{ marginTop: '-16px' }}>
            Select at least one file to continue.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Shown when the list is empty and the user has not started an add yet. */
export function AddTorrentEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      glyph={<IconMagnet size={26} />}
      title="No torrents yet"
      body="Paste a magnet link to get started, or drop a .torrent file onto this window."
      action={
        <Button variant="primary" size="large" onClick={onAdd}>
          Add Torrent
        </Button>
      }
    />
  )
}
