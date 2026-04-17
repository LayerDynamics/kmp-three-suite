// Package-level error taxonomy. Lives at the src/ root so every layer
// (binary-tools → mtl → lux → kmp → pipeline) can import it without
// inverting the layering contract.

/**
 * Error thrown when KMP/MTL parsing or ZIP extraction fails.
 *
 * `code`: `'NO_MTL'` (archive contained no .mtl entry), `'BAD_ZIP'`
 * (malformed / oversized / traversal-unsafe archive), or `'BAD_PNG'`
 * (invalid embedded PNG). `offset`, when present, is the byte offset where
 * the failure was detected. `options.cause` is forwarded to `super()` so
 * the underlying error (e.g. fflate inflate crash) remains reachable.
 */
export class KmpParseError extends Error {
  /**
   * @param {'NO_MTL' | 'BAD_ZIP' | 'BAD_PNG'} code
   * @param {string} message
   * @param {number} [offset]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, offset, options) {
    super(message, options)
    this.name = 'KmpParseError'
    this.code = code
    if (offset !== undefined) this.offset = offset
  }
}

/**
 * Sanitize an attacker-influenced string for safe inclusion in an error
 * message. Doubles backslashes, replaces C0/C1 control chars, DEL, and the
 * Unicode bidi-override / line/paragraph separators with `\xNN` or `\uNNNN`
 * escapes, and truncates to 200 chars with a `…` suffix.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeForLog(value) {
  const s = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, (ch) => {
      const n = ch.charCodeAt(0)
      return n <= 0xff
        ? '\\x' + n.toString(16).padStart(2, '0')
        : '\\u' + n.toString(16).padStart(4, '0')
    })
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}
