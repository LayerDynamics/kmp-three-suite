// Little-endian readers and ASCII decoders.

export function readF32LE(view, offset) { return view.getFloat32(offset, true) }
export function readU32LE(view, offset) { return view.getUint32(offset, true) }
export function readI32LE(view, offset) { return view.getInt32(offset, true) }
export function readU16LE(view, offset) { return view.getUint16(offset, true) }
export function readU8(buf, offset) { return buf[offset] }

export function readAscii(buf, start, end) {
  let result = ''
  const stop = Math.min(end, buf.length)
  for (let i = start; i < stop; i++) result += String.fromCharCode(buf[i])
  return result
}

export function readAsciiPrintable(buf, start, end) {
  let result = ''
  const stop = Math.min(end, buf.length)
  for (let i = start; i < stop; i++) {
    const b = buf[i]
    if (b >= 0x20 && b < 0x7f) result += String.fromCharCode(b)
  }
  return result
}
