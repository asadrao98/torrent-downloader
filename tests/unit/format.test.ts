import { describe, it, expect } from 'vitest'
import {
  formatBytes,
  formatSpeed,
  formatDuration,
  formatPercent,
  formatRatio,
  formatLimit,
  parseLimit,
  truncateMiddle,
  formatRelative,
  prettyPath
} from '@shared/format.js'
import { UNLIMITED } from '@shared/constants.js'

describe('formatBytes', () => {
  it('formats each magnitude readably', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(12 * 1024)).toBe('12.0 KB')
    expect(formatBytes(4.2 * 1024 ** 3)).toBe('4.20 GB')
  })

  it('handles invalid input without throwing', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('respects an explicit digit count', () => {
    expect(formatBytes(1536, 0)).toBe('2 KB')
  })
})

describe('formatSpeed', () => {
  it('renders a rate', () => {
    expect(formatSpeed(8.4 * 1024 ** 2)).toBe('8.40 MB/s')
  })

  it('renders idle as an em dash rather than 0', () => {
    expect(formatSpeed(0)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('uses at most two units', () => {
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(222)).toBe('3m 42s')
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe('3h 25m')
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe('2d 5h')
  })

  it('handles unknown and absurd values', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatDuration(1e12)).toBe('∞')
    expect(formatDuration(0.4)).toBe('0s')
  })
})

describe('formatPercent', () => {
  it('formats a fraction', () => {
    expect(formatPercent(0.5)).toBe('50.0%')
    expect(formatPercent(0.723)).toBe('72.3%')
    expect(formatPercent(1)).toBe('100.0%')
  })

  // Showing 100% on an incomplete torrent is the classic progress-bar lie.
  it('never rounds up to 100% before completion', () => {
    expect(formatPercent(0.99999)).toBe('99.9%')
  })

  it('clamps out-of-range input', () => {
    expect(formatPercent(-0.2)).toBe('0.0%')
    expect(formatPercent(1.7)).toBe('100.0%')
  })
})

describe('formatRatio', () => {
  it('formats to two decimals', () => {
    expect(formatRatio(0.8412)).toBe('0.84')
    expect(formatRatio(0)).toBe('0.00')
  })

  it('renders an infinite ratio (uploaded with nothing downloaded)', () => {
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe('∞')
  })
})

describe('formatLimit / parseLimit', () => {
  it('round-trips unlimited', () => {
    expect(formatLimit(UNLIMITED)).toBe('Unlimited')
    expect(parseLimit('Unlimited')).toBe(UNLIMITED)
    expect(parseLimit('')).toBe(UNLIMITED)
    expect(parseLimit('-1')).toBe(UNLIMITED)
  })

  it('parses the units a user would actually type', () => {
    expect(parseLimit('500')).toBe(500 * 1024) // bare number means KB/s
    expect(parseLimit('500 KB/s')).toBe(500 * 1024)
    expect(parseLimit('500kb')).toBe(500 * 1024)
    expect(parseLimit('1.5 MB/s')).toBe(Math.round(1.5 * 1024 ** 2))
    expect(parseLimit('2MiB')).toBe(2 * 1024 ** 2)
    expect(parseLimit('1024 B')).toBe(1024)
    expect(parseLimit('1g')).toBe(1024 ** 3)
  })

  it('accepts a comma decimal separator', () => {
    expect(parseLimit('1,5MB')).toBe(Math.round(1.5 * 1024 ** 2))
  })

  it('rejects nonsense rather than silently returning 0', () => {
    expect(parseLimit('fast')).toBeNull()
    expect(parseLimit('-5 MB')).toBeNull()
    expect(parseLimit('12 parsecs')).toBeNull()
    expect(parseLimit('1e9')).toBeNull()
  })

  it('formats a concrete limit', () => {
    expect(formatLimit(500 * 1024)).toBe('500 KB/s')
    expect(formatLimit(0)).toBe('Stopped')
  })
})

describe('truncateMiddle', () => {
  it('leaves short strings alone', () => {
    expect(truncateMiddle('short.iso', 20)).toBe('short.iso')
  })

  it('elides the middle and respects the budget', () => {
    const out = truncateMiddle('a'.repeat(100), 21)
    expect(out).toHaveLength(21)
    expect(out).toContain('…')
  })
})

describe('formatRelative', () => {
  const now = 1_700_000_000_000

  it('formats recent and older timestamps', () => {
    expect(formatRelative(now, now)).toBe('just now')
    expect(formatRelative(now - 12_000, now)).toBe('12s ago')
    expect(formatRelative(now - 300_000, now)).toBe('5m 0s ago')
  })

  it('formats a future timestamp (next announce)', () => {
    expect(formatRelative(now + 60_000, now)).toBe('in 1m 0s')
  })

  it('handles null', () => {
    expect(formatRelative(null, now)).toBe('—')
  })
})

describe('prettyPath', () => {
  it('collapses the home directory to a tilde', () => {
    expect(prettyPath('/Users/me/Downloads/Torrents', '/Users/me')).toBe('~/Downloads/Torrents')
  })

  it('leaves paths outside home alone', () => {
    expect(prettyPath('/Volumes/External/T', '/Users/me')).toBe('/Volumes/External/T')
  })
})
