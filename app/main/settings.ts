/**
 * Settings persistence and validation.
 *
 * The settings file lives on disk and can be hand-edited, so every field is
 * validated and clamped on load. An out-of-range value falls back to the
 * default rather than propagating into the engine, where (for example) a
 * negative connection cap would be a hard failure at startup.
 */

import { join } from 'node:path'
import { DEFAULT_SETTINGS, UNLIMITED } from '@shared/constants.js'
import type {
  AppSettings,
  SeedingGoal,
  SettingsPatch,
  ThemePreference
} from '@shared/types.js'
import { readJson, writeJsonAtomic } from './atomic-file.js'

const THEMES: ThemePreference[] = ['system', 'light', 'dark']
const SEEDING_KINDS: SeedingGoal['kind'][] = ['ratio', 'time', 'forever']

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Clamps a number into range, falling back when it is not a finite number. */
function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** A bandwidth limit: `UNLIMITED` (-1) or a non-negative byte rate. */
function limit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < 0) return UNLIMITED
  // 10 GB/s is far past any real link; anything beyond is a typo or an attack.
  return Math.min(Math.round(value), 10 * 1024 ** 3)
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback
}

function validateSeeding(raw: unknown, fallback: SeedingGoal): SeedingGoal {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    kind: oneOf(r.kind, SEEDING_KINDS, fallback.kind),
    // 0 would mean "stop seeding immediately", which is a legitimate choice.
    ratio: (() => {
      const v = r.ratio
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fallback.ratio
      return Math.min(v, 10_000)
    })(),
    minutes: int(r.minutes, fallback.minutes, 0, 60 * 24 * 365)
  }
}

/**
 * Produces a fully-populated, validated settings object from arbitrary input.
 * Exported so it can be unit-tested without touching the filesystem.
 */
export function validateSettings(raw: unknown, defaultDownloadPath: string): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const general = (r.general ?? {}) as Record<string, unknown>
  const downloads = (r.downloads ?? {}) as Record<string, unknown>
  const bandwidth = (r.bandwidth ?? {}) as Record<string, unknown>
  const appearance = (r.appearance ?? {}) as Record<string, unknown>
  const advanced = (r.advanced ?? {}) as Record<string, unknown>

  const d = DEFAULT_SETTINGS

  const rawPath = downloads.defaultPath
  const defaultPath =
    typeof rawPath === 'string' && rawPath.trim().length > 0 && rawPath.startsWith('/')
      ? rawPath
      : defaultDownloadPath

  return {
    general: {
      launchAtLogin: bool(general.launchAtLogin, d.general.launchAtLogin),
      startDownloadsAutomatically: bool(
        general.startDownloadsAutomatically,
        d.general.startDownloadsAutomatically
      ),
      showNotifications: bool(general.showNotifications, d.general.showNotifications),
      confirmTorrentRemoval: bool(general.confirmTorrentRemoval, d.general.confirmTorrentRemoval),
      showInMenuBar: bool(general.showInMenuBar, d.general.showInMenuBar),
      confirmExternalMagnets: bool(general.confirmExternalMagnets, d.general.confirmExternalMagnets)
    },
    downloads: {
      defaultPath,
      askForLocation: bool(downloads.askForLocation, d.downloads.askForLocation),
      maxActiveTorrents: int(downloads.maxActiveTorrents, d.downloads.maxActiveTorrents, 1, 100)
    },
    bandwidth: {
      downloadLimit: limit(bandwidth.downloadLimit, d.bandwidth.downloadLimit),
      uploadLimit: limit(bandwidth.uploadLimit, d.bandwidth.uploadLimit),
      maxConnections: int(bandwidth.maxConnections, d.bandwidth.maxConnections, 4, 2000),
      listenPort: int(bandwidth.listenPort, d.bandwidth.listenPort, 0, 65535),
      enableDht: bool(bandwidth.enableDht, d.bandwidth.enableDht),
      enablePex: bool(bandwidth.enablePex, d.bandwidth.enablePex),
      enableLsd: bool(bandwidth.enableLsd, d.bandwidth.enableLsd),
      enableUtp: bool(bandwidth.enableUtp, d.bandwidth.enableUtp),
      enableUpnp: bool(bandwidth.enableUpnp, d.bandwidth.enableUpnp),
      encryptionLevel: int(bandwidth.encryptionLevel, d.bandwidth.encryptionLevel, 0, 2) as 0 | 1 | 2
    },
    seeding: validateSeeding(r.seeding, d.seeding),
    appearance: {
      theme: oneOf(appearance.theme, THEMES, d.appearance.theme)
    },
    advanced: {
      verboseLogging: bool(advanced.verboseLogging, d.advanced.verboseLogging)
    }
  }
}

/** Merges a shallow-per-section patch onto the current settings. */
export function applyPatch(
  current: AppSettings,
  patch: SettingsPatch,
  defaultDownloadPath: string
): AppSettings {
  const merged: Record<string, unknown> = { ...current }
  for (const key of Object.keys(patch) as Array<keyof AppSettings>) {
    const section = patch[key]
    if (!section) continue
    if (key === 'seeding' || key === 'appearance') {
      merged[key] = { ...(current[key] as object), ...(section as object) }
    } else {
      merged[key] = { ...(current[key] as object), ...(section as object) }
    }
  }
  // Re-validate so a patch cannot install an out-of-range value.
  return validateSettings(merged, defaultDownloadPath)
}

export class SettingsStore {
  private current: AppSettings
  private readonly filePath: string
  private listeners = new Set<(settings: AppSettings) => void>()
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    filePath: string,
    initial: AppSettings,
    private readonly defaultDownloadPath: string
  ) {
    this.filePath = filePath
    this.current = initial
  }

  static async open(configDir: string, defaultDownloadPath: string): Promise<SettingsStore> {
    const filePath = join(configDir, 'settings.json')
    const raw = await readJson<unknown>(filePath)
    const settings = validateSettings(raw, defaultDownloadPath)
    const store = new SettingsStore(filePath, settings, defaultDownloadPath)
    // Write back immediately when the file was missing or needed correcting, so
    // the on-disk shape always matches what the app is actually using.
    if (raw === null || JSON.stringify(raw) !== JSON.stringify(settings)) {
      await store.flush()
    }
    return store
  }

  get(): AppSettings {
    return this.current
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    const next = applyPatch(this.current, patch, this.defaultDownloadPath)
    const changed = JSON.stringify(next) !== JSON.stringify(this.current)
    this.current = next
    if (changed) {
      for (const listener of this.listeners) {
        try {
          listener(next)
        } catch {
          // Never let a listener break a settings write.
        }
      }
      await this.flush()
    }
    return next
  }

  /** Serialises writes so two rapid updates cannot interleave. */
  async flush(): Promise<void> {
    const snapshot = this.current
    this.writeQueue = this.writeQueue
      .then(() => writeJsonAtomic(this.filePath, snapshot))
      .catch(() => {
        /* surfaced by the caller's own logging */
      })
    return this.writeQueue
  }

  get path(): string {
    return this.filePath
  }
}
