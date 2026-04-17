// Public surface. Mirrored by index.d.ts.

export { process, KmpParseError } from './pipeline/process.js'
export { toMemory, toFilesystem, toMaterialDefinitionOnly, toFixtureJson } from './pipeline/target.js'
export { extractKmp } from './kmp/kmp-extraction.js'
export { extractMtl, KNOWN_SHADER_TYPES as MTL_KNOWN_SHADER_TYPES } from './mtl/mtl-extraction.js'
export { parseParamSection, KNOWN_BOOL_PARAM_NAMES } from './mtl/mtl-param-parser.js'
export { buildMaterialDefinition } from './lux/lux-extraction.js'
export { makeAccessors } from './lux/lux-param-parser.js'
export { createDefaultMaterialDefinition, KNOWN_SHADER_TYPES } from './lux/lux.schema.js'
export { TEXTURE_SLOT_KEYWORDS, TEXTURE_EXTENSIONS } from './kmp/kmp.schema.js'
export { parseXmlConfig, autoAssignTextures } from './kmp/kmp-param-parser.js'
export * as binaryTools from './binary-tools/binary-tools.js'
