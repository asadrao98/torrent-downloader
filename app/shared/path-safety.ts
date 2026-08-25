/**
 * Sanitisation of file paths that came out of torrent metadata.
 *
 * Torrent metadata is attacker-controlled. The info dict's `path` lists are
 * arbitrary byte strings chosen by whoever made the torrent, and a malicious
 * one will happily contain `..`, absolute paths, NUL bytes, or names designed
 * to escape the download directory or overwrite something important.
 *
 * The rule this module enforces: every file in a torrent resolves to a path
 * strictly inside the chosen download directory, or it is not written at all.
 *
 * Pure module -- string logic only, no Node or DOM. The filesystem-level
 * containment assertion that backs this up lives in `app/main/path-guard.ts`.
 */

/** APFS/HFS+ allow 255 UTF-8 bytes per component. Leave room for dedupe suffixes. */
const MAX_COMPONENT_BYTES = 200
/** Conservative cap on the relative path we build, well under macOS PATH_MAX. */
const MAX_RELATIVE_PATH_BYTES = 800
/** A torrent claiming more nesting than this is pathological. */
const MAX_PATH_DEPTH = 32

/**
 * Names Windows reserves. We are a macOS app, but these cost nothing to guard
 * and a sanitised tree should be safe to copy to any volume.
 */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

const FALLBACK_COMPONENT = '_'

export interface SanitizedPath {
  /** Safe path relative to the download root, forward-slash separated. */
  path: string
  /** True when the result differs from the input in any way. */
  sanitized: boolean
  /** Why it was changed, for the log and the UI's "renamed" badge. */
  reasons: string[]
}

function utf8Length(value: string): number {
  // TextEncoder is available in Node and every browser we target.
  return new TextEncoder().encode(value).length
}

/** Truncates to a UTF-8 byte budget without splitting a code point. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value
  let out = ''
  let used = 0
  for (const ch of value) {
    const size = utf8Length(ch)
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/**
 * Cleans a single path component. Returns null when the component carries no
 * information and should be dropped entirely (`.`, empty string).
 */
function sanitizeComponent(component: string, reasons: string[]): string | null {
  let value = component

  // NUL and other control characters terminate strings in POSIX APIs and can
  // be used to smuggle a different path past a naive check.
  if (/[\0-\x1f\x7f]/.test(value)) {
    value = value.replace(/[\0-\x1f\x7f]/g, '')
    reasons.push('removed control characters')
  }

  // Bidi overrides let a filename misrepresent its own extension.
  if (/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(value)) {
    value = value.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, '')
    reasons.push('removed bidirectional text overrides')
  }

  // A literal separator inside a component would create unintended nesting.
  // `:` is a path separator in Finder's legacy API and displays as `/`.
  if (/[/\\:]/.test(value)) {
    value = value.replace(/[/\\:]/g, '_')
    reasons.push('replaced path separators')
  }

  // Normalise to NFC so equality checks and dedupe behave predictably.
  const normalized = value.normalize('NFC')
  if (normalized !== value) reasons.push('normalised unicode')
  value = normalized

  // Trailing dots and spaces are silently stripped by some filesystems, which
  // makes two different-looking names collide.
  const detrailed = value.replace(/[. ]+$/, '')
  if (detrailed !== value) {
    reasons.push('removed trailing dots or spaces')
    value = detrailed
  }

  value = value.trim()

  if (value === '' || value === '.') return null

  // `..` must never survive as a component.
  if (value === '..') {
    reasons.push('removed parent-directory reference')
    return null
  }

  // A leading dot is legal but hides the file; keep it, it is the author's
  // choice and cannot escape the directory.

  const stem = value.split('.')[0]!.toLowerCase()
  if (RESERVED_BASENAMES.has(stem)) {
    value = `_${value}`
    reasons.push('escaped reserved device name')
  }

  // A leading `~` is inert to the filesystem but expands to the home directory
  // in any shell or tilde-aware API. We log and display these paths, so we keep
  // the invariant that a sanitised path never starts with a tilde.
  if (value.startsWith('~')) {
    value = `_${value}`
    reasons.push('escaped leading tilde')
  }

  const truncated = truncateToBytes(value, MAX_COMPONENT_BYTES)
  if (truncated !== value) {
    reasons.push('shortened an over-long name')
    value = truncated
  }

  // Truncation or stripping may have emptied it.
  value = value.replace(/[. ]+$/, '').trim()
  if (value === '' || value === '.' || value === '..') return FALLBACK_COMPONENT

  return value
}

/**
 * Sanitises one torrent file path into a safe path relative to the download
 * root. Never returns an absolute path, a path containing `..`, or an empty
 * path.
 */
export function sanitizeTorrentPath(originalPath: string): SanitizedPath {
  const reasons: string[] = []

  if (typeof originalPath !== 'string' || originalPath.length === 0) {
    return { path: FALLBACK_COMPONENT, sanitized: true, reasons: ['empty path'] }
  }

  let working = originalPath

  // Windows drive letters and UNC prefixes, defensively.
  if (/^[a-zA-Z]:[/\\]/.test(working)) {
    working = working.slice(3)
    reasons.push('removed drive letter')
  }
  if (/^[/\\]{2}/.test(working)) {
    working = working.replace(/^[/\\]+/, '')
    reasons.push('removed UNC prefix')
  }

  // Treat both separators as separators, so `..\..\x` is caught too.
  const rawComponents = working.split(/[/\\]+/)

  if (/^[/\\]/.test(originalPath)) reasons.push('made path relative')

  const components: string[] = []
  for (const raw of rawComponents) {
    const cleaned = sanitizeComponent(raw, reasons)
    if (cleaned === null) continue
    components.push(cleaned)
    if (components.length >= MAX_PATH_DEPTH) {
      reasons.push('flattened excessive nesting')
      break
    }
  }

  if (components.length === 0) {
    return {
      path: FALLBACK_COMPONENT,
      sanitized: true,
      reasons: reasons.length > 0 ? reasons : ['path had no usable components']
    }
  }

  let joined = components.join('/')

  // Final byte budget on the whole relative path: drop leading directories
  // rather than the filename, which is the part the user recognises.
  while (utf8Length(joined) > MAX_RELATIVE_PATH_BYTES && components.length > 1) {
    components.shift()
    joined = components.join('/')
    if (!reasons.includes('shortened an over-long path')) {
      reasons.push('shortened an over-long path')
    }
  }
  if (utf8Length(joined) > MAX_RELATIVE_PATH_BYTES) {
    joined = truncateToBytes(joined, MAX_RELATIVE_PATH_BYTES)
    reasons.push('shortened an over-long path')
  }

  const sanitized = joined !== originalPath
  return { path: joined, sanitized, reasons: sanitized ? reasons : [] }
}

/**
 * Sanitises a whole file list and guarantees the results are unique.
 *
 * Two different original paths can sanitise to the same string (that is exactly
 * what an attacker wants: one file quietly overwriting another). Collisions get
 * a ` (2)`, ` (3)` … suffix inserted before the extension.
 */
export function sanitizeTorrentPaths(
  originalPaths: readonly string[]
): Array<SanitizedPath & { originalPath: string }> {
  // Case-insensitive by default on APFS, so dedupe case-insensitively.
  const taken = new Map<string, number>()
  const results: Array<SanitizedPath & { originalPath: string }> = []

  for (const originalPath of originalPaths) {
    const base = sanitizeTorrentPath(originalPath)
    let candidate = base.path
    const key = () => candidate.toLowerCase()

    if (taken.has(key())) {
      const slash = candidate.lastIndexOf('/')
      const dir = slash === -1 ? '' : candidate.slice(0, slash + 1)
      const filename = slash === -1 ? candidate : candidate.slice(slash + 1)
      const dot = filename.lastIndexOf('.')
      // Treat a leading dot as part of the name, not an extension separator.
      const hasExt = dot > 0
      const stem = hasExt ? filename.slice(0, dot) : filename
      const ext = hasExt ? filename.slice(dot) : ''

      let counter = (taken.get(key()) ?? 1) + 1
      let next = `${dir}${stem} (${counter})${ext}`
      while (taken.has(next.toLowerCase())) {
        counter += 1
        next = `${dir}${stem} (${counter})${ext}`
      }
      taken.set(key(), counter)
      candidate = next

      results.push({
        originalPath,
        path: candidate,
        sanitized: true,
        reasons: [...base.reasons, 'renamed to avoid overwriting another file in this torrent']
      })
      taken.set(candidate.toLowerCase(), 1)
      continue
    }

    taken.set(key(), 1)
    results.push({ ...base, originalPath })
  }

  return results
}

/**
 * Pure containment check on already-normalised absolute paths.
 * `app/main/path-guard.ts` wraps this with real filesystem resolution.
 */
export function isPathInside(parent: string, child: string): boolean {
  if (parent.length === 0) return false
  const normalizedParent = parent.endsWith('/') ? parent : `${parent}/`
  if (child === parent) return false
  return child.startsWith(normalizedParent)
}

/** Sanitises the torrent's own name, used as the containing folder. */
export function sanitizeTorrentName(name: string, fallback: string): string {
  const reasons: string[] = []
  const cleaned = sanitizeComponent(name ?? '', reasons)
  if (cleaned === null || cleaned === FALLBACK_COMPONENT) return fallback
  return cleaned
}
