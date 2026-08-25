/** Source-list sidebar: filters, settings, and the session transfer totals. */

import type { ReactNode } from 'react'
import type { SessionStats, TorrentFilter, TorrentSnapshot } from '@shared/types.js'
import { formatSpeed, formatBytes } from '@shared/format.js'
import { filterTorrents, type Route } from '../state/store.js'
import {
  IconAll,
  IconCheck,
  IconDownload,
  IconLogs,
  IconPause,
  IconSettings,
  IconUpload,
  IconWarning
} from './Icons.js'

const FILTERS: ReadonlyArray<{ id: TorrentFilter; label: string; icon: ReactNode }> = [
  { id: 'all', label: 'All', icon: <IconAll /> },
  { id: 'downloading', label: 'Downloading', icon: <IconDownload /> },
  { id: 'seeding', label: 'Seeding', icon: <IconUpload /> },
  { id: 'completed', label: 'Completed', icon: <IconCheck /> },
  { id: 'paused', label: 'Paused', icon: <IconPause /> },
  { id: 'errors', label: 'Errors', icon: <IconWarning /> }
]

export function Sidebar({
  route,
  torrents,
  stats,
  onNavigate
}: {
  route: Route
  torrents: TorrentSnapshot[]
  stats: SessionStats | null
  onNavigate: (path: string) => void
}) {
  return (
    <nav className="sidebar" aria-label="Sidebar">
      {/* Reserves space for the inset traffic lights and stays draggable. */}
      <div className="sidebar__drag" />

      <div className="sidebar__scroll">
        <div className="sidebar__group">
          <div className="sidebar__label">Torrents</div>
          {FILTERS.map((filter) => {
            const count = filterTorrents(torrents, filter.id).length
            const active = route.name === 'torrents' && route.filter === filter.id
            return (
              <button
                key={filter.id}
                type="button"
                className={`sidebar__item${active ? ' sidebar__item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(`/torrents/${filter.id}`)}
              >
                <span className="sidebar__icon">{filter.icon}</span>
                <span className="sidebar__text">{filter.label}</span>
                {count > 0 ? <span className="sidebar__count">{count}</span> : null}
              </button>
            )
          })}
        </div>

        <div className="sidebar__group">
          <div className="sidebar__label">App</div>
          <button
            type="button"
            className={`sidebar__item${route.name === 'settings' ? ' sidebar__item--active' : ''}`}
            onClick={() => onNavigate('/settings')}
          >
            <span className="sidebar__icon">
              <IconSettings />
            </span>
            <span className="sidebar__text">Settings</span>
          </button>
          <button
            type="button"
            className={`sidebar__item${route.name === 'logs' ? ' sidebar__item--active' : ''}`}
            onClick={() => onNavigate('/logs')}
          >
            <span className="sidebar__icon">
              <IconLogs />
            </span>
            <span className="sidebar__text">Logs</span>
          </button>
        </div>
      </div>

      <div className="sidebar__footer">
        <div className="sidebar__stat">
          <span>↓ {formatSpeed(stats?.downloadSpeed ?? 0)}</span>
          <span>↑ {formatSpeed(stats?.uploadSpeed ?? 0)}</span>
        </div>
        <div className="sidebar__stat">
          <span className="tiny">{formatBytes(stats?.totalDownloaded ?? 0)} down</span>
          <span className="tiny">{formatBytes(stats?.totalUploaded ?? 0)} up</span>
        </div>
        {stats?.dhtNodes !== null && stats?.dhtNodes !== undefined ? (
          <div className="tiny">DHT: {stats.dhtNodes} nodes</div>
        ) : (
          <div className="tiny">DHT off</div>
        )}
      </div>
    </nav>
  )
}
