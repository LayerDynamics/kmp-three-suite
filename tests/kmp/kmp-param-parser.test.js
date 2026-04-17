import { describe, it, expect } from 'vitest'
import {
  parseXmlConfig,
  autoAssignTextures,
  XML_CONFIG_MAX_LENGTH,
} from '../../src/kmp/kmp-param-parser.js'
import { createDefaultMaterialDefinition } from '../../src/lux/lux.schema.js'
import { KmpParseError } from '../../src/errors.js'

describe('parseXmlConfig', () => {
  it('extracts shader attribute', () => {
    const xml = '<Material shader="lux_toon" />'
    const cfg = parseXmlConfig(xml)
    expect(cfg.shaderHint).toBe('lux_toon')
  })
  it('returns null shaderHint when no XML', () => {
    expect(parseXmlConfig(null).shaderHint).toBeNull()
    expect(parseXmlConfig('').shaderHint).toBeNull()
  })
  it('captures all attributes into renderHints', () => {
    const xml = '<Material shader="toon" quality="high" />'
    expect(parseXmlConfig(xml).renderHints).toMatchObject({ shader: 'toon', quality: 'high' })
  })
  it('drops __proto__ / prototype / constructor keys to prevent prototype pollution', () => {
    const xml = '<cfg shader="toon" __proto__="polluted" constructor="polluted" prototype="polluted" safe="ok" />'
    const { renderHints } = parseXmlConfig(xml)
    expect(Object.prototype.hasOwnProperty.call(renderHints, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(renderHints, 'prototype')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(renderHints, 'constructor')).toBe(false)
    expect(renderHints.safe).toBe('ok')
    expect(renderHints.shader).toBe('toon')
  })
  it('does not pollute Object.prototype when XML contains __proto__ attribute', () => {
    const probeBefore = {}
    expect(probeBefore.polluted).toBeUndefined()
    const xml = '<cfg __proto__="polluted" />'
    parseXmlConfig(xml)
    const probeAfter = {}
    expect(probeAfter.polluted).toBeUndefined()
    expect(Object.prototype.polluted).toBeUndefined()
  })
  it('renderHints has no prototype chain (null-prototype object)', () => {
    const { renderHints } = parseXmlConfig('<cfg shader="toon" />')
    expect(Object.getPrototypeOf(renderHints)).toBeNull()
    const emptyHints = parseXmlConfig(null).renderHints
    expect(Object.getPrototypeOf(emptyHints)).toBeNull()
  })
  it('preserves constructor semantics on plain objects after parsing malicious XML', () => {
    const xml = '<cfg constructor="evil" />'
    parseXmlConfig(xml)
    const fresh = {}
    expect(fresh.constructor).toBe(Object)
    expect(typeof fresh.constructor).toBe('function')
  })
  it('renderHints serializes cleanly via JSON.stringify', () => {
    const xml = '<cfg shader="toon" quality="high" />'
    const { renderHints } = parseXmlConfig(xml)
    expect(JSON.parse(JSON.stringify(renderHints))).toEqual({ shader: 'toon', quality: 'high' })
  })
})

describe('parseXmlConfig — malformed / adversarial input', () => {
  it('ignores shader= inside XML comments before the root element', () => {
    const xml = '<!-- shader="evil" --><Material />'
    const cfg = parseXmlConfig(xml)
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('ignores shader= inside XML comments with no following element', () => {
    const cfg = parseXmlConfig('<!-- shader="evil" -->')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('ignores shader= inside XML comments after the root element', () => {
    const cfg = parseXmlConfig('<Material /><!-- shader="evil" -->')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('does not confuse preshader= with shader= (word-boundary anchor)', () => {
    const cfg = parseXmlConfig('<cfg preshader="lux_toon" />')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({ preshader: 'lux_toon' })
  })
  it('does not confuse data-shader= with shader=', () => {
    const cfg = parseXmlConfig('<cfg data-shader="x" shader="real" />')
    expect(cfg.shaderHint).toBe('real')
    expect({ ...cfg.renderHints }).toEqual({ 'data-shader': 'x', shader: 'real' })
  })
  it('resolves repeated shader= attributes with first-wins semantics (shaderHint and renderHints agree)', () => {
    const cfg = parseXmlConfig('<cfg shader="first" shader="second" />')
    expect(cfg.shaderHint).toBe('first')
    expect(cfg.renderHints.shader).toBe('first')
  })
  it('resolves repeated arbitrary attributes with first-wins semantics', () => {
    const cfg = parseXmlConfig('<cfg quality="low" quality="high" />')
    expect(cfg.renderHints.quality).toBe('low')
  })
  it('ignores attributes on nested elements (root-tag-only scan)', () => {
    const cfg = parseXmlConfig('<Root><Inner shader="inner-evil"/></Root>')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('does not mix root and nested-element attributes', () => {
    const cfg = parseXmlConfig('<Root quality="high"><Inner shader="inner-evil"/></Root>')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({ quality: 'high' })
  })
  it('ignores attributes inside CDATA sections', () => {
    const cfg = parseXmlConfig('<cfg><![CDATA[ shader="cdata-evil" ]]></cfg>')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('ignores attributes inside processing instructions', () => {
    const cfg = parseXmlConfig('<?xml shader="pi-evil" ?><cfg />')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('ignores attributes inside XML declarations', () => {
    const cfg = parseXmlConfig('<?xml version="1.0" encoding="UTF-8"?><cfg shader="toon"/>')
    expect(cfg.shaderHint).toBe('toon')
    expect({ ...cfg.renderHints }).toEqual({ shader: 'toon' })
  })
  it('ignores attributes inside DOCTYPE declarations', () => {
    const cfg = parseXmlConfig('<!DOCTYPE cfg SYSTEM "evil.dtd"><cfg />')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('ignores shader= in text content following the root opening tag', () => {
    const cfg = parseXmlConfig('<cfg quality="high">text with shader="text-evil"</cfg>')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({ quality: 'high' })
  })
  it('decodes the five predefined XML entities in attribute values', () => {
    const xml = '<cfg a="&lt;" b="&gt;" c="&amp;" d="&quot;" e="&apos;" />'
    expect({ ...parseXmlConfig(xml).renderHints }).toEqual({
      a: '<', b: '>', c: '&', d: '"', e: "'",
    })
  })
  it('decodes decimal numeric character references in attribute values', () => {
    expect(parseXmlConfig('<cfg shader="&#108;ux_toon" />').shaderHint).toBe('lux_toon')
  })
  it('decodes hexadecimal numeric character references in attribute values', () => {
    expect(parseXmlConfig('<cfg shader="&#x6c;ux_toon" />').shaderHint).toBe('lux_toon')
    expect(parseXmlConfig('<cfg shader="&#X6C;ux_toon" />').shaderHint).toBe('lux_toon')
  })
  it('leaves malformed / unknown entities unchanged', () => {
    const cfg = parseXmlConfig('<cfg a="&notreal;" b="&#xZZZ;" c="&;" />')
    expect(cfg.renderHints.a).toBe('&notreal;')
    expect(cfg.renderHints.b).toBe('&#xZZZ;')
    expect(cfg.renderHints.c).toBe('&;')
  })
  it('rejects out-of-range numeric character references', () => {
    const cfg = parseXmlConfig('<cfg a="&#x110000;" />')
    expect(cfg.renderHints.a).toBe('&#x110000;')
  })
  it('supports single-quoted attribute values', () => {
    const cfg = parseXmlConfig("<cfg shader='toon' quality='high' />")
    expect(cfg.shaderHint).toBe('toon')
    expect({ ...cfg.renderHints }).toEqual({ shader: 'toon', quality: 'high' })
  })
  it('supports mixed double- and single-quoted attribute values on the same element', () => {
    const cfg = parseXmlConfig(`<cfg shader="toon" quality='high' />`)
    expect({ ...cfg.renderHints }).toEqual({ shader: 'toon', quality: 'high' })
  })
  it('does not treat > inside a quoted attribute value as tag termination', () => {
    const cfg = parseXmlConfig('<cfg shader="a>b" quality="high" />')
    expect(cfg.shaderHint).toBe('a>b')
    expect({ ...cfg.renderHints }).toEqual({ shader: 'a>b', quality: 'high' })
  })
  it('ignores unquoted attribute values (invalid XML — silent drop)', () => {
    const cfg = parseXmlConfig('<cfg shader=toon />')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('accepts empty attribute values', () => {
    const cfg = parseXmlConfig('<cfg shader="" quality="" />')
    expect(cfg.shaderHint).toBe('')
    expect(cfg.renderHints.shader).toBe('')
    expect(cfg.renderHints.quality).toBe('')
  })
  it('handles attributes split across multiple lines', () => {
    const xml = '<Material\n  shader="toon"\n  quality="high"\n/>'
    const cfg = parseXmlConfig(xml)
    expect(cfg.shaderHint).toBe('toon')
    expect({ ...cfg.renderHints }).toEqual({ shader: 'toon', quality: 'high' })
  })
  it('tolerates leading whitespace before the root element', () => {
    expect(parseXmlConfig('   \n\t<cfg shader="toon" />').shaderHint).toBe('toon')
  })
  it('is case-insensitive when detecting shaderHint but preserves renderHints key case', () => {
    const cfg = parseXmlConfig('<cfg SHADER="toon" />')
    expect(cfg.shaderHint).toBe('toon')
    expect({ ...cfg.renderHints }).toEqual({ SHADER: 'toon' })
  })
  it('ignores attributes that smuggle shader through a comment inside the opening tag position', () => {
    const cfg = parseXmlConfig('<cfg><!-- shader="evil" --></cfg>')
    expect(cfg.shaderHint).toBeNull()
  })
  it('drops forbidden keys even when delivered via repeated attributes', () => {
    const cfg = parseXmlConfig('<cfg __proto__="a" shader="toon" __proto__="b" />')
    expect(Object.prototype.hasOwnProperty.call(cfg.renderHints, '__proto__')).toBe(false)
    expect(cfg.shaderHint).toBe('toon')
  })
  it('returns a null-prototype renderHints even on adversarial input', () => {
    const cfg = parseXmlConfig('<!-- shader="a" --><r __proto__="b"><x shader="c"/></r>')
    expect(Object.getPrototypeOf(cfg.renderHints)).toBeNull()
  })
  it('ignores attributes on an unterminated opening tag without crashing', () => {
    const cfg = parseXmlConfig('<cfg shader="toon" quality="high"')
    expect(cfg.shaderHint).toBe('toon')
    expect({ ...cfg.renderHints }).toEqual({ shader: 'toon', quality: 'high' })
  })
  it('handles inputs with only whitespace', () => {
    const cfg = parseXmlConfig('   \n\t  ')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
  it('handles inputs with only stripped structure', () => {
    const cfg = parseXmlConfig('<!-- nothing --><?xml ?><![CDATA[ ]]>')
    expect(cfg.shaderHint).toBeNull()
    expect({ ...cfg.renderHints }).toEqual({})
  })
})

describe('parseXmlConfig — input length cap', () => {
  it('exposes a 1 MB cap constant', () => {
    expect(XML_CONFIG_MAX_LENGTH).toBe(1024 * 1024)
  })
  it('accepts input exactly at the cap', () => {
    const head = '<cfg shader="toon" '
    const tail = '/>'
    const padKey = 'p="'
    const padClose = '" '
    const padOverhead = padKey.length + padClose.length
    const padBodyLen = XML_CONFIG_MAX_LENGTH - head.length - tail.length - padOverhead
    expect(padBodyLen).toBeGreaterThan(0)
    const xml = head + padKey + 'a'.repeat(padBodyLen) + padClose + tail
    expect(xml.length).toBe(XML_CONFIG_MAX_LENGTH)
    const cfg = parseXmlConfig(xml)
    expect(cfg.shaderHint).toBe('toon')
  })
  it('throws KmpParseError with code BAD_ZIP for input one byte over the cap', () => {
    const wrapper = '<cfg></cfg>'
    const xml = '<cfg>' + ' '.repeat(XML_CONFIG_MAX_LENGTH + 1 - wrapper.length) + '</cfg>'
    expect(xml.length).toBe(XML_CONFIG_MAX_LENGTH + 1)
    let caught = null
    try { parseXmlConfig(xml) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(KmpParseError)
    expect(caught.code).toBe('BAD_ZIP')
    expect(caught.message).toContain(String(xml.length))
    expect(caught.message).toContain(String(XML_CONFIG_MAX_LENGTH))
  })
  it('rejects oversized adversarial input cheaply (no full-buffer strip)', () => {
    // If the cap were enforced AFTER stripping, 64 MB would allocate multiple
    // replacement buffers and take seconds. With the cap first, this throws
    // immediately.
    const xml = '<!--' + 'x'.repeat(64 * 1024 * 1024) + '-->'
    const start = Date.now()
    expect(() => parseXmlConfig(xml)).toThrow(KmpParseError)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(250)
  })
})

describe('autoAssignTextures', () => {
  function texture(path) { return { path, bytes: new Uint8Array(), byteLength: 0, extension: path.split('.').pop() } }

  it('assigns albedo to map', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [texture('my_albedo.png')])
    expect(mat.map).toBe('my_albedo.png')
  })
  it('assigns normal to normalMap', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [texture('surface_normal.jpg')])
    expect(mat.normalMap).toBe('surface_normal.jpg')
  })
  it('assigns multiple textures to distinct slots', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [
      texture('base_color.png'),
      texture('rough.exr'),
      texture('metal.jpg'),
      texture('height.png'),
    ])
    expect(mat.map).toBe('base_color.png')
    expect(mat.roughnessMap).toBe('rough.exr')
    expect(mat.metalnessMap).toBe('metal.jpg')
    expect(mat.displacementMap).toBe('height.png')
  })
  it('first match wins when same slot would match multiple', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [texture('first_albedo.png'), texture('second_albedo.png')])
    expect(mat.map).toBe('first_albedo.png')
  })
})
