import { describe, it, expect } from 'vitest'
import * as bt from '../../src/binary-tools/binary-tools.js'

describe('binary-tools facade', () => {
  const required = [
    'findSequence', 'isPrintable', 'linearToSrgb', 'srgbToLinear',
    'rgbToHex', 'hexToComponents', 'componentsToHex', 'hexDump',
    'readF32LE', 'readU32LE', 'readI32LE', 'readU16LE', 'readU8',
    'readAscii', 'readAsciiPrintable',
    'isValidColorMarker', 'isValidBoolMarker', 'isValidTexslotMarker',
    'cleanParamName',
    'unzipArchive', 'enumerateEntries', 'safeExtract',
    'findPngBounds', 'findParamSection', 'findFooter', 'findSubShaderRegion',
  ]
  for (const name of required) {
    it(`re-exports ${name}`, () => {
      expect(typeof bt[name]).toBe('function')
    })
  }
})
