/**
 * Rebuilds a directory tree from a flat file list.
 *
 * The metadata screen gets its tree from the main process, but the details Files
 * tab only has the flat list from the engine, so it needs the same shape built
 * client-side.
 */

import type { FileTreeNode, TorrentFileInfo } from '@shared/types.js'

export function buildTreeFromFiles(files: TorrentFileInfo[], rootName: string): FileTreeNode {
  const root: FileTreeNode = {
    name: rootName,
    path: '',
    isDirectory: true,
    length: 0,
    children: []
  }

  for (const file of files) {
    const segments = file.path.split('/').filter((s) => s.length > 0)
    let cursor = root
    for (let depth = 0; depth < segments.length; depth += 1) {
      const segment = segments[depth]!
      const isLeaf = depth === segments.length - 1
      const childPath = segments.slice(0, depth + 1).join('/')

      if (isLeaf) {
        cursor.children!.push({
          name: segment,
          path: childPath,
          isDirectory: false,
          length: file.length,
          fileIndex: file.index
        })
      } else {
        let next = cursor.children!.find((c) => c.isDirectory && c.name === segment)
        if (!next) {
          next = { name: segment, path: childPath, isDirectory: true, length: 0, children: [] }
          cursor.children!.push(next)
        }
        cursor = next
      }
    }
  }

  const finalise = (node: FileTreeNode): number => {
    if (!node.isDirectory) return node.length
    let total = 0
    for (const child of node.children ?? []) total += finalise(child)
    node.length = total
    node.children?.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return total
  }
  finalise(root)

  return root
}
