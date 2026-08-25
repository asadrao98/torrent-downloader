/**
 * File selection tree.
 *
 * Used by the metadata screen (before download) and the details Files tab
 * (during download). Folder checkboxes are tri-state and derived from their
 * descendants, so a partially selected folder reads as partial rather than
 * silently rounding to on or off.
 */

import { useMemo, useState } from 'react'
import type { FilePriority, FileTreeNode, TorrentFileInfo } from '@shared/types.js'
import { formatBytes, formatPercent } from '@shared/format.js'
import { Checkbox } from './Primitives.js'
import { IconChevron, IconFile, IconFolder } from './Icons.js'

export type PriorityMap = Record<number, FilePriority>

/** Collects every file index beneath a node. */
function collectIndices(node: FileTreeNode, into: number[] = []): number[] {
  if (!node.isDirectory) {
    if (node.fileIndex !== undefined) into.push(node.fileIndex)
    return into
  }
  for (const child of node.children ?? []) collectIndices(child, into)
  return into
}

function checkStateFor(
  node: FileTreeNode,
  priorities: PriorityMap
): 'checked' | 'unchecked' | 'partial' {
  const indices = collectIndices(node)
  if (indices.length === 0) return 'unchecked'
  let selected = 0
  for (const index of indices) {
    if ((priorities[index] ?? 'normal') !== 'skip') selected += 1
  }
  if (selected === 0) return 'unchecked'
  if (selected === indices.length) return 'checked'
  return 'partial'
}

interface RowProps {
  node: FileTreeNode
  depth: number
  priorities: PriorityMap
  onToggle: (indices: number[], select: boolean) => void
  onPriority?: (index: number, priority: FilePriority) => void
  /** Live per-file progress, keyed by file index. Absent before download starts. */
  progressByIndex?: Map<number, TorrentFileInfo>
  showPriority: boolean
  expanded: Set<string>
  onExpandToggle: (path: string) => void
}

function TreeRow({
  node,
  depth,
  priorities,
  onToggle,
  onPriority,
  progressByIndex,
  showPriority,
  expanded,
  onExpandToggle
}: RowProps) {
  const state = checkStateFor(node, priorities)
  const isOpen = expanded.has(node.path)
  const indices = useMemo(() => collectIndices(node), [node])
  const info = node.fileIndex !== undefined ? progressByIndex?.get(node.fileIndex) : undefined

  return (
    <>
      <div
        className="tree__row"
        style={{ paddingLeft: 12 + depth * 17 }}
        role={node.isDirectory ? 'group' : 'treeitem'}
      >
        {node.isDirectory ? (
          <button
            type="button"
            className={`tree__twisty${isOpen ? ' tree__twisty--open' : ''}`}
            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={isOpen}
            onClick={() => onExpandToggle(node.path)}
            style={{ background: 'none', border: 'none', padding: 0 }}
          >
            <IconChevron size={12} />
          </button>
        ) : (
          <span className="tree__twisty" />
        )}

        <Checkbox
          state={state}
          label={`${node.isDirectory ? 'Folder' : 'File'} ${node.name}`}
          onChange={() => onToggle(indices, state !== 'checked')}
        />

        <span className="sidebar__icon" aria-hidden="true">
          {node.isDirectory ? <IconFolder size={13} /> : <IconFile size={13} />}
        </span>

        <span className="tree__name" title={node.path || node.name}>
          {node.name}
          {info?.sanitized ? (
            <span
              className="sanitized-flag"
              style={{ marginLeft: 6 }}
              title={`Renamed for safety. The torrent asked for: ${info.originalPath}`}
            >
              renamed
            </span>
          ) : null}
        </span>

        {info && info.length > 0 && info.downloaded > 0 ? (
          <span className="tree__size">{formatPercent(info.progress, 0)}</span>
        ) : null}

        <span className="tree__size">{formatBytes(node.length)}</span>

        {showPriority && !node.isDirectory && node.fileIndex !== undefined && onPriority ? (
          <select
            className="tree__priority"
            aria-label={`Priority for ${node.name}`}
            value={priorities[node.fileIndex] ?? 'normal'}
            onChange={(event) =>
              onPriority(node.fileIndex!, event.target.value as FilePriority)
            }
          >
            <option value="skip">Skip</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        ) : null}
      </div>

      {node.isDirectory && isOpen
        ? (node.children ?? []).map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              priorities={priorities}
              onToggle={onToggle}
              onPriority={onPriority}
              progressByIndex={progressByIndex}
              showPriority={showPriority}
              expanded={expanded}
              onExpandToggle={onExpandToggle}
            />
          ))
        : null}
    </>
  )
}

export function FileTree({
  tree,
  priorities,
  onChange,
  files,
  showPriority = true
}: {
  tree: FileTreeNode
  priorities: PriorityMap
  onChange: (next: PriorityMap) => void
  files?: TorrentFileInfo[]
  showPriority?: boolean
}) {
  // Top level starts open; deeper folders stay collapsed so a torrent with
  // thousands of files does not render thousands of rows on first paint.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>([''])
    for (const child of tree.children ?? []) {
      if (child.isDirectory) initial.add(child.path)
    }
    return initial
  })

  const progressByIndex = useMemo(() => {
    const map = new Map<number, TorrentFileInfo>()
    for (const file of files ?? []) map.set(file.index, file)
    return map
  }, [files])

  const onExpandToggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const onToggle = (indices: number[], select: boolean) => {
    const next = { ...priorities }
    for (const index of indices) {
      next[index] = select ? 'normal' : 'skip'
    }
    onChange(next)
  }

  const onPriority = (index: number, priority: FilePriority) => {
    onChange({ ...priorities, [index]: priority })
  }

  return (
    <div className="tree" role="tree" aria-label="Torrent files">
      {(tree.children ?? []).map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={0}
          priorities={priorities}
          onToggle={onToggle}
          onPriority={onPriority}
          progressByIndex={progressByIndex}
          showPriority={showPriority}
          expanded={expanded}
          onExpandToggle={onExpandToggle}
        />
      ))}
    </div>
  )
}

/** Counts and totals for the "N of M files, X selected" summary line. */
export function selectionSummary(
  files: TorrentFileInfo[],
  priorities: PriorityMap
): { selectedCount: number; selectedBytes: number; totalBytes: number } {
  let selectedCount = 0
  let selectedBytes = 0
  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.length
    if ((priorities[file.index] ?? 'normal') !== 'skip') {
      selectedCount += 1
      selectedBytes += file.length
    }
  }
  return { selectedCount, selectedBytes, totalBytes }
}
