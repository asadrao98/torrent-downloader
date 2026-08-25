/** The torrent list, with the right-click action menu. */

import { useMemo, useState } from 'react'
import type { TorrentFilter, TorrentSnapshot } from '@shared/types.js'
import { ContextMenu, EmptyState } from '../components/Primitives.js'
import { useTorrentActions } from '../lib/torrent-actions.js'
import { TorrentRow } from '../components/TorrentRow.js'
import { AddTorrentEmptyState } from './AddTorrentPage.js'
import { IconInbox } from '../components/Icons.js'
import { filterTorrents, useAppActions, useAppState } from '../state/store.js'

const EMPTY_COPY: Record<TorrentFilter, { title: string; body: string }> = {
  all: {
    title: 'No torrents yet',
    body: 'Paste a magnet link to get started, or drop a .torrent file onto this window.'
  },
  downloading: {
    title: 'Nothing downloading',
    body: 'Torrents currently transferring data will appear here.'
  },
  seeding: {
    title: 'Nothing seeding',
    body: 'Completed torrents that are still sharing with other peers appear here.'
  },
  completed: {
    title: 'Nothing completed',
    body: 'Finished downloads will be listed here.'
  },
  paused: {
    title: 'Nothing paused',
    body: 'Torrents you have stopped will be listed here.'
  },
  errors: {
    title: 'No errors',
    body: 'Torrents that ran into a problem will be listed here, with the reason.'
  }
}

export function TorrentsPage() {
  const { torrents, route, settings } = useAppState()
  const { navigate } = useAppActions()
  const actions = useTorrentActions(settings?.general.confirmTorrentRemoval ?? true)

  const [menu, setMenu] = useState<{ x: number; y: number; torrent: TorrentSnapshot } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const visible = useMemo(() => filterTorrents(torrents, route.filter), [torrents, route.filter])

  if (torrents.length === 0) {
    return <AddTorrentEmptyState onAdd={() => navigate('/add')} />
  }

  if (visible.length === 0) {
    const copy = EMPTY_COPY[route.filter]
    return <EmptyState glyph={<IconInbox size={26} />} title={copy.title} body={copy.body} />
  }

  return (
    <>
      <div className="torrents" role="list">
        {visible.map((torrent) => (
          <TorrentRow
            key={torrent.infoHash}
            torrent={torrent}
            selected={selected === torrent.infoHash}
            onOpen={() => navigate(`/torrent/${torrent.infoHash}`)}
            onPause={() => void actions.pause(torrent)}
            onResume={() => void actions.start(torrent)}
            onContextMenu={(event) => {
              event.preventDefault()
              setSelected(torrent.infoHash)
              setMenu({ x: event.clientX, y: event.clientY, torrent })
            }}
          />
        ))}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={actions.menuFor(menu.torrent, {
            onShowDetails: () => navigate(`/torrent/${menu.torrent.infoHash}`)
          })}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </>
  )
}
