/** Small shared UI pieces: controls, status, progress, empty states, overlays. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TorrentStatus } from '@shared/types.js'
import { formatPercent } from '@shared/format.js'
import { IconCheck, IconClose, IconWarning } from './Icons.js'

// -------------------------------------------------------------------- button

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'default',
  disabled,
  title,
  ariaLabel,
  type = 'button'
}: {
  children?: ReactNode
  onClick?: (event: React.MouseEvent) => void
  variant?: 'default' | 'primary' | 'danger' | 'quiet'
  size?: 'default' | 'large' | 'icon'
  disabled?: boolean
  title?: string
  /**
   * Overrides the accessible name. Needed when the visible label is a value
   * rather than a description -- the bandwidth control reads "500 KB/s", which
   * says nothing about what the button does.
   */
  ariaLabel?: string
  type?: 'button' | 'submit'
}) {
  const classes = ['button']
  if (variant !== 'default') classes.push(`button--${variant}`)
  if (size === 'large') classes.push('button--large')
  if (size === 'icon') classes.push('button--icon')

  return (
    <button
      type={type}
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel ?? (size === 'icon' ? title : undefined)}
    >
      {children}
    </button>
  )
}

// -------------------------------------------------------------------- switch

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

// ------------------------------------------------------------------ checkbox

export function Checkbox({
  state,
  onChange,
  label
}: {
  state: 'checked' | 'unchecked' | 'partial'
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'checked' ? true : state === 'partial' ? 'mixed' : false}
      aria-label={label}
      className="checkbox"
      data-state={state}
      onClick={(event) => {
        event.stopPropagation()
        onChange()
      }}
    >
      {state === 'checked' ? (
        <IconCheck size={11} />
      ) : state === 'partial' ? (
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <rect x="1" y="3.8" width="7" height="1.5" rx="0.75" fill="currentColor" />
        </svg>
      ) : null}
    </button>
  )
}

// ------------------------------------------------------------- status pills

const STATUS_LABEL: Record<TorrentStatus, string> = {
  waiting: 'Waiting',
  'fetching-metadata': 'Fetching metadata',
  checking: 'Checking',
  downloading: 'Downloading',
  seeding: 'Seeding',
  completed: 'Completed',
  paused: 'Paused',
  error: 'Error'
}

const STATUS_CLASS: Record<TorrentStatus, string> = {
  waiting: 'waiting',
  'fetching-metadata': 'metadata',
  checking: 'checking',
  downloading: 'downloading',
  seeding: 'seeding',
  completed: 'completed',
  paused: 'paused',
  error: 'error'
}

export function StatusPill({ status }: { status: TorrentStatus }) {
  return (
    <span className={`pill pill--${STATUS_CLASS[status]}`}>
      <span className="pill__dot" />
      {STATUS_LABEL[status]}
    </span>
  )
}

export function statusLabel(status: TorrentStatus): string {
  return STATUS_LABEL[status]
}

// ------------------------------------------------------------------ progress

export function ProgressBar({
  progress,
  status,
  indeterminate
}: {
  progress: number
  status: TorrentStatus
  indeterminate?: boolean
}) {
  const fillClasses = ['progress__fill']
  if (status === 'error') fillClasses.push('progress__fill--error')
  else if (status === 'paused' || status === 'waiting') fillClasses.push('progress__fill--paused')
  else if (progress >= 1) fillClasses.push('progress__fill--complete')

  const clamped = Math.max(0, Math.min(1, progress))

  return (
    <div
      className={`progress${indeterminate ? ' progress--indeterminate' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // An indeterminate bar must not advertise a value it does not have.
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
      aria-valuetext={indeterminate ? 'Checking files' : formatPercent(clamped)}
    >
      <div className={fillClasses.join(' ')} style={{ width: `${clamped * 100}%` }} />
    </div>
  )
}

// -------------------------------------------------------------------- spinner

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />
}

// --------------------------------------------------------------- empty state

export function EmptyState({
  glyph,
  title,
  body,
  action
}: {
  glyph: ReactNode
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty__glyph">{glyph}</div>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__body">{body}</p>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------- stat

export function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value" title={title}>
        {value}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------- tabs

export function Tabs<T extends string>({
  items,
  value,
  onChange
}: {
  items: ReadonlyArray<{ id: T; label: string }>
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className={`tabs__item${value === item.id ? ' tabs__item--active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

// -------------------------------------------------------------------- dialog

export function Dialog({
  title,
  children,
  actions,
  onDismiss
}: {
  title: string
  children: ReactNode
  actions: ReactNode
  onDismiss: () => void
}) {
  // Escape closes, which is what every macOS sheet does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div
      className="overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="dialog__title">{title}</h2>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------- context menu

export interface MenuEntry {
  id: string
  label: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  shortcut?: string
  /** Renders a checkmark, for menus that show the currently selected value. */
  checked?: boolean
  /** A non-interactive section heading. */
  heading?: boolean
}

export function ContextMenu({
  x,
  y,
  entries,
  onDismiss
}: {
  x: number
  y: number
  entries: MenuEntry[]
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Keep the menu on screen: flip it back inside the viewport if it would
  // overflow, which is what a native menu does near an edge.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8
    setPosition({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [x, y])

  useEffect(() => {
    // Dismiss on a press *outside* the menu only. Listening in the capture
    // phase without this check unmounted the menu on mousedown, before the
    // click could land on the item -- which silently broke every menu action.
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      onDismiss()
    }
    const dismiss = () => onDismiss()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  return (
    <div ref={ref} className="menu" style={position} role="menu">
      {entries.map((entry, index) =>
        entry.separator ? (
          <div key={`sep-${index}`} className="menu__separator" role="separator" />
        ) : entry.heading ? (
          <div key={entry.id} className="menu__heading">
            {entry.label}
          </div>
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitemradio"
            aria-checked={entry.checked ?? false}
            className={`menu__item${entry.danger ? ' menu__item--danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onDismiss()
              entry.onSelect?.()
            }}
          >
            <span>
              <span className="menu__check">{entry.checked ? '✓' : ''}</span>
              {entry.label}
            </span>
            {entry.shortcut ? <span className="menu__shortcut">{entry.shortcut}</span> : null}
          </button>
        )
      )}
    </div>
  )
}

// -------------------------------------------------------------------- toasts

export function Toasts({
  toasts,
  onDismiss
}: {
  toasts: Array<{ id: number; kind: 'info' | 'success' | 'error'; title: string; message?: string }>
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast${toast.kind === 'error' ? ' toast--error' : toast.kind === 'success' ? ' toast--success' : ''}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          {toast.kind === 'error' ? <IconWarning /> : toast.kind === 'success' ? <IconCheck /> : null}
          <div className="toast__body">
            <div className="toast__title">{toast.title}</div>
            {toast.message ? <div className="toast__message">{toast.message}</div> : null}
          </div>
          <Button variant="quiet" size="icon" title="Dismiss" onClick={() => onDismiss(toast.id)}>
            <IconClose size={13} />
          </Button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- setting row

export function SettingRow({
  name,
  hint,
  children,
  wide
}: {
  name: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__name">{name}</div>
        {hint ? <div className="setting__hint">{hint}</div> : null}
      </div>
      <div className={`setting__control${wide ? ' setting__control--wide' : ''}`}>{children}</div>
    </div>
  )
}
