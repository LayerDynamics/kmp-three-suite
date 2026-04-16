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
