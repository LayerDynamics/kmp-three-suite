// Hybrid TLV parser: marker scan (pass 1), name-first fallback (pass 2, T11),
// and bare-name tail inference (pass 3, T12).
// Evidence: kmp-pipeline.mjs:630-852.

import {
  TYPE_FLOAT, TYPE_COLOR, TYPE_INT, TYPE_BOOL, TYPE_TEXSLOT,
} from './mtl.schema.js'
import {
  isPrintable, isValidColorMarker, isValidBoolMarker, isValidTexslotMarker,
  cleanParamName, rgbToHex, readF32LE, readU32LE,
} from '../binary-tools/binary-tools.js'

// Known boolean param names that the marker scan may miss because 0x25 is
// printable ASCII. Evidence: kmp-pipeline.mjs:802-807.
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

export function parseParamSection(buf, view, start, end) {
  const results = new Map()

  const allMarkers = scanMarkers(buf, start, end)

  let cursor = start
  let valueEnd = start

  for (const marker of allMarkers) {
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

  // Pass 3: bare-name tail inference — KeyShot omits the marker byte for
  // trailing false booleans, so a printable run after the last parsed value
  // is recorded as type='bool_inferred', value=0, bool=false.
  // Evidence: kmp-pipeline.mjs:769-796.
  if (cursor < end) {
    let trailStart = cursor
    while (trailStart < end && !isPrintable(buf[trailStart])) trailStart++
    if (trailStart < end) {
      let trailEnd = trailStart
      while (trailEnd < end && isPrintable(buf[trailEnd])) trailEnd++
      if (trailEnd > trailStart) {
        let raw = ''
        for (let i = trailStart; i < trailEnd; i++) raw += String.fromCharCode(buf[i])
        const bareName = raw
          .replace(/^[^a-zA-Z_]+/, '')
          .replace(/[/;:].+$/, '')
        if (bareName.length > 3) {
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

  // Pass 2: name-first fallback — find known bool param names the marker
  // scan missed (e.g. 'transparency' at offset 0 with no preceding byte).
  const text = new TextDecoder('latin1').decode(buf.subarray(start, end))
  for (const pn of KNOWN_BOOL_PARAM_NAMES) {
    let idx = text.indexOf(pn)
    while (idx >= 0) {
      const absOffset = start + idx + pn.length
      if (absOffset + 6 <= end && !results.has(absOffset)) {
        const markerByte = buf[absOffset]
        const subId = buf[absOffset + 1]
        if (markerByte === TYPE_BOOL) {
          const v = readU32LE(view, absOffset + 2)
          results.set(absOffset, { name: pn, type: 'bool', subId, offset: absOffset, value: v, bool: v !== 0 })
        } else if (markerByte === TYPE_FLOAT) {
          const v = readF32LE(view, absOffset + 2)
          results.set(absOffset, { name: pn, type: 'float', subId, offset: absOffset, value: v })
        } else if (markerByte === TYPE_INT) {
          const v = readU32LE(view, absOffset + 2)
          results.set(absOffset, { name: pn, type: 'int', subId, offset: absOffset, value: v })
        } else if (markerByte === TYPE_COLOR && absOffset + 14 <= end) {
          const r = readF32LE(view, absOffset + 2)
          const g = readF32LE(view, absOffset + 6)
          const b = readF32LE(view, absOffset + 10)
          results.set(absOffset, { name: pn, type: 'color', subId, offset: absOffset, value: { r, g, b }, hex: rgbToHex(r, g, b) })
        }
      }
      idx = text.indexOf(pn, idx + pn.length)
    }
  }

  return Array.from(results.values()).sort((a, b) => a.offset - b.offset)
}

function scanMarkers(buf, start, end) {
  const markers = []
  for (let m = start; m < end; m++) {
    const b = buf[m]
    if (b === TYPE_FLOAT || b === TYPE_INT) {
      if (m > start && m + 5 < end) {
        markers.push({ pos: m, type: b === TYPE_FLOAT ? 'float' : 'int' })
      }
    } else if (b === TYPE_COLOR && isValidColorMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'color' })
    } else if (b === TYPE_BOOL && isValidBoolMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'bool' })
    } else if (b === TYPE_TEXSLOT && isValidTexslotMarker(buf, m, end)) {
      markers.push({ pos: m, type: 'texslot' })
    }
  }
  markers.sort((a, b) => a.pos - b.pos)
  return markers
}

function readName(buf, cursor, markerPos) {
  let nameStart = markerPos - 1
  while (nameStart >= cursor && isPrintable(buf[nameStart])) nameStart--
  nameStart++
  let raw = ''
  for (let i = nameStart; i < markerPos; i++) raw += String.fromCharCode(buf[i])
  return cleanParamName(raw)
}

function readValue(buf, view, marker, end, name) {
  const subId = buf[marker.pos + 1]
  if (marker.type === 'float') {
    if (marker.pos + 6 > end) return null
    return { name, type: 'float', subId, offset: marker.pos, value: readF32LE(view, marker.pos + 2), valueEnd: marker.pos + 6 }
  }
  if (marker.type === 'int') {
    if (marker.pos + 6 > end) return null
    return { name, type: 'int', subId, offset: marker.pos, value: readU32LE(view, marker.pos + 2), valueEnd: marker.pos + 6 }
  }
  if (marker.type === 'color') {
    if (marker.pos + 14 > end) return null
    const r = readF32LE(view, marker.pos + 2)
    const g = readF32LE(view, marker.pos + 6)
    const b = readF32LE(view, marker.pos + 10)
    return { name, type: 'color', subId, offset: marker.pos, value: { r, g, b }, hex: rgbToHex(r, g, b), valueEnd: marker.pos + 14 }
  }
  if (marker.type === 'bool') {
    if (marker.pos + 6 > end) return null
    const v = readU32LE(view, marker.pos + 2)
    return { name, type: 'bool', subId, offset: marker.pos, value: v, bool: v !== 0, valueEnd: marker.pos + 6 }
  }
  if (marker.type === 'texslot') {
    if (marker.pos + 6 > end) return null
    const slot = readU32LE(view, marker.pos + 2)
    return { name, type: 'texslot', subId, offset: marker.pos, value: slot, note: `Texture slot binding → sub-shader color slot #${slot}`, valueEnd: marker.pos + 6 }
  }
  return null
}
