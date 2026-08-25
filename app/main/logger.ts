/**
 * File + in-memory logging.
 *
 * Two consumers: a rotating log file for troubleshooting after the fact, and a
 * bounded ring buffer that backs the in-app log viewer (Settings -> Advanced).
 *
 * Deliberately never logs credentials or peer IP addresses at info level -- peer
 * addresses are personal data of a sort, and there is no reason to keep them on
 * disk. They appear in the live Peers tab only, and in the log file only when
 * verbose logging is explicitly switched on.
 */

import { createWriteStream, mkdirSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { WriteStream } from 'node:fs'
import type { LogEntry, LogLevel } from '@shared/types.js'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Rotate at 5 MB, keep one previous file. Enough to diagnose, bounded on disk. */
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** Entries retained for the in-app viewer. */
const RING_BUFFER_SIZE = 2_000

export class Logger {
  private stream: WriteStream | null = null
  private readonly ring: LogEntry[] = []
  private listeners = new Set<(entry: LogEntry) => void>()
  private minLevel: LogLevel = 'info'
  private readonly logFilePath: string

  constructor(private readonly logDir: string) {
    this.logFilePath = join(logDir, 'torrent-downloader.log')
  }

  /** Opens the log file, rotating first if it has grown too large. */
  open(): void {
    if (this.stream) return
    try {
      mkdirSync(this.logDir, { recursive: true })
      this.rotateIfNeeded()
      this.stream = createWriteStream(this.logFilePath, { flags: 'a' })
      this.stream.on('error', (err) => {
        // Losing the log file must never take the app down.
        console.error('[logger] log stream error:', err.message)
        this.stream = null
      })
    } catch (err) {
      console.error('[logger] could not open log file:', (err as Error).message)
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logFilePath)) return
      const { size } = statSync(this.logFilePath)
      if (size < MAX_LOG_BYTES) return
      const previous = `${this.logFilePath}.1`
      if (existsSync(previous)) unlinkSync(previous)
      renameSync(this.logFilePath, previous)
    } catch {
      // A failed rotation is not worth failing startup over.
    }
  }

  setVerbose(verbose: boolean): void {
    this.minLevel = verbose ? 'debug' : 'info'
  }

  get filePath(): string {
    return this.logFilePath
  }

  get directory(): string {
    return this.logDir
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Most recent entries, oldest first. */
  recent(limit = RING_BUFFER_SIZE): LogEntry[] {
    return this.ring.slice(Math.max(0, this.ring.length - limit))
  }

  private write(level: LogLevel, scope: string, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return

    const entry: LogEntry = { time: Date.now(), level, scope, message }

    this.ring.push(entry)
    if (this.ring.length > RING_BUFFER_SIZE) this.ring.shift()

    const iso = new Date(entry.time).toISOString()
    const line = `${iso} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`

    if (this.stream) {
      this.stream.write(line)
    } else if (level === 'error') {
      console.error(line.trimEnd())
    }

    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        // A misbehaving listener must not break logging.
      }
    }
  }

  /** Returns a logger bound to a scope, so call sites stay short. */
  scoped(scope: string) {
    return {
      debug: (message: string) => this.write('debug', scope, message),
      info: (message: string) => this.write('info', scope, message),
      warn: (message: string) => this.write('warn', scope, message),
      error: (message: string) => this.write('error', scope, message)
    }
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}

let singleton: Logger | null = null

export function initLogger(logDir: string): Logger {
  singleton = new Logger(logDir)
  singleton.open()
  return singleton
}

export function getLogger(): Logger {
  if (!singleton) throw new Error('logger used before initLogger()')
  return singleton
}

/** Convenience for modules that just want to log without holding a reference. */
export function log(scope: string) {
  return getLogger().scoped(scope)
}

/**
 * Converts an unknown thrown value into a message safe to show a user.
 * Stack traces stay in the log file; the UI gets the message only.
 */
export function toUserMessage(err: unknown, fallback = 'An unexpected error occurred.'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.length > 0) return err
  return fallback
}

/** Full detail for the log file, including the stack. */
export function toLogDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
