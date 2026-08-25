import { describe, it, expect } from 'vitest'
import {
  sanitizeTorrentPath,
  sanitizeTorrentPaths,
  sanitizeTorrentName,
  isPathInside
} from '@shared/path-safety.js'

const NUL = String.fromCodePoint(0)
const RLO = String.fromCodePoint(0x202e)

/** The invariant every sanitised path must satisfy, whatever the input. */
function assertSafe(result: { path: string }) {
  const p = result.path
  expect(p.length).toBeGreaterThan(0)
  expect(p.startsWith('/')).toBe(false)
  expect(p.startsWith('~')).toBe(false)
  expect(p.split('/')).not.toContain('..')
  expect(p.split('/')).not.toContain('.')
  expect(p).not.toContain('\\')
  expect(p).not.toContain(NUL)
  expect(/^[a-zA-Z]:/.test(p)).toBe(false)
}

describe('sanitizeTorrentPath — ordinary input passes through', () => {
  it('leaves a simple filename alone', () => {
    const r = sanitizeTorrentPath('ubuntu.iso')
    expect(r.path).toBe('ubuntu.iso')
    expect(r.sanitized).toBe(false)
    assertSafe(r)
  })

  it('leaves a nested path alone', () => {
    const r = sanitizeTorrentPath('Ubuntu 26.04/extras/README.txt')
    expect(r.path).toBe('Ubuntu 26.04/extras/README.txt')
    expect(r.sanitized).toBe(false)
    assertSafe(r)
  })

  it('preserves unicode filenames', () => {
    const r = sanitizeTorrentPath('映画/日本語ファイル.mkv')
    expect(r.path).toBe('映画/日本語ファイル.mkv')
    assertSafe(r)
  })

  it('preserves a leading dot (hidden file)', () => {
    const r = sanitizeTorrentPath('.hidden')
    expect(r.path).toBe('.hidden')
    assertSafe(r)
  })
})

describe('sanitizeTorrentPath — path traversal', () => {
  it('strips parent-directory references', () => {
    const r = sanitizeTorrentPath('../../some-file')
    expect(r.path).toBe('some-file')
    expect(r.sanitized).toBe(true)
    assertSafe(r)
  })

  it('strips traversal buried in the middle of a path', () => {
    const r = sanitizeTorrentPath('a/b/../../../../../../etc/passwd')
    expect(r.path).toBe('a/b/etc/passwd')
    assertSafe(r)
  })

  it('handles backslash separators used for traversal', () => {
    const r = sanitizeTorrentPath('..\\..\\Windows\\System32\\evil.dll')
    expect(r.path).toBe('Windows/System32/evil.dll')
    assertSafe(r)
  })

  it('makes an absolute path relative', () => {
    const r = sanitizeTorrentPath('/etc/passwd')
    expect(r.path).toBe('etc/passwd')
    assertSafe(r)
  })

  it('strips a Windows drive letter', () => {
    const r = sanitizeTorrentPath('C:\\Windows\\evil.exe')
    expect(r.path).toBe('Windows/evil.exe')
    assertSafe(r)
  })

  it('strips a UNC prefix', () => {
    const r = sanitizeTorrentPath('\\\\server\\share\\file.txt')
    expect(r.path).toBe('server/share/file.txt')
    assertSafe(r)
  })

  it('handles a path consisting only of traversal', () => {
    const r = sanitizeTorrentPath('../../../..')
    assertSafe(r)
    expect(r.sanitized).toBe(true)
  })

  it('handles the empty string', () => {
    const r = sanitizeTorrentPath('')
    assertSafe(r)
  })

  it('does not let a home-directory shortcut through', () => {
    const r = sanitizeTorrentPath('~/.ssh/authorized_keys')
    assertSafe(r)
    // The tilde is escaped rather than kept: it is inert to the filesystem but
    // expands to $HOME in any shell, and these paths get logged and displayed.
    expect(r.path).toBe('_~/.ssh/authorized_keys')
    expect(r.sanitized).toBe(true)
  })

  it('escapes a leading tilde on a plain filename too', () => {
    expect(sanitizeTorrentPath('~evil').path).toBe('_~evil')
  })
})

describe('sanitizeTorrentPath — hostile filenames', () => {
  it('removes NUL and control characters', () => {
    const r = sanitizeTorrentPath(`evil${NUL}name.txt`)
    expect(r.path).toBe('evilname.txt')
    expect(r.sanitized).toBe(true)
    assertSafe(r)
  })

  it('removes bidi overrides used to fake an extension', () => {
    const r = sanitizeTorrentPath(`invoice${RLO}fdp.exe`)
    expect(r.path).not.toContain(RLO)
    assertSafe(r)
  })

  it('replaces a colon, which Finder treats as a separator', () => {
    const r = sanitizeTorrentPath('some:file.txt')
    expect(r.path).toBe('some_file.txt')
    assertSafe(r)
  })

  it('strips trailing dots and spaces', () => {
    expect(sanitizeTorrentPath('file.txt   ').path).toBe('file.txt')
    expect(sanitizeTorrentPath('file.txt...').path).toBe('file.txt')
  })

  it('escapes Windows reserved device names', () => {
    expect(sanitizeTorrentPath('CON').path).toBe('_CON')
    expect(sanitizeTorrentPath('nul.txt').path).toBe('_nul.txt')
    expect(sanitizeTorrentPath('a/PRN/b').path).toBe('a/_PRN/b')
  })

  it('truncates an over-long component to a filesystem-legal length', () => {
    const long = 'a'.repeat(500)
    const r = sanitizeTorrentPath(`${long}.iso`)
    const bytes = new TextEncoder().encode(r.path).length
    expect(bytes).toBeLessThanOrEqual(255)
    assertSafe(r)
  })

  it('truncates an over-long multi-byte component without splitting a code point', () => {
    const r = sanitizeTorrentPath('あ'.repeat(300))
    expect(() => new TextEncoder().encode(r.path)).not.toThrow()
    expect(r.path.includes('\uFFFD')).toBe(false)
    assertSafe(r)
  })

  it('flattens pathological nesting depth', () => {
    const deep = Array.from({ length: 200 }, (_, i) => `d${i}`).join('/')
    const r = sanitizeTorrentPath(`${deep}/file.txt`)
    expect(r.path.split('/').length).toBeLessThanOrEqual(32)
    assertSafe(r)
  })

  it('caps the total path length', () => {
    const deep = Array.from({ length: 30 }, () => 'x'.repeat(150)).join('/')
    const r = sanitizeTorrentPath(deep)
    expect(new TextEncoder().encode(r.path).length).toBeLessThanOrEqual(800)
    assertSafe(r)
  })
})

describe('sanitizeTorrentPaths — collisions', () => {
  it('keeps distinct paths untouched', () => {
    const r = sanitizeTorrentPaths(['a.txt', 'b.txt', 'dir/c.txt'])
    expect(r.map((x) => x.path)).toEqual(['a.txt', 'b.txt', 'dir/c.txt'])
  })

  it('renames exact duplicates so one cannot overwrite the other', () => {
    const r = sanitizeTorrentPaths(['dup.txt', 'dup.txt', 'dup.txt'])
    expect(r.map((x) => x.path)).toEqual(['dup.txt', 'dup (2).txt', 'dup (3).txt'])
    expect(new Set(r.map((x) => x.path)).size).toBe(3)
  })

  it('renames paths that only collide after sanitisation', () => {
    // Both of these sanitise to `x.txt` -- a classic overwrite attempt.
    const r = sanitizeTorrentPaths(['../x.txt', 'x.txt'])
    expect(new Set(r.map((x) => x.path)).size).toBe(2)
    r.forEach(assertSafe)
  })

  it('dedupes case-insensitively, since APFS is case-insensitive by default', () => {
    const r = sanitizeTorrentPaths(['File.TXT', 'file.txt'])
    expect(new Set(r.map((x) => x.path.toLowerCase())).size).toBe(2)
  })

  it('inserts the counter before the extension, not after', () => {
    const r = sanitizeTorrentPaths(['movie.mkv', 'movie.mkv'])
    expect(r[1]!.path).toBe('movie (2).mkv')
  })

  it('handles a dotfile collision without inventing an extension', () => {
    const r = sanitizeTorrentPaths(['.env', '.env'])
    expect(r[0]!.path).toBe('.env')
    expect(r[1]!.path).toBe('.env (2)')
  })

  it('keeps collision suffixes inside the same directory', () => {
    const r = sanitizeTorrentPaths(['dir/f.bin', 'dir/f.bin'])
    expect(r[1]!.path).toBe('dir/f (2).bin')
  })

  it('survives a large hostile file list with every path identical', () => {
    const paths = Array.from({ length: 500 }, () => '../../same.bin')
    const r = sanitizeTorrentPaths(paths)
    expect(new Set(r.map((x) => x.path)).size).toBe(500)
    r.forEach(assertSafe)
  })

  it('reports the original path alongside the safe one', () => {
    const r = sanitizeTorrentPaths(['../../escape.txt'])
    expect(r[0]!.originalPath).toBe('../../escape.txt')
    expect(r[0]!.path).toBe('escape.txt')
    expect(r[0]!.reasons.length).toBeGreaterThan(0)
  })
})

describe('sanitizeTorrentName', () => {
  it('keeps a normal name', () => {
    expect(sanitizeTorrentName('Ubuntu 26.04', 'fallback')).toBe('Ubuntu 26.04')
  })

  it('falls back when the name sanitises to nothing', () => {
    expect(sanitizeTorrentName('..', 'fallback')).toBe('fallback')
    expect(sanitizeTorrentName('', 'fallback')).toBe('fallback')
    expect(sanitizeTorrentName('/', 'fallback')).toBe('fallback')
  })

  it('never returns a name containing a separator', () => {
    const name = sanitizeTorrentName('a/b/c', 'fallback')
    expect(name).not.toContain('/')
  })
})

describe('isPathInside', () => {
  it('accepts a genuine child', () => {
    expect(isPathInside('/Users/x/Downloads', '/Users/x/Downloads/a/b.iso')).toBe(true)
  })

  it('rejects the directory itself', () => {
    expect(isPathInside('/Users/x/Downloads', '/Users/x/Downloads')).toBe(false)
  })

  it('rejects a sibling with a shared prefix', () => {
    expect(isPathInside('/Users/x/Downloads', '/Users/x/Downloads-evil/a')).toBe(false)
  })

  it('rejects an escape', () => {
    expect(isPathInside('/Users/x/Downloads', '/Users/x/.ssh/id_rsa')).toBe(false)
    expect(isPathInside('/Users/x/Downloads', '/etc/passwd')).toBe(false)
  })

  it('rejects an empty parent', () => {
    expect(isPathInside('', '/anything')).toBe(false)
  })
})
