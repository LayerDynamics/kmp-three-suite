// TLV marker byte constants for the Luxion binary MTL format.
// Evidence: kmp-three-suite/reference/kmp-extraction/kmp-pipeline.mjs:469-474.

export const TYPE_FLOAT = 0x17
export const TYPE_COLOR = 0x27         // ASCII "'"
export const TYPE_INT = 0x1d
export const TYPE_BOOL = 0x25          // ASCII "%"
export const TYPE_TEXSLOT = 0x9b
export const TYPE_SUBSHADER_REF = 0xa1

export const VALUE_SIZES = Object.freeze({
  float: 5,
  color: 13,
  int: 5,
  bool: 5,
  texslot: 5,
})

export const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
export const PNG_IEND = Uint8Array.of(0x49, 0x45, 0x4e, 0x44)
export const FOOTER_NAME_PREFIX = Uint8Array.of(0x09, 0x00, 0x0b)
export const MATMETA_MARKER = new TextEncoder().encode('--MATMETA--')
export const SHADER_MARKER_BYTES = Uint8Array.of(0x89, 0x09)
export const SHADER_VERSION_LINE = new TextEncoder().encode('//--lux:shader:')
export const MAT_VERSION_LINE = new TextEncoder().encode('//--lux:mat:')
