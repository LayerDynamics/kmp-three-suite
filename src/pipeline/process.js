// Pipeline error taxonomy. Full orchestrator implementation arrives in T40.

export class KmpParseError extends Error {
  constructor(code, message, offset) {
    super(message)
    this.name = 'KmpParseError'
    this.code = code
    if (offset !== undefined) this.offset = offset
  }
}
