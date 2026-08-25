/**
 * Shared torrent actions.
 *
 * The list rows, the context menu and the details panel all offer the same
 * operations. Keeping the labels and enabled/disabled rules in one place stops
 * them drifting apart -- which is how the details panel ended up with no action
 * controls at all.
 */

import { useCallback } from 'react'
import type { TorrentSnapshot, TorrentStatus } from '@shared/types.js'
import { useAppActions, useOperation } from '../state/store.js'
import type { MenuEntry } from '../components/Primitives.js'

/**
 * A torrent is "stopped" when the engine is not running it. `completed` counts:
 * the torrent finished and its seed goal was met, so nothing is transferring.
 * Treating it as running is what made the UI offer Pause on an idle torrent.
 */
export function isStopped(status: TorrentStatus): boolean {
  return status === 'paused' || status === 'waiting' || status === 'completed'
}

/** Label for the action that halts a running torrent. */
export function stopLabel(status: TorrentStatus): string {
  return status === 'seeding' ? 'Stop Seeding' : 'Pause'
}

/**
 * Label for the action that starts a stopped torrent. A finished torrent is
 * started to seed, not to download, and saying so avoids implying there is
 * still something left to fetch.
 */
export function startLabel(status: TorrentStatus): string {
  return status === 'completed' ? 'Start Seeding' : 'Resume'
}

export interface TorrentActions {
  pause(t: TorrentSnapshot): Promise<void>
  start(t: TorrentSnapshot): Promise<void>
  forceStart(t: TorrentSnapshot): Promise<void>
  recheck(t: TorrentSnapshot): Promise<void>
  reannounce(t: TorrentSnapshot): Promise<void>
  openFolder(t: TorrentSnapshot): Promise<void>
  copyMagnet(t: TorrentSnapshot): Promise<void>
  remove(t: TorrentSnapshot, deleteFiles: boolean): Promise<void>
  menuFor(t: TorrentSnapshot, opts?: { onShowDetails?: () => void }): MenuEntry[]
}

export function useTorrentActions(confirmRemoval: boolean): TorrentActions {
  const run = useOperation()
  const { navigate } = useAppActions()

  const pause = useCallback(
    async (t: TorrentSnapshot) => {
      await run(() => window.torrentApi.pause(t.infoHash), { failure: 'Could not stop the torrent' })
    },
    [run]
  )

  const start = useCallback(
    async (t: TorrentSnapshot) => {
      // A completed torrent has already satisfied its seed goal, so a plain
      // resume would stop it again immediately. Force-starting is what actually
      // puts it back to seeding, which is what "Start Seeding" promises.
      const action =
        t.status === 'completed'
          ? () => window.torrentApi.forceStart(t.infoHash)
          : () => window.torrentApi.resume(t.infoHash)
      await run(action, { failure: 'Could not start the torrent' })
    },
    [run]
  )

  const forceStart = useCallback(
    async (t: TorrentSnapshot) => {
      await run(() => window.torrentApi.forceStart(t.infoHash), {
        failure: 'Could not force start'
      })
    },
    [run]
  )

  const recheck = useCallback(
    async (t: TorrentSnapshot) => {
      await run(() => window.torrentApi.recheck(t.infoHash), {
        success: 'File check finished',
        failure: 'Could not check the files'
      })
    },
    [run]
  )

  const reannounce = useCallback(
    async (t: TorrentSnapshot) => {
      await run(() => window.torrentApi.reannounce(t.infoHash), { failure: 'Could not reannounce' })
    },
    [run]
  )

  const openFolder = useCallback(
    async (t: TorrentSnapshot) => {
      await run(() => window.torrentApi.openDownloadFolder(t.infoHash), {
        failure: 'Could not open the folder'
      })
    },
    [run]
  )

  const copyMagnet = useCallback(
    async (t: TorrentSnapshot) => {
      await run(() => window.torrentApi.copyMagnet(t.infoHash), { success: 'Magnet link copied' })
    },
    [run]
  )

  const remove = useCallback(
    async (t: TorrentSnapshot, deleteFiles: boolean) => {
      const mode = deleteFiles ? 'delete-files' : 'keep-files'
      // Deleting files is irreversible, so it always confirms regardless of the
      // preference, which only governs the gentler "remove from list" case.
      if (deleteFiles || confirmRemoval) {
        const { confirmed } = await window.torrentApi.confirmRemoval({ name: t.name, mode })
        if (!confirmed) return
      }
      const ok = await run(() => window.torrentApi.remove(t.infoHash, mode), {
        success: deleteFiles ? 'Torrent and files removed' : 'Torrent removed',
        failure: 'Could not remove the torrent'
      })
      if (ok) navigate('/torrents/all')
    },
    [run, confirmRemoval, navigate]
  )

  const menuFor = useCallback(
    (t: TorrentSnapshot, opts?: { onShowDetails?: () => void }): MenuEntry[] => {
      const stopped = isStopped(t.status)
      const errored = t.status === 'error'
      return [
        {
          id: 'stop',
          label: stopLabel(t.status),
          disabled: stopped || errored,
          onSelect: () => void pause(t)
        },
        {
          id: 'start',
          label: startLabel(t.status),
          disabled: !stopped && !errored,
          onSelect: () => void start(t)
        },
        {
          id: 'force',
          label: 'Force Start',
          disabled: t.forceStarted,
          onSelect: () => void forceStart(t)
        },
        { id: 's1', label: '', separator: true },
        { id: 'recheck', label: 'Recheck Files', onSelect: () => void recheck(t) },
        {
          id: 'reannounce',
          label: 'Force Reannounce',
          disabled: stopped,
          onSelect: () => void reannounce(t)
        },
        { id: 's2', label: '', separator: true },
        { id: 'open', label: 'Open Download Folder', onSelect: () => void openFolder(t) },
        { id: 'copy', label: 'Copy Magnet Link', onSelect: () => void copyMagnet(t) },
        ...(opts?.onShowDetails
          ? [{ id: 'details', label: 'Show Details', onSelect: opts.onShowDetails }]
          : []),
        { id: 's3', label: '', separator: true },
        { id: 'remove', label: 'Remove Torrent', onSelect: () => void remove(t, false) },
        {
          id: 'remove-delete',
          label: 'Remove Torrent + Delete Files',
          danger: true,
          onSelect: () => void remove(t, true)
        }
      ]
    },
    [pause, start, forceStart, recheck, reannounce, openFolder, copyMagnet, remove]
  )

  return {
    pause,
    start,
    forceStart,
    recheck,
    reannounce,
    openFolder,
    copyMagnet,
    remove,
    menuFor
  }
}
