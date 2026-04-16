// Error taxonomy. Kept separate from process.js to avoid circular imports
// (binary-tools/decompression-tools throws these, and process.js imports
// from binary-tools).

export class KmpParseError extends Error {
  constructor(code, message, offset) {
    super(message)
    this.name = 'KmpParseError'
    this.code = code
    if (offset !== undefined) this.offset = offset
  }
}
