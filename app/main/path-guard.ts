/**
 * Filesystem-level containment checks.
 *
 * `app/shared/path-safety.ts` sanitises the *strings* that came out of torrent
 * metadata. This module is the second layer: it resolves paths against the real
 * filesystem (following symlinks) and refuses anything that lands outside the
 * chosen download directory. Both layers exist because either one alone can be
 * defeated -- string sanitisation misses symlinks, and resolution alone would
 * happily create a file called `../evil` if the name never gets normalised.
 */

import { promises as fs, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep, dirname } from 'node:path'
import { homedir } from 'node:os'

export class UnsafePathError extends Error {
  constructor(
    message: string,
    readonly attemptedPath: string
  ) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

/**
 * Directories we refuse to use as a download target even if the user picks
 * them. Writing a torrent into any of these is never what someone means to do,
 * and a malicious magnet that arrives via the URL scheme should not be able to
 * talk the app into it.
 */
function forbiddenRoots(): string[] {
  const home = homedir()
  return [
    '/System',
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var/db',
    '/private/etc',
    '/private/var/db',
    join(home, 'Library', 'LaunchAgents'),
    join(home, 'Library', 'Keychains'),
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.config', 'gcloud')
  ]
}

/** True when `child` is strictly inside `parent`, on resolved absolute paths. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  if (p === c) return false
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * Resolves the deepest existing ancestor of `target` through symlinks.
 * Used so a symlinked download directory (common on external volumes) still
 * validates, while a symlink *inside* the tree cannot be used to escape.
 */
function realpathOfNearestExistingAncestor(target: string): string {
  let current = resolve(target)
  // Walk up until something exists; `/` always does.
  for (;;) {
    try {
      return realpathSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

/**
 * Validates that a directory is an acceptable download target.
 * Throws `UnsafePathError` with a user-facing message when it is not.
 */
export async function assertUsableDownloadDirectory(dir: string): Promise<string> {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    throw new UnsafePathError('No download folder was selected.', dir)
  }
  if (!isAbsolute(dir)) {
    throw new UnsafePathError('The download folder must be an absolute path.', dir)
  }

  const resolved = resolve(dir)
  const real = realpathOfNearestExistingAncestor(resolved)

  if (real === '/' ) {
    throw new UnsafePathError('The download folder cannot be the system root.', dir)
  }

  for (const root of forbiddenRoots()) {
    if (real === root || isStrictlyInside(root, real)) {
      throw new UnsafePathError(
        'That folder is a protected system location. Choose somewhere in your home folder instead.',
        dir
      )
    }
  }

  // Create it if missing, then confirm we can actually write there. Doing this
  // up front turns a mid-download failure into an error at add time.
  try {
    await fs.mkdir(resolved, { recursive: true })
  } catch (err) {
    throw new UnsafePathError(
      `The download folder could not be created: ${(err as Error).message}`,
      dir
    )
  }

  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat) {
    throw new UnsafePathError('The download folder is not accessible.', dir)
  }
  if (!stat.isDirectory()) {
    throw new UnsafePathError('The download location is a file, not a folder.', dir)
  }

  try {
    await fs.access(resolved, fs.constants.W_OK | fs.constants.X_OK)
  } catch {
    throw new UnsafePathError(
      'The download folder is not writable. Check its permissions, or pick another folder.',
      dir
    )
  }

  return resolved
}

/**
 * Final gate before we let the engine write a file: the resolved destination
 * must sit strictly inside the download root.
 *
 * `relativePath` is expected to have already been through
 * `sanitizeTorrentPath`; this catches anything that slipped past, including a
 * pre-existing symlink pointing out of the tree.
 */
export function assertFileWithinRoot(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root)

  if (isAbsolute(relativePath)) {
    throw new UnsafePathError(
      'A file in this torrent used an absolute path and was blocked.',
      relativePath
    )
  }
  if (relativePath.split(/[/\\]/).includes('..')) {
    throw new UnsafePathError(
      'A file in this torrent tried to escape the download folder and was blocked.',
      relativePath
    )
  }

  const target = resolve(join(resolvedRoot, relativePath))
  if (!isStrictlyInside(resolvedRoot, target)) {
    throw new UnsafePathError(
      'A file in this torrent resolved outside the download folder and was blocked.',
      relativePath
    )
  }

  // If any existing component is a symlink leading out of the tree, reject.
  const realAncestor = realpathOfNearestExistingAncestor(target)
  const realRoot = realpathOfNearestExistingAncestor(resolvedRoot)
  if (realAncestor !== realRoot && !isStrictlyInside(realRoot, realAncestor)) {
    throw new UnsafePathError(
      'A path inside the download folder is a link pointing outside it, so this file was blocked.',
      relativePath
    )
  }

  return target
}

/** Free space on the volume holding `dir`, or null when it cannot be read. */
export async function freeSpaceFor(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}
