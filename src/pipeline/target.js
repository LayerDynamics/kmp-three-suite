// Output adapters: toMemory (identity), toFilesystem (JSON + PNG + textures),
// toMaterialDefinitionOnly (lean for browser consumers).

export function toMemory(result) {
  return result
}

export function toMaterialDefinitionOnly(result) {
  return result.materialDefinition
}

export async function toFilesystem(result, outDir) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await mkdir(outDir, { recursive: true })

  const base = slugify(result.materialName || result.meta.mtlFile.replace(/\.mtl$/i, ''))
  const jsonPath = join(outDir, `${base}-extracted.json`)
  const pngPath = join(outDir, `${base}-thumbnail.png`)
  const textureDir = join(outDir, 'textures', base)
  const texturePaths = []

  const serialisable = JSON.parse(JSON.stringify(result, (k, v) => {
    if (v instanceof Uint8Array) return undefined
    if (v instanceof Map) return Object.fromEntries(v)
    return v
  }))
  await writeFile(jsonPath, JSON.stringify(serialisable, null, 2))

  if (result.png) await writeFile(pngPath, Buffer.from(result.png.bytes))

  if (result.textures.length > 0) {
    await mkdir(textureDir, { recursive: true })
    for (const t of result.textures) {
      const fileName = t.path.split('/').pop()
      const tp = join(textureDir, fileName)
      await writeFile(tp, Buffer.from(t.bytes))
      texturePaths.push(tp)
    }
  }

  return { jsonPath, pngPath, texturePaths }
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
