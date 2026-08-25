import { describe, it, expect } from 'vitest'
import {
  fileVerifiedBytes,
  filePieceRange,
  pieceByteRange,
  selectedPieceIndices
} from '@shared/piece-math.js'

/** Helper: a bitfield where every piece is present. */
const allPresent = () => true
const nonePresent = () => false

describe('pieceByteRange', () => {
  it('gives the byte range of a middle piece', () => {
    expect(pieceByteRange(2, 16384, 1000, 10)).toEqual({ start: 32768, end: 49152 })
  })

  it('uses the short length for the final piece', () => {
    expect(pieceByteRange(9, 16384, 1000, 10)).toEqual({ start: 147456, end: 148456 })
  })
})

describe('filePieceRange', () => {
  it('handles a file starting at zero', () => {
    expect(filePieceRange(0, 163840, 16384)).toEqual({ startPiece: 0, endPiece: 9 })
  })

  it('handles a file starting mid-piece', () => {
    expect(filePieceRange(1000, 20000, 16384)).toEqual({ startPiece: 0, endPiece: 1 })
  })

  it('handles a zero-length file without producing an inverted range', () => {
    const r = filePieceRange(32768, 0, 16384)
    expect(r.endPiece).toBeGreaterThanOrEqual(r.startPiece)
  })
})

describe('fileVerifiedBytes', () => {
  // This is the exact case WebTorrent's own File.downloaded gets wrong: a file
  // whose end lands precisely on a piece boundary must report its full length,
  // not one piece less.
  it('reports the full length for a piece-aligned file', () => {
    const bytes = fileVerifiedBytes(
      { fileOffset: 0, fileLength: 163840, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 20 },
      allPresent
    )
    expect(bytes).toBe(163840)
  })

  it('reports the full length for a piece-aligned file that is not first', () => {
    const bytes = fileVerifiedBytes(
      { fileOffset: 163840, fileLength: 163840, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 20 },
      allPresent
    )
    expect(bytes).toBe(163840)
  })

  it('reports the full length for an unaligned file sharing pieces on both sides', () => {
    const bytes = fileVerifiedBytes(
      { fileOffset: 1000, fileLength: 20000, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 20 },
      allPresent
    )
    expect(bytes).toBe(20000)
  })

  it('handles a file smaller than one piece, entirely inside it', () => {
    const bytes = fileVerifiedBytes(
      { fileOffset: 100, fileLength: 500, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 4 },
      allPresent
    )
    expect(bytes).toBe(500)
  })

  it('handles the torrent-final file ending on the short last piece', () => {
    const bytes = fileVerifiedBytes(
      { fileOffset: 32768, fileLength: 1000, pieceLength: 16384, lastPieceLength: 1000, pieceCount: 3 },
      allPresent
    )
    expect(bytes).toBe(1000)
  })

  it('returns zero when nothing is verified', () => {
    expect(
      fileVerifiedBytes(
        { fileOffset: 0, fileLength: 163840, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 20 },
        nonePresent
      )
    ).toBe(0)
  })

  it('counts only the verified pieces of a partially complete file', () => {
    // Pieces 0-4 present, 5-9 missing, for a file spanning 0-9.
    const bytes = fileVerifiedBytes(
      { fileOffset: 0, fileLength: 163840, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 20 },
      (i) => i < 5
    )
    expect(bytes).toBe(5 * 16384)
  })

  it('attributes a shared boundary piece to each file proportionally', () => {
    const pieceLength = 16384
    const geometryA = { fileOffset: 0, fileLength: 20000, pieceLength, lastPieceLength: pieceLength, pieceCount: 4 }
    const geometryB = { fileOffset: 20000, fileLength: 10000, pieceLength, lastPieceLength: pieceLength, pieceCount: 4 }
    // Piece 1 (16384..32768) is shared by both files.
    const aBytes = fileVerifiedBytes(geometryA, allPresent)
    const bBytes = fileVerifiedBytes(geometryB, allPresent)
    expect(aBytes).toBe(20000)
    expect(bBytes).toBe(10000)
    // Neither file over-claims the shared piece.
    expect(aBytes + bBytes).toBe(30000)
  })

  it('never exceeds the file length', () => {
    const bytes = fileVerifiedBytes(
      { fileOffset: 0, fileLength: 10, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 1 },
      allPresent
    )
    expect(bytes).toBe(10)
  })

  it('handles degenerate geometry without throwing', () => {
    expect(
      fileVerifiedBytes(
        { fileOffset: 0, fileLength: 0, pieceLength: 16384, lastPieceLength: 16384, pieceCount: 1 },
        allPresent
      )
    ).toBe(0)
    expect(
      fileVerifiedBytes(
        { fileOffset: 0, fileLength: 100, pieceLength: 0, lastPieceLength: 0, pieceCount: 0 },
        allPresent
      )
    ).toBe(0)
  })
})

describe('selectedPieceIndices', () => {
  const pieceLength = 16384

  it('includes only the pieces of selected files', () => {
    const set = selectedPieceIndices(
      [
        { offset: 0, length: 163840, selected: true },
        { offset: 163840, length: 163840, selected: false }
      ],
      pieceLength
    )
    expect(set.size).toBe(10)
    expect(set.has(0)).toBe(true)
    expect(set.has(9)).toBe(true)
    expect(set.has(10)).toBe(false)
  })

  // A piece straddling a wanted and an unwanted file is still needed, because
  // the wanted file's bytes live in it.
  it('includes a boundary piece shared with a skipped file', () => {
    const set = selectedPieceIndices(
      [
        { offset: 0, length: 20000, selected: true },
        { offset: 20000, length: 20000, selected: false }
      ],
      pieceLength
    )
    expect(set.has(1)).toBe(true)
  })

  it('is empty when nothing is selected', () => {
    const set = selectedPieceIndices([{ offset: 0, length: 1000, selected: false }], pieceLength)
    expect(set.size).toBe(0)
  })

  it('ignores zero-length files', () => {
    const set = selectedPieceIndices([{ offset: 0, length: 0, selected: true }], pieceLength)
    expect(set.size).toBe(0)
  })
})
