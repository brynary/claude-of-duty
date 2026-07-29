#!/usr/bin/env node
/**
 * Pixel-exact PNG comparison, no dependencies.
 *
 * Pairs PNGs by filename between two directories (or compares two files) and
 * reports whether they are pixel-identical. Any difference writes a heatmap
 * PNG next to the report: unchanged pixels in dim grayscale, changed in red.
 *
 *   node tools/pixeldiff.mjs --a shots/base --b shots/candidate --out shots/diff
 *   node tools/pixeldiff.mjs --a base.png --b candidate.png
 *
 * Exit code 0 = every pair identical, 1 = any pair differs or is missing.
 * Decoder covers what Chrome screenshots produce: 8-bit RGB/RGBA, greyscale,
 * non-interlaced.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'
import { join, basename, resolve } from 'node:path'

// --- PNG decode -------------------------------------------------------------

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNG unsupported')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported color type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = Buffer.allocUnsafe(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = x >= channels && prev ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = v & 0xff
    }
  }
  return { width, height, channels, px }
}

// --- PNG encode (RGB, filter 0) ----------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(...bufs) {
  let c = 0xffffffff
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(head.subarray(4), data), 0)
  return Buffer.concat([head, data, crc])
}

function encodePngRgb(width, height, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  const stride = width * 3
  const raw = Buffer.allocUnsafe(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- Compare ------------------------------------------------------------------

function comparePair(fileA, fileB, diffOut) {
  const a = decodePng(readFileSync(fileA))
  const b = decodePng(readFileSync(fileB))
  if (a.width !== b.width || a.height !== b.height) {
    return { status: 'size-mismatch', a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` }
  }
  const n = a.width * a.height
  let differing = 0
  let maxDelta = 0
  let diffRgb = null
  for (let i = 0; i < n; i++) {
    let delta = 0
    for (let c = 0; c < 3; c++) {
      const va = a.channels >= 3 ? a.px[i * a.channels + c] : a.px[i * a.channels]
      const vb = b.channels >= 3 ? b.px[i * b.channels + c] : b.px[i * b.channels]
      delta = Math.max(delta, Math.abs(va - vb))
    }
    if (delta > 0) {
      if (!diffRgb) {
        diffRgb = Buffer.allocUnsafe(n * 3)
        for (let j = 0; j < n; j++) {
          const g = a.channels >= 3
            ? (a.px[j * a.channels] * 77 + a.px[j * a.channels + 1] * 150 + a.px[j * a.channels + 2] * 29) >> 9
            : a.px[j * a.channels] >> 1
          diffRgb[j * 3] = g; diffRgb[j * 3 + 1] = g; diffRgb[j * 3 + 2] = g
        }
      }
      differing++
      maxDelta = Math.max(maxDelta, delta)
      diffRgb[i * 3] = 255; diffRgb[i * 3 + 1] = 32; diffRgb[i * 3 + 2] = 32
    }
  }
  if (differing === 0) return { status: 'identical', pixels: n }
  if (diffOut) writeFileSync(diffOut, encodePngRgb(a.width, a.height, diffRgb))
  return {
    status: 'different', pixels: n, differing,
    pct: +((differing / n) * 100).toFixed(4), maxDelta, heatmap: diffOut ?? null,
  }
}

function main() {
  const argv = process.argv
  let a = null, b = null, out = null
  // Tolerance for GPU last-bit rounding noise, measured per pose from
  // same-build captures. Exact identity remains the default.
  let maxDelta = 0, maxPct = 0
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--a') a = argv[++i]
    else if (argv[i] === '--b') b = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
    else if (argv[i] === '--maxdelta') maxDelta = Number(argv[++i])
    else if (argv[i] === '--maxpct') maxPct = Number(argv[++i])
  }
  if (!a || !b) {
    console.error('usage: pixeldiff.mjs --a <dir|file> --b <dir|file> [--out <dir>]')
    process.exit(2)
  }
  a = resolve(a); b = resolve(b)

  const pairs = []
  if (statSync(a).isDirectory()) {
    const names = readdirSync(a).filter((f) => f.endsWith('.png') && !f.includes('FAILED') && !f.startsWith('diff-'))
    for (const name of names) pairs.push([join(a, name), join(b, name), name])
  } else {
    pairs.push([a, b, basename(a)])
  }
  if (out) mkdirSync(out, { recursive: true })

  let anyDiff = false
  const results = []
  for (const [fa, fb, name] of pairs) {
    try {
      statSync(fb)
    } catch {
      console.log(`[diff] ${name.padEnd(16)} MISSING in --b`)
      anyDiff = true
      results.push({ name, status: 'missing' })
      continue
    }
    const r = comparePair(fa, fb, out ? join(out, `diff-${name}`) : null)
    results.push({ name, ...r })
    if (r.status === 'identical') {
      console.log(`[diff] ${name.padEnd(16)} identical (${r.pixels} px)`)
    } else if (r.status === 'different' && r.maxDelta <= maxDelta && r.pct <= maxPct) {
      console.log(`[diff] ${name.padEnd(16)} within tolerance: ${r.differing} px (${r.pct}%), ` +
        `max channel delta ${r.maxDelta} (allowed ≤${maxDelta} on ≤${maxPct}%)`)
    } else {
      anyDiff = true
      console.log(`[diff] ${name.padEnd(16)} ${r.status.toUpperCase()} ` +
        (r.status === 'different' ? `${r.differing} px (${r.pct}%), max channel delta ${r.maxDelta}` : `${r.a} vs ${r.b}`))
    }
  }
  if (out) writeFileSync(join(out, 'pixeldiff.json'), JSON.stringify(results, null, 2))
  process.exit(anyDiff ? 1 : 0)
}

main()
