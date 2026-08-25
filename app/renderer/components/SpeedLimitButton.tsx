/**
 * Quick bandwidth control in the title bar.
 *
 * The limits already lived in Settings -> Bandwidth, but nobody goes looking
 * there mid-download. This surfaces the same setting where it is actually
 * wanted, showing the current cap on its face.
 *
 * Limits are global, not per-torrent: the engine throttles the whole client, so
 * a per-torrent cap is not something this app can honestly offer.
 */

import { useState } from 'react'
import type { AppSettings } from '@shared/types.js'
import { UNLIMITED } from '@shared/constants.js'
import { formatSpeed } from '@shared/format.js'
import { Button, ContextMenu, type MenuEntry } from './Primitives.js'
import { IconChevron } from './Icons.js'

const KB = 1024
const MB = 1024 * 1024

/** Presets covering typical home connections, plus unlimited. */
const PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Unlimited', value: UNLIMITED },
  { label: '100 KB/s', value: 100 * KB },
  { label: '250 KB/s', value: 250 * KB },
  { label: '500 KB/s', value: 500 * KB },
  { label: '1 MB/s', value: MB },
  { label: '2 MB/s', value: 2 * MB },
  { label: '5 MB/s', value: 5 * MB },
  { label: '10 MB/s', value: 10 * MB }
]

function labelFor(limit: number): string {
  return limit === UNLIMITED || limit < 0 ? 'Unlimited' : formatSpeed(limit)
}

export function SpeedLimitButton({
  settings,
  onOpenSettings
}: {
  settings: AppSettings
  onOpenSettings: () => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const down = settings.bandwidth.downloadLimit
  const up = settings.bandwidth.uploadLimit
  const anyLimited = down !== UNLIMITED || up !== UNLIMITED

  const apply = (patch: { downloadLimit?: number; uploadLimit?: number }) => {
    void window.torrentApi.updateSettings({ bandwidth: patch })
  }

  const entries: MenuEntry[] = [
    { id: 'dl-head', label: 'Download limit', heading: true },
    ...PRESETS.map((preset) => ({
      id: `dl-${preset.value}`,
      label: preset.label,
      checked: down === preset.value,
      onSelect: () => apply({ downloadLimit: preset.value })
    })),
    { id: 'sep1', label: '', separator: true },
    { id: 'ul-head', label: 'Upload limit', heading: true },
    ...PRESETS.map((preset) => ({
      id: `ul-${preset.value}`,
      label: preset.label,
      checked: up === preset.value,
      onSelect: () => apply({ uploadLimit: preset.value })
    })),
    { id: 'sep2', label: '', separator: true },
    { id: 'custom', label: 'Custom…', onSelect: onOpenSettings }
  ]

  return (
    <>
      <Button
        title="Bandwidth limits"
        ariaLabel="Bandwidth limits"
        onClick={(event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
          setMenu({ x: rect.left, y: rect.bottom + 4 })
        }}
      >
        <span className="nums" style={{ color: anyLimited ? 'var(--accent)' : undefined }}>
          ↓ {labelFor(down)}
        </span>
        <IconChevron size={11} className="rotate-90" />
      </Button>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={entries} onDismiss={() => setMenu(null)} />
      ) : null}
    </>
  )
}
