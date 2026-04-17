// Hybrid TLV parser: marker scan (pass 1), bare-name tail inference (pass 2, T12),
// and name-first fallback (pass 3, T11). Pass numbers match execution order; the
// T-numbers reflect the implementation order in which each pass was added.
// Evidence: kmp-pipeline.mjs:630-852.

import {
  TYPE_FLOAT, TYPE_COLOR, TYPE_INT, TYPE_BOOL, TYPE_TEXSLOT,
} from './mtl.schema.js'
import {
  isPrintable, isValidColorMarker, isValidBoolMarker, isValidTexslotMarker,
  isValidFloatMarker, isValidIntMarker,
  cleanParamName, rgbToHex, readF32LE, readU32LE, readAscii, fitsValue,
} from '../binary-tools/binary-tools.js'

/**
 * Boolean parameter names the Pass-1 marker scan is likely to miss because the
 * `TYPE_BOOL` byte (`0x25` / `%`) overlaps with printable ASCII inside the
 * preceding name. Pass 3 (name-first fallback) matches these needles directly.
 * Evidence: kmp-pipeline.mjs:802-807.
 *
 * @type {readonly string[]}
 */
export const KNOWN_BOOL_PARAM_NAMES = Object.freeze([
  'transparency',
  'contour width is in pixels',
  'outline contour',
  'material contour',
  'part contour',
  'interior edge contour',
  'environment shadows',
  'light source shadows',
  'contour color',
  'shadow color',
])

// Pre-encode needles once at module load and group by first byte for O(1)
// dispatch during the Pass-1 byte walk. All names are ASCII, so
// TextEncoder output matches the raw byte view of the param section.
const NEEDLE_ENCODER = new TextEncoder()
const NEEDLES_BY_FIRST_BYTE = (() => {
  const table = new Array(256)
  for (const name of KNOWN_BOOL_PARAM_NAMES) {
    const bytes = NEEDLE_ENCODER.encode(name)
    const first = bytes[0]
    if (!table[first]) table[first] = []
    table[first].push({ name, bytes, length: bytes.length })
  }
  return table
})()

/**
 * Decode the TLV-encoded parameter section of an MTL buffer into a list of
 * {@link RawParam} records sorted by byte offset. Runs three cooperating passes
 * in execution order:
 *   1. **Pass 1** — single O(n) byte walk collecting TLV marker candidates
 *      (float / int / color / bool / texslot) and known-name hits.
 *   2. **Pass 2** — bare-name tail inference: a printable run after the last
 *      parsed value is recorded as `type='bool_inferred'`, `bool=false`
 *      (KeyShot omits the marker byte for trailing false booleans).
 *   3. **Pass 3** — name-first fallback for {@link KNOWN_BOOL_PARAM_NAMES}
 *      whose marker byte overlaps printable ASCII.
 *
 * @param {Uint8Array} buf Full MTL buffer.
 * @param {DataView} view DataView over the same buffer (for LE reads).
 * @param {number} start Inclusive byte offset of the param section.
 * @param {number} end Exclusive byte offset of the param section.
 * @returns {import('../../index.d.ts').RawParam[]}
 */
export function parseParamSection(buf, view, start, end) {
  const results = new Map()

  const { markers, nameHits } = scanMarkersAndNames(buf, view, start, end)

  let cursor = start
  let valueEnd = start

  for (const marker of markers) {
    if (marker.pos < valueEnd) continue
    if (results.has(marker.pos)) continue

    const name = readName(buf, cursor, marker.pos)
    const parsed = readValue(buf, view, marker, end, name)
    if (parsed === null) continue

    const record = { ...parsed }
    delete record.valueEnd
    results.set(marker.pos, record)
    cursor = parsed.valueEnd
    valueEnd = parsed.valueEnd
  }

  // Pass 2: bare-name tail inference — KeyShot omits the marker byte for
  // trailing false booleans, so a printable run after the last parsed value
  // is recorded as type='bool_inferred', value=0, bool=false.
  // Evidence: kmp-pipeline.mjs:769-796.
  //
  // The length gate accepts a minimum of 3 characters rather than > 3 so
  // well-known 3-char PBR names (`ior`, `map`, `fog`, etc.) are not dropped.
  // Historical behaviour rejected 3-char tails as likely noise, but KeyShot
  // 14 emits a literal `ior` tail at the end of some lux_plastic_simple
  // param sections (e.g. DEFCAD STANDARD RED.mtl at 0x48be8 — `ior/TG` in
  // raw bytes → `ior` after `/;:` truncation). Lowering the gate claims
  // those bytes in coverage and stops the warning loop from flagging them
  // as unmapped.
  if (cursor < end) {
    let trailStart = cursor
    while (trailStart < end && !isPrintable(buf[trailStart])) trailStart++
    if (trailStart < end) {
      let trailEnd = trailStart
      while (trailEnd < end && isPrintable(buf[trailEnd])) trailEnd++
      if (trailEnd > trailStart) {
        const raw = readAscii(buf, trailStart, trailEnd)
        const bareName = raw
          .replace(/^[^a-zA-Z_]+/, '')
          .replace(/[/;:].+$/, '')
        if (bareName.length >= 3) {
          const claimStart = cursor
          const rawLen = end - claimStart
          results.set(claimStart, {
            name: bareName, type: 'bool_inferred', subId: 0, offset: claimStart,
            rawLength: rawLen, value: 0, bool: false,
            note: 'No type marker found — inferred as bool false from bare name at end of param section',
          })
        }
      }
    }
  }

  // Pass 3: name-first fallback — process name hits collected during the
  // Pass-1 byte walk. Previously this pass built a 256 MB Latin-1 JS string
  // and ran 10 separate indexOf scans across it (~2.5 GB of work per call
  // for a large section). Now the hits come from the single byte loop in
  // scanMarkersAndNames, so the cost is amortised O(1) per byte instead of
  // O(n·k) plus a full decode.
  for (const hit of nameHits) {
    const absOffset = hit.namePos + hit.length
    if (!fitsValue(absOffset, 6, end)) continue
    if (results.has(absOffset)) continue
    const markerByte = buf[absOffset]
    const subId = buf[absOffset + 1]
    if (markerByte === TYPE_BOOL) {
      const v = readU32LE(view, absOffset + 2)
      results.set(absOffset, { name: hit.name, type: 'bool', subId, offset: absOffset, value: v, bool: v !== 0 })
    } else if (markerByte === TYPE_FLOAT) {
      const v = readF32LE(view, absOffset + 2)
      results.set(absOffset, { name: hit.name, type: 'float', subId, offset: absOffset, value: v })
    } else if (markerByte === TYPE_INT) {
      const v = readU32LE(view, absOffset + 2)
      results.set(absOffset, { name: hit.name, type: 'int', subId, offset: absOffset, value: v })
    } else if (markerByte === TYPE_COLOR && fitsValue(absOffset, 14, end)) {
      const r = readF32LE(view, absOffset + 2)
      const g = readF32LE(view, absOffset + 6)
      const b = readF32LE(view, absOffset + 10)
      results.set(absOffset, { name: hit.name, type: 'color', subId, offset: absOffset, value: { r, g, b }, hex: rgbToHex(r, g, b) })
    }
  }

  return Array.from(results.values()).sort((a, b) => a.offset - b.offset)
}

// Single byte walk that collects both TLV marker candidates (Pass 1) and
// known-name hits (Pass 3 input) in one O(n) pass. First-byte dispatch via
// NEEDLES_BY_FIRST_BYTE keeps the per-byte needle check O(1) amortised —
// the vast majority of byte values have no associated needle.
function scanMarkersAndNames(buf, view, start, end) {
  const markers = []
  const nameHits = []
  for (let m = start; m < end; m++) {
    const b = buf[m]
    if (b === TYPE_FLOAT && isValidFloatMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'float' })
    } else if (b === TYPE_INT && isValidIntMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'int' })
    } else if (b === TYPE_COLOR && isValidColorMarker(buf, view, m, end)) {
      markers.push({ pos: m, type: 'color' })
    } else if (b === TYPE_BOOL && isValidBoolMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'bool' })
    } else if (b === TYPE_TEXSLOT && isValidTexslotMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'texslot' })
    }

    const candidates = NEEDLES_BY_FIRST_BYTE[b]
    if (candidates !== undefined) {
      for (let ci = 0; ci < candidates.length; ci++) {
        const cand = candidates[ci]
        if (m + cand.length > end) continue
        const bytes = cand.bytes
        let matched = true
        for (let i = 1; i < cand.length; i++) {
          if (buf[m + i] !== bytes[i]) { matched = false; break }
        }
        if (matched) {
          nameHits.push({ namePos: m, name: cand.name, length: cand.length })
        }
      }
    }
  }
  markers.sort((a, b) => a.pos - b.pos)
  return { markers, nameHits }
}

function readName(buf, cursor, markerPos) {
  let nameStart = markerPos - 1
  while (nameStart >= cursor && isPrintable(buf[nameStart])) nameStart--
  nameStart++
  return cleanParamName(readAscii(buf, nameStart, markerPos))
}

function readValue(buf, view, marker, end, name) {
  const subId = buf[marker.pos + 1]
  if (marker.type === 'float') {
    if (!fitsValue(marker.pos, 6, end)) return null
    return { name, type: 'float', subId, offset: marker.pos, value: readF32LE(view, marker.pos + 2), valueEnd: marker.pos + 6 }
  }
  if (marker.type === 'int') {
    if (!fitsValue(marker.pos, 6, end)) return null
    return { name, type: 'int', subId, offset: marker.pos, value: readU32LE(view, marker.pos + 2), valueEnd: marker.pos + 6 }
  }
  if (marker.type === 'color') {
    if (!fitsValue(marker.pos, 14, end)) return null
    const r = readF32LE(view, marker.pos + 2)
    const g = readF32LE(view, marker.pos + 6)
    const b = readF32LE(view, marker.pos + 10)
    return { name, type: 'color', subId, offset: marker.pos, value: { r, g, b }, hex: rgbToHex(r, g, b), valueEnd: marker.pos + 14 }
  }
  if (marker.type === 'bool') {
    if (!fitsValue(marker.pos, 6, end)) return null
    const v = readU32LE(view, marker.pos + 2)
    return { name, type: 'bool', subId, offset: marker.pos, value: v, bool: v !== 0, valueEnd: marker.pos + 6 }
  }
  if (marker.type === 'texslot') {
    if (!fitsValue(marker.pos, 6, end)) return null
    const slot = readU32LE(view, marker.pos + 2)
    return { name, type: 'texslot', subId, offset: marker.pos, value: slot, note: `Texture slot binding → sub-shader color slot #${slot}`, valueEnd: marker.pos + 6 }
  }
  return null
}
