/**
 * Details panel with General / Files / Peers / Trackers tabs.
 *
 * The list view gets its data from the 500ms broadcast; this screen additionally
 * polls the heavier per-torrent payload (peer and tracker tables) only while it
 * is open, so a large swarm costs nothing when nobody is looking at it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FilePriority, TorrentDetails } from '@shared/types.js'
import { DETAILS_POLL_INTERVAL_MS } from '@shared/constants.js'
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatRatio,
  formatRelative,
  formatSpeed,
  prettyPath,
  truncateMiddle
} from '@shared/format.js'
import {
  Button,
  ContextMenu,
  EmptyState,
  ProgressBar,
  Stat,
  StatusPill,
  Tabs
} from '../components/Primitives.js'
import { FileTree, type PriorityMap } from '../components/FileTree.js'
import { buildTreeFromFiles } from '../lib/tree.js'
import { isStopped, startLabel, stopLabel, useTorrentActions } from '../lib/torrent-actions.js'
import { IconMore, IconPause, IconPlay, IconStop, IconTrash, IconWarning } from '../components/Icons.js'
import { useAppActions, useAppState, useOperation } from '../state/store.js'

type TabId = 'general' | 'files' | 'peers' | 'trackers'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'files', label: 'Files' },
  { id: 'peers', label: 'Peers' },
  { id: 'trackers', label: 'Trackers' }
]

export function TorrentDetailsPage({ infoHash }: { infoHash: string }) {
  const { torrents, info, settings } = useAppState()
  const { navigate } = useAppActions()
  const run = useOperation()
  const actions = useTorrentActions(settings?.general.confirmTorrentRemoval ?? true)

  const [tab, setTab] = useState<TabId>('general')
  const [details, setDetails] = useState<TorrentDetails | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const snapshot = useMemo(
    () => torrents.find((t) => t.infoHash === infoHash) ?? null,
    [torrents, infoHash]
  )

  const load = useCallback(async () => {
    const next = await window.torrentApi.torrentDetails(infoHash)
    setDetails(next)
  }, [infoHash])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), DETAILS_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  if (!snapshot) {
    return (
      <EmptyState
        glyph={<IconWarning size={26} />}
        title="Torrent not found"
        body="This torrent is no longer in your list."
        action={<Button onClick={() => navigate('/torrents/all')}>Back to Torrents</Button>}
      />
    )
  }

  const homeDir = info?.homeDir ?? ''
  const files = details?.files ?? []

  const priorities: PriorityMap = {}
  for (const file of files) priorities[file.index] = file.priority

  const onPriorityChange = async (next: PriorityMap) => {
    // Send only what actually changed, so a folder toggle does not fire one IPC
    // call per file in the whole torrent.
    const changes: Array<{ index: number; priority: FilePriority }> = []
    for (const file of files) {
      const updated = next[file.index] ?? 'normal'
      if (updated !== file.priority) changes.push({ index: file.index, priority: updated })
    }
    for (const change of changes) {
      await run(
        () => window.torrentApi.setFilePriority(infoHash, change.index, change.priority),
        { failure: 'Could not change the file priority' }
      )
    }
    await load()
  }

  return (
    <div className="content">
      <div className="section">
        <div className="row row--between">
          <div style={{ minWidth: 0 }}>
            <h2
              className="truncate"
              style={{ margin: 0, fontSize: 'var(--text-lg)', letterSpacing: '-0.015em' }}
              title={snapshot.name}
            >
              {snapshot.name}
            </h2>
            <div className="row" style={{ marginTop: 6 }}>
              <StatusPill status={snapshot.status} />
              <span className="tiny">{prettyPath(snapshot.downloadPath, homeDir)}</span>
            </div>
          </div>
          <Button onClick={() => navigate('/torrents/all')}>Back</Button>
        </div>
      </div>

      {/* Everything you can do to this torrent, without going back to the list. */}
      <div className="section row row--wrap">
        {isStopped(snapshot.status) || snapshot.status === 'error' ? (
          <Button variant="primary" onClick={() => void actions.start(snapshot)}>
            <IconPlay size={13} /> {startLabel(snapshot.status)}
          </Button>
        ) : (
          <Button onClick={() => void actions.pause(snapshot)}>
            {snapshot.status === 'seeding' ? <IconStop size={13} /> : <IconPause size={13} />}{' '}
            {stopLabel(snapshot.status)}
          </Button>
        )}

        <Button onClick={() => void actions.recheck(snapshot)}>Recheck Files</Button>
        <Button onClick={() => void actions.openFolder(snapshot)}>Open Folder</Button>
        <Button onClick={() => void actions.copyMagnet(snapshot)}>Copy Magnet</Button>

        <div className="titlebar__spacer" />

        <Button variant="danger" onClick={() => void actions.remove(snapshot, false)}>
          <IconTrash size={13} /> Remove
        </Button>
        <Button
          size="icon"
          title="More actions"
          onClick={(event) => {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <IconMore size={13} />
        </Button>
      </div>

      <div className="section">
        <ProgressBar
          progress={snapshot.progress}
          status={snapshot.status}
          indeterminate={snapshot.status === 'checking'}
        />
        <div className="row row--between" style={{ marginTop: 6 }}>
          <span className="tiny nums">
            {formatBytes(snapshot.downloaded)} of {formatBytes(snapshot.selectedLength)}
          </span>
          <span className="tiny nums">
            {snapshot.status === 'checking'
              ? `Checking — ${snapshot.piecesVerified} / ${snapshot.pieceCount} pieces`
              : formatPercent(snapshot.progress)}
          </span>
        </div>
      </div>

      {snapshot.status === 'error' && snapshot.errorMessage ? (
        <div className="torrent__error section" role="alert">
          <strong>Torrent error</strong>
          <div>{snapshot.errorMessage}</div>
        </div>
      ) : null}

      <div className="section">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === 'general' ? (
        <div className="stats">
          <Stat label="Downloaded" value={formatBytes(snapshot.downloaded)} />
          <Stat label="Uploaded" value={formatBytes(snapshot.uploaded)} />
          <Stat label="Total size" value={formatBytes(snapshot.totalLength)} />
          <Stat label="Selected size" value={formatBytes(snapshot.selectedLength)} />
          <Stat label="Download" value={formatSpeed(snapshot.downloadSpeed)} />
          <Stat label="Upload" value={formatSpeed(snapshot.uploadSpeed)} />
          <Stat label="ETA" value={formatEta(snapshot.eta)} />
          <Stat label="Ratio" value={formatRatio(snapshot.ratio)} />
          <Stat label="Seeds" value={String(snapshot.numSeeds)} />
          <Stat label="Peers" value={String(snapshot.numPeers)} />
          <Stat label="Connections" value={String(snapshot.numConnections)} />
          <Stat
            label="Availability"
            value={snapshot.availability > 0 ? snapshot.availability.toFixed(2) : '—'}
            title="Average number of complete copies of this torrent visible across connected peers"
          />
          <Stat label="Pieces" value={`${snapshot.piecesVerified} / ${snapshot.pieceCount}`} />
          <Stat label="Piece size" value={formatBytes(snapshot.pieceLength)} />
          <Stat label="Files" value={String(snapshot.fileCount)} />
          <Stat
            label="Info hash"
            value={<span className="mono">{truncateMiddle(snapshot.infoHash, 18)}</span>}
            title={snapshot.infoHash}
          />
          <Stat label="Added" value={new Date(snapshot.addedAt).toLocaleString()} />
          <Stat
            label="Completed"
            value={snapshot.completedAt ? new Date(snapshot.completedAt).toLocaleString() : '—'}
          />
          <Stat label="Private" value={snapshot.isPrivate ? 'Yes' : 'No'} />
          <Stat
            label="Seed goal"
            value={
              snapshot.seedingGoal.kind === 'forever'
                ? 'Indefinitely'
                : snapshot.seedingGoal.kind === 'ratio'
                  ? `Ratio ${snapshot.seedingGoal.ratio.toFixed(2)}`
                  : `${snapshot.seedingGoal.minutes} min`
            }
          />
        </div>
      ) : null}

      {tab === 'general' ? (
        <div className="card card--pad" style={{ marginTop: 'var(--space-4)' }}>
          <div className="section__title">Seeding</div>
          <p className="section__hint">
            How long to keep sharing this torrent after it finishes. This overrides the global
            setting for this torrent only.
          </p>
          <div className="row row--wrap">
            <select
              className="select"
              style={{ width: 230 }}
              aria-label="Seed goal"
              value={snapshot.seedingGoal.kind}
              onChange={(event) =>
                void run(
                  () =>
                    window.torrentApi.setSeedingGoal(infoHash, {
                      kind: event.target.value as 'ratio' | 'time' | 'forever',
                      ratio: snapshot.seedingGoal.ratio,
                      minutes: snapshot.seedingGoal.minutes
                    }),
                  { failure: 'Could not change the seed goal' }
                )
              }
            >
              <option value="ratio">Seed until a ratio is reached</option>
              <option value="time">Seed for a time limit</option>
              <option value="forever">Seed indefinitely</option>
            </select>

            {snapshot.seedingGoal.kind === 'ratio' ? (
              <input
                className="input"
                style={{ width: 100, textAlign: 'right' }}
                type="number"
                min={0}
                step={0.1}
                aria-label="Seed ratio"
                defaultValue={snapshot.seedingGoal.ratio}
                onBlur={(event) => {
                  const ratio = Number(event.target.value)
                  if (!Number.isFinite(ratio) || ratio < 0) return
                  void run(
                    () =>
                      window.torrentApi.setSeedingGoal(infoHash, {
                        ...snapshot.seedingGoal,
                        ratio
                      }),
                    { failure: 'Could not change the seed ratio' }
                  )
                }}
              />
            ) : null}

            {snapshot.seedingGoal.kind === 'time' ? (
              <input
                className="input"
                style={{ width: 120, textAlign: 'right' }}
                type="number"
                min={0}
                aria-label="Seed minutes"
                defaultValue={snapshot.seedingGoal.minutes}
                onBlur={(event) => {
                  const minutes = Number(event.target.value)
                  if (!Number.isFinite(minutes) || minutes < 0) return
                  void run(
                    () =>
                      window.torrentApi.setSeedingGoal(infoHash, {
                        ...snapshot.seedingGoal,
                        minutes
                      }),
                    { failure: 'Could not change the seed time' }
                  )
                }}
              />
            ) : null}
          </div>

          {snapshot.status === 'completed' ? (
            <p className="tiny" style={{ marginTop: 'var(--space-3)' }}>
              This torrent has stopped seeding because its goal was met. Use Start Seeding above to
              share it again.
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === 'files' ? (
        files.length > 0 ? (
          <>
            <FileTree
              tree={buildTreeFromFiles(files, snapshot.name)}
              priorities={priorities}
              onChange={(next) => void onPriorityChange(next)}
              files={files}
            />
            <p className="tiny" style={{ marginTop: 'var(--space-2)' }}>
              A piece shared between a selected and a skipped file is still downloaded, because the
              selected file needs those bytes.
            </p>
          </>
        ) : (
          <EmptyState
            glyph={<IconWarning size={24} />}
            title="File list unavailable"
            body="The file list comes from the running torrent. Resume this torrent to see and change its files."
          />
        )
      ) : null}

      {tab === 'peers' ? (
        (details?.peers.length ?? 0) > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Client</th>
                  <th>Transport</th>
                  <th className="table__num">Progress</th>
                  <th className="table__num">Down</th>
                  <th className="table__num">Up</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {details!.peers.map((peer) => (
                  <tr key={`${peer.address}-${peer.type}`}>
                    <td className="mono">{peer.address}</td>
                    <td className="truncate" style={{ maxWidth: 180 }} title={peer.client ?? ''}>
                      {peer.client ?? '—'}
                    </td>
                    <td>{peer.type}</td>
                    <td className="table__num">{formatPercent(peer.progress, 0)}</td>
                    <td className="table__num">{formatSpeed(peer.downloadSpeed)}</td>
                    <td className="table__num">{formatSpeed(peer.uploadSpeed)}</td>
                    <td className="tiny">
                      {[
                        peer.encrypted ? 'encrypted' : null,
                        peer.choked ? 'choked by peer' : null,
                        peer.choking ? 'choking peer' : null
                      ]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            glyph={<IconWarning size={24} />}
            title="No connected peers"
            body="Peers appear here once connections are established. A stopped torrent has none."
          />
        )
      ) : null}

      {tab === 'trackers' ? (
        (details?.trackers.length ?? 0) > 0 ? (
          <>
            <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
              <Button
                onClick={() =>
                  void run(() => window.torrentApi.reannounce(infoHash), {
                    success: 'Reannounce sent',
                    failure: 'Could not reannounce'
                  })
                }
                disabled={snapshot.status === 'paused' || snapshot.status === 'waiting'}
              >
                Force Reannounce
              </Button>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tracker</th>
                    <th>Status</th>
                    <th className="table__num">Seeds</th>
                    <th className="table__num">Peers</th>
                    <th className="table__num">Last announce</th>
                    <th className="table__num">Next announce</th>
                  </tr>
                </thead>
                <tbody>
                  {details!.trackers.map((tracker) => (
                    <tr key={tracker.url}>
                      <td className="mono truncate" style={{ maxWidth: 320 }} title={tracker.url}>
                        {tracker.url}
                      </td>
                      <td>{tracker.status}</td>
                      <td className="table__num">{tracker.seeds ?? '—'}</td>
                      <td className="table__num">{tracker.peers ?? '—'}</td>
                      <td className="table__num">
                        {formatRelative(tracker.lastAnnounce, Date.now())}
                      </td>
                      <td className="table__num">
                        {formatRelative(tracker.nextAnnounce, Date.now())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tiny" style={{ marginTop: 'var(--space-2)' }}>
              A tracker shows as “working” once it has returned a successful announce. The engine
              reports announce failures without naming the tracker, so a failing tracker stays
              “idle” rather than being blamed incorrectly.
            </p>
            {(details?.webSeeds.length ?? 0) > 0 ? (
              <div className="section" style={{ marginTop: 'var(--space-4)' }}>
                <div className="section__title">Web seeds</div>
                {details!.webSeeds.map((seed) => (
                  <div key={seed} className="mono tiny truncate" title={seed}>
                    {seed}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState
            glyph={<IconWarning size={24} />}
            title="No trackers"
            body="This torrent has no announce URLs, or it is not running. Peers can still be found through DHT and peer exchange."
          />
        )
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={actions.menuFor(snapshot)}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
