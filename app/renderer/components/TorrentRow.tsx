/** One torrent in the list: name, progress, live rates, and inline actions. */

import type { TorrentSnapshot } from '@shared/types.js'
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatRatio,
  formatSpeed
} from '@shared/format.js'
import { Button, ProgressBar, StatusPill } from './Primitives.js'
import { isStopped, startLabel, stopLabel } from '../lib/torrent-actions.js'
import {
  IconCheck,
  IconDownload,
  IconMore,
  IconPause,
  IconPlay,
  IconStop,
  IconUpload,
  IconWarning
} from './Icons.js'

function glyphFor(status: TorrentSnapshot['status']) {
  switch (status) {
    case 'seeding':
      return <IconUpload />
    case 'completed':
      return <IconCheck />
    case 'error':
      return <IconWarning />
    case 'paused':
    case 'waiting':
      return <IconPause />
    default:
      return <IconDownload />
  }
}

export function TorrentRow({
  torrent,
  selected,
  onOpen,
  onPause,
  onResume,
  onContextMenu
}: {
  torrent: TorrentSnapshot
  selected: boolean
  onOpen: () => void
  onPause: () => void
  onResume: () => void
  onContextMenu: (event: React.MouseEvent) => void
}) {
  // `completed` counts as stopped: the seed goal was met and nothing is running.
  const stopped = isStopped(torrent.status)
  const isChecking = torrent.status === 'checking'
  const isFetching = torrent.status === 'fetching-metadata'
  const isActive = !stopped && torrent.status !== 'error'
  const isSeeding = torrent.status === 'seeding'

  return (
    <div
      className={`torrent${selected ? ' torrent--selected' : ''}`}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      role="listitem"
    >
      <div className="torrent__icon">{glyphFor(torrent.status)}</div>

      <div className="torrent__body">
        <div className="row row--between">
          <button
            type="button"
            className="torrent__name truncate"
            onClick={onOpen}
            title={torrent.name}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              color: 'inherit',
              font: 'inherit',
              cursor: 'default',
              minWidth: 0
            }}
          >
            {torrent.name}
          </button>
          <StatusPill status={torrent.status} />
        </div>

        {isFetching ? (
          <div className="torrent__meta">
            <span>Retrieving torrent metadata…</span>
            <span>
              {torrent.numPeers === 0
                ? 'Connecting to peers'
                : `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`}
            </span>
          </div>
        ) : (
          <>
            <ProgressBar
              progress={torrent.progress}
              status={torrent.status}
              indeterminate={isChecking}
            />

            <div className="torrent__meta">
              {isChecking ? (
                <span>
                  Checking files — {torrent.piecesVerified} of {torrent.pieceCount} pieces verified
                </span>
              ) : (
                <>
                  <span>
                    {formatBytes(torrent.downloaded)} / {formatBytes(torrent.selectedLength)}
                  </span>
                  <span>{formatPercent(torrent.progress)}</span>
                  {torrent.downloadSpeed > 0 ? (
                    <span>↓ {formatSpeed(torrent.downloadSpeed)}</span>
                  ) : null}
                  {torrent.uploadSpeed > 0 ? (
                    <span>↑ {formatSpeed(torrent.uploadSpeed)}</span>
                  ) : null}
                  {torrent.eta !== null && torrent.status === 'downloading' ? (
                    <span>ETA {formatEta(torrent.eta)}</span>
                  ) : null}
                  {isSeeding || torrent.status === 'completed' ? (
                    <span>Ratio {formatRatio(torrent.ratio)}</span>
                  ) : null}
                  {torrent.status === 'completed' ? <span>Seeding stopped</span> : null}
                  {isActive ? (
                    <span>
                      {torrent.numSeeds} seed{torrent.numSeeds === 1 ? '' : 's'} ·{' '}
                      {torrent.numPeers} peer{torrent.numPeers === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}

        {torrent.status === 'error' && torrent.errorMessage ? (
          <div className="torrent__error">{torrent.errorMessage}</div>
        ) : null}

        {torrent.status === 'waiting' ? (
          <div className="tiny">Queued — waiting for an active download slot.</div>
        ) : null}
      </div>

      <div className="torrent__actions">
        {stopped || torrent.status === 'error' ? (
          <Button size="icon" title={startLabel(torrent.status)} onClick={onResume}>
            <IconPlay size={13} />
          </Button>
        ) : (
          <Button size="icon" title={stopLabel(torrent.status)} onClick={onPause}>
            {isSeeding ? <IconStop size={13} /> : <IconPause size={13} />}
          </Button>
        )}
        <Button
          size="icon"
          title="More actions"
          onClick={(event) => {
            event.stopPropagation()
            onContextMenu(event)
          }}
        >
          <IconMore size={13} />
        </Button>
      </div>
    </div>
  )
}
