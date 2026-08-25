/**
 * Byte accounting across piece boundaries.
 *
 * A torrent is a single concatenated byte stream cut into fixed-size pieces, so
 * a file's first and last piece are usually shared with its neighbours. Working
 * out how many of a file's bytes are actually verified means intersecting the
 * file's byte range with each piece's byte range.
 *
 * We do this ourselves rather than using WebTorrent's `File.downloaded` because
 * that getter has an off-by-one-piece bug: it computes
 *
 *     irrelevantLastPieceBytes = pieceLength - (offset + length) % pieceLength
 *
 * and for a file ending exactly on a piece boundary the remainder is 0, so it
 * subtracts a whole piece that is entirely part of the file. A piece-aligned
 * file therefore reports one piece short and its progress never reaches 100%.
 * (Verified against webtorrent 3.0.21, lib/file.js.)
 *
 * Pure module: no Node, no DOM.
 */

export interface PieceGeometry {
  /** Byte offset of the file within the torrent's concatenated stream. */
  fileOffset: number
  fileLength: number
  pieceLength: number
  /** Length of the final piece of the torrent, which is usually shorter. */
  lastPieceLength: number
  /** Total number of pieces in the torrent. */
  pieceCount: number
}

/** Byte range of a piece within the torrent stream, end-exclusive. */
export function pieceByteRange(
  index: number,
  pieceLength: number,
  lastPieceLength: number,
  pieceCount: number
): { start: number; end: number } {
  const start = index * pieceLength
  const length = index === pieceCount - 1 ? lastPieceLength : pieceLength
  return { start, end: start + length }
}

/** Inclusive index of the first and last piece a file touches. */
export function filePieceRange(
  fileOffset: number,
  fileLength: number,
  pieceLength: number
): { startPiece: number; endPiece: number } {
  if (fileLength <= 0) {
    const p = Math.floor(fileOffset / pieceLength)
    return { startPiece: p, endPiece: p }
  }
  return {
    startPiece: Math.floor(fileOffset / pieceLength),
    endPiece: Math.floor((fileOffset + fileLength - 1) / pieceLength)
  }
}

/**
 * Bytes of this file that live in verified pieces.
 *
 * Only counts fully verified pieces, which keeps the number monotonic and means
 * "downloaded" always refers to data we have actually hash-checked, never to
 * blocks still in flight.
 */
export function fileVerifiedBytes(
  geometry: PieceGeometry,
  hasPiece: (index: number) => boolean
): number {
  const { fileOffset, fileLength, pieceLength, lastPieceLength, pieceCount } = geometry
  if (fileLength <= 0 || pieceLength <= 0 || pieceCount <= 0) return 0

  const fileStart = fileOffset
  const fileEnd = fileOffset + fileLength
  const { startPiece, endPiece } = filePieceRange(fileOffset, fileLength, pieceLength)

  let verified = 0
  for (let index = startPiece; index <= endPiece && index < pieceCount; index += 1) {
    if (!hasPiece(index)) continue
    const { start, end } = pieceByteRange(index, pieceLength, lastPieceLength, pieceCount)
    // Intersection of the piece's byte range with the file's byte range.
    const overlap = Math.min(end, fileEnd) - Math.max(start, fileStart)
    if (overlap > 0) verified += overlap
  }

  return Math.min(verified, fileLength)
}

/**
 * The set of piece indices needed to complete a set of selected files.
 *
 * A piece straddling a selected and a skipped file is still required, because
 * the selected file needs those bytes -- so it belongs in this set.
 */
export function selectedPieceIndices(
  files: ReadonlyArray<{ offset: number; length: number; selected: boolean }>,
  pieceLength: number
): Set<number> {
  const needed = new Set<number>()
  for (const file of files) {
    if (!file.selected || file.length <= 0) continue
    const { startPiece, endPiece } = filePieceRange(file.offset, file.length, pieceLength)
    for (let i = startPiece; i <= endPiece; i += 1) needed.add(i)
  }
  return needed
}
