// Byte predicates and context validators for TLV markers.
// Evidence: kmp-pipeline.mjs:655-678, extract-toon-complete.mjs:135-167,
//           extract-kmp-exact.mjs:14 (isPrintable), 129 (name clean regex).

import { TYPE_BOOL } from '../mtl/mtl.schema.js'

/**
 * Test whether a byte is printable ASCII (`0x20` ≤ b < `0x7f`). Space (`0x20`)
 * is considered printable; DEL (`0x7f`) and control bytes are not.
 *
 * @param {number} b Byte value (0–255).
 * @returns {boolean}
 */
export function isPrintable(b) { return b >= 0x20 && b < 0x7f }

/**
 * Canonical boundary predicate for TLV value reads. Returns true iff the
 * `size`-byte record starting at `pos` lies entirely within the half-open
 * range `[..., end)`.
 *
 * The three historical spellings (`pos + size - 1 < end`,
 * `pos + size - 1 >= end` for reject, `pos + size > end` for reject) are all
 * algebraically equivalent to `pos + size <= end`; routing every caller
 * through this helper makes that equivalence explicit and prevents drift.
 *
 * @param {number} pos Byte offset of the record's first byte.
 * @param {number} size Total byte span (marker + subId + value bytes).
 * @param {number} end Exclusive upper bound.
 * @returns {boolean}
 */
export function fitsValue(pos, size, end) {
  return pos + size <= end
}

/**
 * Context-sensitive validator for a TLV color marker (`0x27`) at `pos`.
 *
 * Accepts when the preceding byte is a non-space printable ASCII (name tail)
 * and the three float32 channels decode as finite numbers inside a reasonable
 * color range (`[COLOR_MIN_VALUE, COLOR_MAX_VALUE]`). Every caller should gate
 * color-marker reads through this helper; the marker byte alone is a printable
 * ASCII apostrophe and produces false positives on unstructured data.
 *
 * Historically this validator also required the sub-id byte at `pos + 1` to
 * be non-printable (`< 0x20`). KeyShot 14+ emits legitimate color records
 * whose sub-id lands on `0x20` (space) or `0x21` (`!`) — e.g. BLACK's
 * `roughness' 0x20 …` all-zero color at 0x2b3d5 and `ior'! 0x21 …` all-zero
 * color at 0x2b41a of `DEFCAD STANDARD BLACK.mtl`. To decode those the
 * sub-id constraint was dropped; structural discipline is now enforced
 * exclusively by the name-tail-before rule plus the finite-in-range float
 * check, which together cut random-byte false positives to the order of
 * ~1 / 2^24 per scanned byte (three f32 channels that all land in
 * [0, COLOR_MAX_VALUE]).
 *
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} pos Byte offset of the marker candidate.
 * @param {number} end Exclusive upper bound of the scan range.
 * @returns {boolean}
 */
const COLOR_MIN_VALUE = -0.0001
const COLOR_MAX_VALUE = 10
export function isValidColorMarker(buf, view, pos, end) {
  if (pos <= 0 || !fitsValue(pos, 14, end)) return false
  const before = buf[pos - 1]
  if (!isPrintable(before) || before === 0x20) return false
  const r = view.getFloat32(pos + 2, true)
  const g = view.getFloat32(pos + 6, true)
  const b = view.getFloat32(pos + 10, true)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false
  if (r < COLOR_MIN_VALUE || r > COLOR_MAX_VALUE) return false
  if (g < COLOR_MIN_VALUE || g > COLOR_MAX_VALUE) return false
  if (b < COLOR_MIN_VALUE || b > COLOR_MAX_VALUE) return false
  return true
}

/**
 * Context-sensitive validator for a TLV bool marker (`TYPE_BOOL`, `0x25`) at
 * `pos`. Accepts only when the preceding byte is a printable ASCII (name tail)
 * that is NOT itself a `TYPE_BOOL` byte (which would indicate a `%%` run
 * inside a name), and the following byte is a non-printable subId.
 *
 * @param {Uint8Array} buf
 * @param {number} pos Byte offset of the marker candidate.
 * @param {number} end Exclusive upper bound of the scan range.
 * @returns {boolean}
 */
export function isValidBoolMarker(buf, pos, end) {
  if (pos <= 0 || !fitsValue(pos, 6, end)) return false
  const before = buf[pos - 1]
  const after = buf[pos + 1]
  if (!isPrintable(before)) return false
  if (before === TYPE_BOOL) return false
  return after < 0x20
}

/**
 * Shared context-sensitive validator for 6-byte TLV markers whose acceptance
 * rule is "printable byte before (name tail) + non-printable subId after".
 * Used by the float (`0x17`), int (`0x1d`), and texslot (`0x9b`) markers —
 * 0x17 and 0x1d are non-printable control codes (ETB / GS) that also occur
 * inside random f32/u32 payload bytes, and 0x9b shares the same structural
 * contract. Bool has an extra `before !== 0x25` guard; color has a 14-byte
 * span + finite-float check and lives in its own validator.
 *
 * @param {Uint8Array} buf
 * @param {number} pos Byte offset of the marker candidate.
 * @param {number} end Exclusive upper bound of the scan range.
 * @returns {boolean}
 */
function hasNameTailAndSubId(buf, pos, end) {
  if (pos <= 0 || !fitsValue(pos, 6, end)) return false
  const before = buf[pos - 1]
  const after = buf[pos + 1]
  return isPrintable(before) && after < 0x20
}

export const isValidFloatMarker = hasNameTailAndSubId
export const isValidIntMarker = hasNameTailAndSubId
export const isValidTexslotMarker = hasNameTailAndSubId

/**
 * Strip leading characters that cannot start a parameter name, i.e. anything
 * outside `[A-Za-z_]`. Trailing characters are preserved as-is (names can
 * legitimately contain spaces, digits, or underscores).
 *
 * @param {string} raw Decoded byte run that may begin with noise.
 * @returns {string}
 */
export function cleanParamName(raw) {
  return raw.replace(/^[^a-zA-Z_]+/, '')
}
