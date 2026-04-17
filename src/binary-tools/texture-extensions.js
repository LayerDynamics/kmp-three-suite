/**
 * Single source of truth for the texture extension allow-list. Imported by
 * the archive classifier in decompression-tools.js and re-exported from
 * kmp.schema.js as the public binding, so the two cannot drift.
 *
 * The returned Set is genuinely immutable: `Object.freeze(new Set(...))`
 * alone does not prevent `.add()` / `.delete()` / `.clear()` because those
 * methods operate on internal slots, not own properties. Replacing the
 * mutators with throwing stubs — then freezing — closes that hole.
 */

function makeFrozenSet(values) {
  const set = new Set(values)
  const block = (op) => () => { throw new TypeError(`Cannot ${op} a frozen Set`) }
  set.add = block('add')
  set.delete = block('delete')
  set.clear = block('clear')
  return Object.freeze(set)
}

/** @type {ReadonlySet<string>} */
export const TEXTURE_EXTENSIONS = makeFrozenSet([
  'png', 'jpg', 'jpeg', 'exr', 'hdr', 'tif', 'tiff', 'bmp',
])
