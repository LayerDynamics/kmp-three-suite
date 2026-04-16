// Byte predicates and context validators for TLV markers.
// Evidence: kmp-pipeline.mjs:655-678, extract-toon-complete.mjs:135-167,
//           extract-kmp-exact.mjs:14 (isPrintable), 129 (name clean regex).

import { TYPE_BOOL } from '../mtl/mtl.schema.js'

export function isPrintable(b) { return b >= 0x20 && b < 0x7f }

export function isValidColorMarker(buf, pos, end) {
  if (pos <= 0 || pos + 13 >= end) return false
  const before = buf[pos - 1]
  const after = buf[pos + 1]
  if (!isPrintable(before) || before === 0x20) return false
  if (after >= 0x20) return false
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const r = view.getFloat32(pos + 2, true)
  const g = view.getFloat32(pos + 6, true)
  const b = view.getFloat32(pos + 10, true)
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
}

export function isValidBoolMarker(buf, pos, end) {
  if (pos <= 0 || pos + 5 >= end) return false
  const before = buf[pos - 1]
  const after = buf[pos + 1]
  if (!isPrintable(before)) return false
  if (before === TYPE_BOOL) return false
  return after < 0x20
}

export function isValidTexslotMarker(buf, pos, end) {
  if (pos <= 0 || pos + 5 >= end) return false
  const before = buf[pos - 1]
  const after = buf[pos + 1]
  if (!isPrintable(before)) return false
  return after < 0x20
}

export function cleanParamName(raw) {
  return raw.replace(/^[^a-zA-Z_]+/, '')
}
