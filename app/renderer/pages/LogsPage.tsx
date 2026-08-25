/** Developer/logging screen. Full detail lives here, never in a user-facing error. */

import { useEffect, useMemo, useState } from 'react'
import type { LogLevel } from '@shared/types.js'
import { Button, EmptyState, Tabs } from '../components/Primitives.js'
import { IconLogs } from '../components/Icons.js'
import { useAppActions, useAppState } from '../state/store.js'

const LEVELS: ReadonlyArray<{ id: LogLevel | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' }
]

export function LogsPage() {
  const { logs, info } = useAppState()
  const { refreshLogs } = useAppActions()
  const [level, setLevel] = useState<LogLevel | 'all'>('all')

  useEffect(() => {
    void refreshLogs()
  }, [refreshLogs])

  const visible = useMemo(
    () => (level === 'all' ? logs : logs.filter((entry) => entry.level === level)),
    [logs, level]
  )

  return (
    <div className="content">
      <div className="row row--between section">
        <Tabs items={LEVELS} value={level} onChange={setLevel} />
        <div className="row">
          <Button onClick={() => void refreshLogs()}>Reload</Button>
          <Button onClick={() => void window.torrentApi.openLogsFolder()}>Open Logs Folder</Button>
        </div>
      </div>

      {info ? (
        <p className="tiny section">
          Written to {info.logPath}. Passwords and credentials are never logged, and peer addresses
          are kept out of the file unless verbose logging is switched on.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          glyph={<IconLogs size={24} />}
          title="Nothing logged yet"
          body="Engine activity, warnings and errors will appear here as they happen."
        />
      ) : (
        <div className="logs">
          {visible.map((entry, index) => (
            <div className="log__line" key={`${entry.time}-${index}`}>
              <span className="log__time">
                {new Date(entry.time).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              <span className={`log__level--${entry.level}`}>{entry.level.toUpperCase()}</span>
              <span>
                <span className="muted">[{entry.scope}]</span> {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
