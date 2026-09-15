/**
 * Generates the two binary assets the app ships with, so the repo has no
 * opaque blobs and you can tweak the sound or icon by editing numbers here.
 *
 *   src/assets/chime.wav   two-tone bell, 44.1 kHz mono 16-bit PCM
 *   build/icon.png         512x512 RGBA clock glyph (electron-builder
 *                          derives .ico and .icns from this)
 *
 * Run with: npm run assets
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ audio */

const SAMPLE_RATE = 44100

/**
 * One struck-bell note: a fundamental plus a couple of quiet partials, under
 * an exponential decay. The partials are what keep it from sounding like a
 * test tone.
 */
function renderNote(buffer, startSec, freq, durSec, gain) {
  const start = Math.floor(startSec * SAMPLE_RATE)
  const len = Math.floor(durSec * SAMPLE_RATE)
  const partials = [
    [1, 1.0],
    [2, 0.28],
    [2.76, 0.12], // inharmonic, gives it the metallic bell edge
    [4, 0.06]
  ]

  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE
    const decay = Math.exp(-3.2 * t)
    // 4 ms fade-in, otherwise the attack clicks
    const attack = Math.min(1, t / 0.004)

    let sample = 0
    for (const [mult, amp] of partials) {
      sample += amp * Math.sin(2 * Math.PI * freq * mult * t)
    }

    const idx = start + i
    if (idx < buffer.length) buffer[idx] += sample * decay * attack * gain
  }
}

function buildChime() {
  const totalSec = 1.9
  const total = Math.ceil(totalSec * SAMPLE_RATE)
  const samples = new Float64Array(total)

  // A rising perfect fourth: E5 -> A5. Reads as "done", not as an alarm.
  renderNote(samples, 0.0, 659.25, 1.5, 0.3)
  renderNote(samples, 0.22, 880.0, 1.65, 0.34)

  // Normalize to -1.5 dBFS so the mix can never clip.
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  const norm = peak > 0 ? 0.84 / peak : 1

  const pcm = Buffer.alloc(total * 2)
  for (let i = 0; i < total; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * norm))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }

  // Canonical 44-byte RIFF/WAVE header.
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // subchunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

/* ------------------------------------------------------------------- icon */

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Anti-aliased coverage of a disc, sampled on a 3x3 grid per pixel. */
function discCoverage(px, py, cx, cy, radius) {
  let hits = 0
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3
      const y = py + (sy + 0.5) / 3
      if (Math.hypot(x - cx, y - cy) <= radius) hits++
    }
  }
  return hits / 9
}

function buildIcon() {
  const S = 512
  const cx = S / 2
  const cy = S / 2
  const outer = 224
  const inner = 196

  const raw = Buffer.alloc(S * (S * 4 + 1))

  for (let y = 0; y < S; y++) {
    const rowStart = y * (S * 4 + 1)
    raw[rowStart] = 0 // PNG filter type: none

    for (let x = 0; x < S; x++) {
      const o = rowStart + 1 + x * 4

      const ring = discCoverage(x, y, cx, cy, outer) - discCoverage(x, y, cx, cy, inner)
      const face = discCoverage(x, y, cx, cy, inner)

      // Vertical gradient across the face: indigo -> violet.
      const g = y / S
      const faceR = Math.round(79 + (124 - 79) * g)
      const faceG = Math.round(70 + (58 - 70) * g)
      const faceB = Math.round(229 + (237 - 229) * g)

      let r = 0
      let gg = 0
      let b = 0
      let a = 0

      if (face > 0) {
        r = faceR
        gg = faceG
        b = faceB
        a = face
      }
      if (ring > 0) {
        // Bright outer ring reads at 16x16 where the hands vanish.
        r = Math.round(r * (1 - ring) + 165 * ring)
        gg = Math.round(gg * (1 - ring) + 180 * ring)
        b = Math.round(b * (1 - ring) + 252 * ring)
        a = Math.max(a, ring)
      }

      // Clock hands, drawn as thick white segments from the center.
      const hands = [
        { angle: -Math.PI / 2, len: 132, half: 11 }, // minute -> 12
        { angle: 0, len: 92, half: 12 } // hour -> 3
      ]
      for (const h of hands) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const along = dx * Math.cos(h.angle) + dy * Math.sin(h.angle)
        const across = -dx * Math.sin(h.angle) + dy * Math.cos(h.angle)
        if (along >= -14 && along <= h.len && Math.abs(across) <= h.half) {
          r = 255
          gg = 255
          b = 255
          a = 1
        }
      }

      raw[o] = r
      raw[o + 1] = gg
      raw[o + 2] = b
      raw[o + 3] = Math.round(a * 255)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ write */

function emit(relPath, buffer) {
  const full = resolve(ROOT, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, buffer)
  console.log(`  ${relPath}  (${(buffer.length / 1024).toFixed(1)} KB)`)
}

console.log('Generating assets:')
emit('src/assets/chime.wav', buildChime())
emit('build/icon.png', buildIcon())
console.log('Done.')
