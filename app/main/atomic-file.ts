/**
 * Atomic JSON/binary file writes.
 *
 * The torrent list and settings are written on a timer and on quit. A partial
 * write (power loss, forced quit, disk full) must never leave a truncated file
 * behind, because that would lose every torrent in the session. Write to a
 * temporary sibling, fsync, then rename -- rename is atomic within a volume.
 */

import { promises as fs } from 'node:fs'
import { dirname, join, basename } from 'node:path'

async function writeAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.tmp`)
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    // Without the fsync the rename can land before the contents do.
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, filePath)
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeAtomic(filePath, JSON.stringify(value, null, 2))
}

export async function writeBytesAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  await writeAtomic(filePath, bytes)
}

/**
 * Reads and parses JSON. Returns null when the file is missing, empty or
 * corrupt -- callers fall back to defaults rather than failing to start.
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    if (text.trim().length === 0) return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function readBytes(filePath: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(filePath))
  } catch {
    return null
  }
}

export async function removeFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true })
}
