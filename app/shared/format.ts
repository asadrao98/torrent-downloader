/** Human-readable formatting helpers. Pure; used by the renderer and the tray. */

import { UNLIMITED } from './constants.js'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Formats a byte count, e.g. `4.2 GB`. Uses 1024-based units. */
export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const unit = UNITS[exponent]!

  const digits =
    fractionDigits ?? (exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 2 : 2)

  return `${value.toFixed(digits)} ${unit}`
}

/** Formats a transfer rate, e.g. `8.4 MB/s`. Zero renders as an em dash. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Formats a duration in seconds the way a download client should: coarse enough
 * to stay readable, never more than two units.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return '0s'
  if (seconds > 60 * 60 * 24 * 365) return '∞'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

/** ETA has its own formatter so we can show a distinct string when stalled. */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return '—'
  return formatDuration(seconds)
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '—'
  const clamped = Math.max(0, Math.min(1, fraction))
  // Never round up to 100% before the torrent is genuinely complete.
  const pct = clamped * 100
  if (clamped < 1 && pct > 99.9) return '99.9%'
  return `${pct.toFixed(digits)}%`
}

export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '∞'
  return ratio.toFixed(2)
}

/** Renders a bandwidth limit for display; `UNLIMITED` becomes `Unlimited`. */
export function formatLimit(bytesPerSecond: number): string {
  if (bytesPerSecond === UNLIMITED || bytesPerSecond < 0) return 'Unlimited'
  if (bytesPerSecond === 0) return 'Stopped'
  return formatSpeed(bytesPerSecond)
}

/**
 * Parses a user-typed limit such as `500 KB/s`, `1.5MB`, `750k` or `unlimited`
 * into bytes/second. Returns null when the text cannot be understood, so the
 * settings UI can show a validation message instead of silently using 0.
 */
export function parseLimit(input: string): number | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === '' || trimmed === 'unlimited' || trimmed === '-1' || trimmed === '∞') {
    return UNLIMITED
  }

  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?(?:\/s|ps)?$/.exec(trimmed)
  if (!match) return null

  const value = Number(match[1]!.replace(',', '.'))
  if (!Number.isFinite(value) || value < 0) return null

  const unit = match[2] ?? 'kb'
  const multiplier =
    unit === 'b' ? 1
      : unit === 'k' || unit === 'kb' || unit === 'kib' ? 1024
        : unit === 'm' || unit === 'mb' || unit === 'mib' ? 1024 ** 2
          : 1024 ** 3

  const bytes = Math.round(value * multiplier)
  return Number.isSafeInteger(bytes) ? bytes : null
}

/** Truncates a long torrent or file name for the middle of a table cell. */
export function truncateMiddle(value: string, maxLength = 60): string {
  if (value.length <= maxLength) return value
  const keep = maxLength - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/** Formats an absolute timestamp for the trackers tab. */
export function formatTime(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs) || epochMs <= 0) return '—'
  const date = new Date(epochMs)
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Relative time for "last announce", e.g. `12s ago`. */
export function formatRelative(epochMs: number | null, now: number): string {
  if (epochMs === null || !Number.isFinite(epochMs) || epochMs <= 0) return '—'
  const delta = Math.round((now - epochMs) / 1000)
  if (delta < 0) return `in ${formatDuration(-delta)}`
  if (delta < 2) return 'just now'
  return `${formatDuration(delta)} ago`
}

/** Replaces the download path's home prefix with `~` for display. */
export function prettyPath(fullPath: string, homeDir: string): string {
  if (homeDir.length > 0 && fullPath.startsWith(homeDir)) {
    return `~${fullPath.slice(homeDir.length)}`
  }
  return fullPath
}
