// End-to-end MTL decode. Orchestrates header / PNG / param-section / footer /
// material-name extraction. Evidence: kmp-pipeline.mjs:517-610, 858-895.

import {
  findPngBounds, findParamSection, findFooter, findSubShaderRegion,
  readAscii, readF32LE,
} from '../binary-tools/binary-tools.js'
import { parseParamSection } from './mtl-param-parser.js'

export const KNOWN_SHADER_TYPES = Object.freeze([
  'lux_toon', 'toon', 'lux_translucent', 'metallic_paint',
  'lux_plastic', 'lux_metal', 'lux_glass', 'lux_dielectric',
  'lux_gem', 'lux_diffuse', 'lux_emissive', 'lux_velvet',
  'lux_paint', 'lux_car_paint', 'lux_cloth', 'lux_skin',
  'lux_x_ray', 'lux_flat', 'lux_advanced', 'lux_cutaway',
])

export function extractMtl(mtlBuf) {
  const buf = mtlBuf instanceof Uint8Array ? mtlBuf : new Uint8Array(mtlBuf)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  const header = decodeHeader(buf)
  const pngInfo = findPngBounds(buf)
  const png = pngInfo
    ? { bytes: buf.subarray(pngInfo.start, pngInfo.end), start: pngInfo.start, end: pngInfo.end, size: pngInfo.size }
    : null

  const pngEnd = pngInfo ? pngInfo.end : -1
  const { start, end } = findParamSection(buf, pngEnd, -1)

  const subShaderRegion = findSubShaderRegion(buf, start, end, KNOWN_SHADER_TYPES)
  const parseStart = subShaderRegion ? subShaderRegion.mainShaderStart : start

  const rawParameters = parseParamSection(buf, view, parseStart, end)
  const shaderType = rawParameters.length > 0 ? rawParameters[0].name : null

  const footer = findFooter(buf, end)
  const materialName = null

  return {
    header,
    png,
    paramSection: { start: parseStart, end },
    subShaderRegion,
    footer: { start: footer.offset, type: footer.type },
    rawParameters,
    materialName,
    shaderType,
    _buf: buf,
  }
}

function decodeHeader(buf) {
  const head = readAscii(buf, 0, Math.min(256, buf.length))
  const result = {}
  const mat = head.match(/\/\/--lux:mat:(\S+)/)
  if (mat) result.matVersion = mat[1]
  const shader = head.match(/\/\/--lux:shader:(\S+)/)
  if (shader) result.shaderVersion = shader[1]
  const ks = head.match(/KeyShot.*?v([\d.]+)/)
  if (ks) result.keyshotVersion = ks[1]
  return result
}
