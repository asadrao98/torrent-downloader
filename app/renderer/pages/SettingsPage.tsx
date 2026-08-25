/** Settings, grouped the way macOS System Settings groups things. */

import { useEffect, useState } from 'react'
import type { AppSettings, ThemePreference } from '@shared/types.js'
import { UNLIMITED } from '@shared/constants.js'
import { formatLimit, parseLimit, prettyPath } from '@shared/format.js'
import { Button, SettingRow, Spinner, Switch, Tabs } from '../components/Primitives.js'
import { useAppActions, useAppState } from '../state/store.js'

type SectionId = 'general' | 'downloads' | 'bandwidth' | 'seeding' | 'appearance' | 'advanced'

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'bandwidth', label: 'Bandwidth' },
  { id: 'seeding', label: 'Seeding' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'advanced', label: 'Advanced' }
]

export function SettingsPage() {
  const { settings, info } = useAppState()
  const { toast } = useAppActions()
  const [section, setSection] = useState<SectionId>('general')

  if (!settings) {
    return (
      <div className="splash">
        <Spinner />
        <span>Loading settings…</span>
      </div>
    )
  }

  const patch = async (next: Parameters<typeof window.torrentApi.updateSettings>[0]) => {
    try {
      await window.torrentApi.updateSettings(next)
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Could not save that setting',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const homeDir = info?.homeDir ?? ''

  return (
    <div className="content">
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="section">
          <Tabs items={SECTIONS} value={section} onChange={setSection} />
        </div>

        {section === 'general' ? (
          <div className="card card--pad">
            <SettingRow
              name="Launch at login"
              hint={
                info && info.platform === 'darwin'
                  ? 'Opens Torrent Downloader when you log in. Only takes effect for the installed app, not a development build.'
                  : undefined
              }
            >
              <Switch
                label="Launch at login"
                checked={settings.general.launchAtLogin}
                onChange={(v) => void patch({ general: { launchAtLogin: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Start downloads automatically"
              hint="When off, a newly added torrent waits paused until you start it."
            >
              <Switch
                label="Start downloads automatically"
                checked={settings.general.startDownloadsAutomatically}
                onChange={(v) => void patch({ general: { startDownloadsAutomatically: v } })}
              />
            </SettingRow>

            <SettingRow name="Show notifications">
              <Switch
                label="Show notifications"
                checked={settings.general.showNotifications}
                onChange={(v) => void patch({ general: { showNotifications: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Confirm torrent removal"
              hint="Deleting downloaded files always asks, regardless of this setting."
            >
              <Switch
                label="Confirm torrent removal"
                checked={settings.general.confirmTorrentRemoval}
                onChange={(v) => void patch({ general: { confirmTorrentRemoval: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Show in menu bar"
              hint="Keeps a menu bar item with transfer totals. With this on, closing the window leaves the session running."
            >
              <Switch
                label="Show in menu bar"
                checked={settings.general.showInMenuBar}
                onChange={(v) => void patch({ general: { showInMenuBar: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Confirm magnet links from other apps"
              hint="Asks before adding a magnet link opened from a browser. Turning this off lets other apps start downloads without asking."
            >
              <Switch
                label="Confirm magnet links from other apps"
                checked={settings.general.confirmExternalMagnets}
                onChange={(v) => void patch({ general: { confirmExternalMagnets: v } })}
              />
            </SettingRow>
          </div>
        ) : null}

        {section === 'downloads' ? (
          <div className="card card--pad">
            <SettingRow name="Default download folder" wide>
              <div className="input truncate" title={settings.downloads.defaultPath}>
                {prettyPath(settings.downloads.defaultPath, homeDir)}
              </div>
              <Button
                onClick={async () => {
                  const result = await window.torrentApi.chooseFolder(
                    settings.downloads.defaultPath
                  )
                  if (!result.canceled && result.path) {
                    await patch({ downloads: { defaultPath: result.path } })
                  }
                }}
              >
                Change
              </Button>
            </SettingRow>

            <SettingRow
              name="Ask for download location"
              hint="Prompts for a folder each time instead of using the default."
            >
              <Switch
                label="Ask for download location"
                checked={settings.downloads.askForLocation}
                onChange={(v) => void patch({ downloads: { askForLocation: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Maximum active downloads"
              hint="Torrents beyond this limit wait in the queue. Seeding torrents do not use a slot."
            >
              <NumberField
                value={settings.downloads.maxActiveTorrents}
                min={1}
                max={100}
                onCommit={(v) => void patch({ downloads: { maxActiveTorrents: v } })}
              />
            </SettingRow>
          </div>
        ) : null}

        {section === 'bandwidth' ? (
          <div className="card card--pad">
            <SettingRow
              name="Download limit"
              hint="Type a rate such as 500 KB/s or 2 MB/s, or leave empty for unlimited."
            >
              <LimitField
                value={settings.bandwidth.downloadLimit}
                onCommit={(v) => void patch({ bandwidth: { downloadLimit: v } })}
              />
            </SettingRow>

            <SettingRow name="Upload limit">
              <LimitField
                value={settings.bandwidth.uploadLimit}
                onCommit={(v) => void patch({ bandwidth: { uploadLimit: v } })}
              />
            </SettingRow>

            <SettingRow name="Maximum connections">
              <NumberField
                value={settings.bandwidth.maxConnections}
                min={4}
                max={2000}
                onCommit={(v) => void patch({ bandwidth: { maxConnections: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Listen port"
              hint="0 lets the system choose. Changing this needs a restart of the app."
            >
              <NumberField
                value={settings.bandwidth.listenPort}
                min={0}
                max={65535}
                onCommit={(v) => void patch({ bandwidth: { listenPort: v } })}
              />
            </SettingRow>

            <SettingRow
              name="Peer discovery"
              hint="DHT, peer exchange and local discovery all help find peers. Changes need a restart."
            >
              <div className="stack">
                <label className="row">
                  <Switch
                    label="DHT"
                    checked={settings.bandwidth.enableDht}
                    onChange={(v) => void patch({ bandwidth: { enableDht: v } })}
                  />
                  <span>DHT</span>
                </label>
                <label className="row">
                  <Switch
                    label="Peer exchange"
                    checked={settings.bandwidth.enablePex}
                    onChange={(v) => void patch({ bandwidth: { enablePex: v } })}
                  />
                  <span>Peer exchange (PEX)</span>
                </label>
                <label className="row">
                  <Switch
                    label="Local peer discovery"
                    checked={settings.bandwidth.enableLsd}
                    onChange={(v) => void patch({ bandwidth: { enableLsd: v } })}
                  />
                  <span>Local peer discovery</span>
                </label>
              </div>
            </SettingRow>

            <SettingRow
              name="Transport"
              hint={
                info?.utpSupported
                  ? 'µTP is available in this build. Changes need a restart.'
                  : 'µTP is not available in this build, so connections use TCP only.'
              }
            >
              <div className="stack">
                <label className="row">
                  <Switch
                    label="µTP"
                    checked={settings.bandwidth.enableUtp}
                    disabled={!info?.utpSupported}
                    onChange={(v) => void patch({ bandwidth: { enableUtp: v } })}
                  />
                  <span>µTP</span>
                </label>
                <label className="row">
                  <Switch
                    label="Port mapping"
                    checked={settings.bandwidth.enableUpnp}
                    onChange={(v) => void patch({ bandwidth: { enableUpnp: v } })}
                  />
                  <span>Automatic port mapping (UPnP / NAT-PMP)</span>
                </label>
              </div>
            </SettingRow>

            <SettingRow
              name="Protocol encryption"
              hint="Obscures the BitTorrent handshake. Requiring it can reduce the number of reachable peers. Changes need a restart."
            >
              <select
                className="select"
                value={String(settings.bandwidth.encryptionLevel)}
                onChange={(event) =>
                  void patch({
                    bandwidth: { encryptionLevel: Number(event.target.value) as 0 | 1 | 2 }
                  })
                }
              >
                <option value="0">Disabled</option>
                <option value="1">Prefer encryption</option>
                <option value="2">Require encryption</option>
              </select>
            </SettingRow>
          </div>
        ) : null}

        {section === 'seeding' ? (
          <SeedingSection settings={settings} onPatch={patch} />
        ) : null}

        {section === 'appearance' ? (
          <div className="card card--pad">
            <SettingRow name="Theme">
              <select
                className="select"
                value={settings.appearance.theme}
                onChange={(event) =>
                  void window.torrentApi.setTheme(event.target.value as ThemePreference)
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </SettingRow>
          </div>
        ) : null}

        {section === 'advanced' ? (
          <div className="card card--pad">
            <SettingRow
              name="Verbose logging"
              hint="Records engine-level detail in the log file. Useful when diagnosing a problem, noisy otherwise."
            >
              <Switch
                label="Verbose logging"
                checked={settings.advanced.verboseLogging}
                onChange={(v) => void patch({ advanced: { verboseLogging: v } })}
              />
            </SettingRow>

            <SettingRow name="Logs" hint={info?.logPath}>
              <Button onClick={() => void window.torrentApi.openLogsFolder()}>
                Open Logs Folder
              </Button>
            </SettingRow>

            {info ? (
              <SettingRow name="About">
                <div className="tiny" style={{ textAlign: 'right', lineHeight: 1.7 }}>
                  <div>Version {info.version}</div>
                  <div>Engine: WebTorrent {info.engineVersion}</div>
                  <div>µTP: {info.utpSupported ? 'available' : 'unavailable'}</div>
                  <div>
                    Electron {info.electronVersion} · Node {info.nodeVersion}
                  </div>
                  <div>
                    {info.platform} {info.arch}
                  </div>
                </div>
              </SettingRow>
            ) : null}

            <SettingRow
              name="Privacy"
              hint="This app has no accounts, no cloud sync, no analytics and no telemetry. Magnet links and torrent metadata stay on this Mac, apart from the peer and tracker traffic BitTorrent itself requires."
            >
              <span />
            </SettingRow>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SeedingSection({
  settings,
  onPatch
}: {
  settings: AppSettings
  onPatch: (next: Parameters<typeof window.torrentApi.updateSettings>[0]) => Promise<void>
}) {
  const goal = settings.seeding
  return (
    <div className="card card--pad">
      <SettingRow
        name="Seed until"
        hint="What to do once a download finishes. Seeding gives back to the swarm you took from."
      >
        <select
          className="select"
          value={goal.kind}
          onChange={(event) =>
            void onPatch({ seeding: { kind: event.target.value as typeof goal.kind } })
          }
        >
          <option value="ratio">A share ratio is reached</option>
          <option value="time">A time limit is reached</option>
          <option value="forever">Indefinitely</option>
        </select>
      </SettingRow>

      {goal.kind === 'ratio' ? (
        <SettingRow name="Seed ratio" hint="1.0 means uploading as much as you downloaded.">
          <NumberField
            value={goal.ratio}
            min={0}
            max={10000}
            step={0.1}
            onCommit={(v) => void onPatch({ seeding: { ratio: v } })}
          />
        </SettingRow>
      ) : null}

      {goal.kind === 'time' ? (
        <SettingRow name="Seed time (minutes)">
          <NumberField
            value={goal.minutes}
            min={0}
            max={525600}
            onCommit={(v) => void onPatch({ seeding: { minutes: v } })}
          />
        </SettingRow>
      ) : null}
    </div>
  )
}

/** A numeric field that only commits a valid value, and reverts otherwise. */
function NumberField({
  value,
  min,
  max,
  step,
  onCommit
}: {
  value: number
  min: number
  max: number
  step?: number
  onCommit: (next: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setText(String(value))
    setInvalid(false)
  }, [value])

  const commit = () => {
    const parsed = Number(text)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setInvalid(true)
      setText(String(value))
      window.setTimeout(() => setInvalid(false), 900)
      return
    }
    const rounded = step && step < 1 ? Math.round(parsed * 100) / 100 : Math.round(parsed)
    if (rounded !== value) onCommit(rounded)
  }

  return (
    <input
      className={`input${invalid ? ' input--invalid' : ''}`}
      style={{ width: 110, textAlign: 'right' }}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step ?? 1}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

/** A bandwidth field accepting `500 KB/s`, `2MB`, `unlimited`, or empty. */
function LimitField({
  value,
  onCommit
}: {
  value: number
  onCommit: (next: number) => void
}) {
  const [text, setText] = useState(value === UNLIMITED ? '' : formatLimit(value))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setText(value === UNLIMITED ? '' : formatLimit(value))
    setInvalid(false)
  }, [value])

  const commit = () => {
    const parsed = parseLimit(text)
    if (parsed === null) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <input
      className={`input${invalid ? ' input--invalid' : ''}`}
      style={{ width: 160, textAlign: 'right' }}
      placeholder="Unlimited"
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        setInvalid(false)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      aria-invalid={invalid}
    />
  )
}
