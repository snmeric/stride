import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Sample, Sign } from '../types'

const isOpen = atom({ plugin: 'stride', key: 'isOpen' } as const, true)
const limits = atom({ plugin: 'stride', key: 'limits' } as const, [])
const busy = atom({ plugin: 'stride', key: 'busy' } as const, false)
const sign = atom({ plugin: 'stride', key: 'sign' } as const, null)

// a meter's colour follows how much of its window is left, traffic-light style: plenty, keep an eye on it, low,
// very low, nearly gone (the last also beats the handle); `from` is the least left (in %) each status covers
const STATUS = [
  { from: 60, colour: '#5EC48C' },
  { from: 30, colour: '#A5C95A' },
  { from: 15, colour: '#E9C84A' },
  { from: 5, colour: '#EF8E3C' },
  { from: 0, colour: '#E5484D' },
]
const statusOf = (left: number) => STATUS.findIndex(s => left >= s.from)

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}

// ---------- figures ----------

const LIMIT_NAME: Record<string, string> = { five_hour: '5 saat', seven_day: 'Haftalık' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

const span = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min >= 2880) return `${Math.round(min / 1440)}g`
  if (min >= 60) return `${Math.floor(min / 60)}s${String(min % 60).padStart(2, '0')}`
  return `${min}dk`
}
const untilReset = (iso: string | undefined, now: number) => (iso ? span(Date.parse(iso) - now) : '')

// what would be left now had the window been spent evenly since it opened; null when its reset time is unknown
function paceLeft(l: Limit, now: number): number | null {
  const span = WINDOW_MS[l.kind]
  if (!l.resetsAt || !span) return null
  return Math.max(0, Math.min(100, ((Date.parse(l.resetsAt) - now) / span) * 100))
}

// readings of each window over the last hours, kept across sessions, to tell how fast it is being spent
const KEEP_MS = 6 * 3_600_000
const LOOKBACK_MS: Record<string, number> = { five_hour: 45 * 60_000, seven_day: 6 * 3_600_000 }
let history: Record<string, Sample[]> = {}

function record(list: readonly Limit[], now: number) {
  for (const l of list) {
    const kept = (history[l.kind] ?? []).filter(s => now - s.t < KEEP_MS)
    const last = kept[kept.length - 1]
    // a reset starts the count over
    if (last && l.used < last.used - 0.5) kept.length = 0
    if (!last || last.used !== l.used || now - last.t > 10 * 60_000) kept.push({ t: now, used: l.used })
    history[l.kind] = kept
  }
}

// at the pace of the last while, does the window run out before it resets? Nothing until there is a pace to go by
function eta(l: Limit, now: number): { text: string; isWarn: boolean } | null {
  const recent = (history[l.kind] ?? []).filter(s => now - s.t <= (LOOKBACK_MS[l.kind] ?? KEEP_MS))
  const first = recent[0]
  if (!first || l.used - first.used < 1 || now - first.t < 5 * 60_000) return null
  const msLeft = (100 - l.used) / ((l.used - first.used) / (now - first.t))
  const msReset = l.resetsAt ? Date.parse(l.resetsAt) - now : Infinity
  return msLeft < msReset ? { text: `bu hızla ~${span(msLeft)} içinde biter`, isWarn: true } : { text: 'bu hızla yeter', isWarn: false }
}

// ---------- drawing ----------

// Each meter follows the DSH Claude-style reasoning slider: square pixels with softly rounded corners on a fixed grid
// in a glass track, dim and grey at the far end, brighter and turning to the tint towards the handle. Every pixel blinks
// at random (see PULSE). While a turn runs the field is at full brightness; when it ends the field does not stop at
// once but eases down to its quiet brightness over a few seconds (and back up as the next turn starts), the pixels
// blinking on as before. The pixels never move; all the motion is brightness. No stripes sweep across it, nothing
// flashes white or glows.

const PITCH = 4.2
const ROWS = 5 // five rows in the same track height: small pixels, and room for legible signs
const SQ = 3.2 // the pixel's side; the rest of the pitch is the gap between pixels
const INSET = (PITCH - SQ) / 2
const RX = 0.8
// a small lighter bar along the top edge of the pixels near the handle
const HL = { dx: 1, dy: 0.8, w: SQ - 2, h: 1.1 }
const TRACK_Y = 20
const BH = 22
const DOT_Y = TRACK_Y + (BH - ROWS * PITCH) / 2
const ROW_H = 54
const THUMB_W = 16
const MAX_COLS = 200

// the row's mood: `calm` is the quiet dot matrix, `busy` and `hot` the working field (`hot` pulses quicker); the
// weekly window runs slower than the 5 hour one, so the two rows read apart at a glance
const BEAT = { calm: 1, busy: 1, hot: 0.7 } as const
type Beat = keyof typeof BEAT
const SLOW = 1.8
const EASE_MS = 2500 // how long the field takes to ease between its working and quiet brightness
const QUIET = 0.6 // the quiet field's brightness, as a share of the working one's

// Every cell of the grid is a pixel and they are all alike: none stays lit, none stays dark. Each runs a long cycle
// holding a strong and a faint soft pulse at uneven moments, picked from a set of such cycles (SHAPES); its cycle's
// length is one of a few that never line up with one another (`lengths`, scaled by the row's mood), and it starts at a
// random point of it. So from moment to moment a different scatter of pixels swells and fades, anywhere on the bar.
// Under the pulses every pixel breathes: it swells and settles slowly, twice per cycle, so with the cycles all
// different the whole field breathes unevenly, never in step. Towards the handle they rest a little brighter, breathe
// deeper, pulse brighter and more often (shorter cycles); towards the far end they are dim and pulse rarely, which is
// what makes the bar look full at the handle and thin out away from it.
const PULSE = {
  lengths: [2.6, 3.1, 3.7, 4.3, 4.9, 5.6, 6.4, 7.3, 8.9],
  moments: 16,
  rest: [0.04, 0.07, 0.1, 0.15, 0.22], // by the pixel's place along the bar, far end first
  peak: [0.35, 0.5, 0.66, 0.83, 1],
  breath: [0.05, 0.08, 0.11, 0.14, 0.18], // how much brighter a pixel gets at the top of a breath
}
// a cycle's brightness at `t` (0-1): two slow breaths, plus a strong and a faint soft pulse at the shape's moments,
// as how far it stands above the rest level, in breaths (`br`) and in pulse heights (`pu`)
function cycleAt(centres: readonly number[], t: number) {
  const br = 0.5 - 0.5 * Math.cos(t * Math.PI * 4)
  const pu = centres.reduce((sum, c, n) => sum + (n === 0 ? 1 : 0.45) * Math.exp(-Math.pow((t - c) / 0.03, 2)), 0)
  return { br, pu: Math.min(1, pu) }
}
const SHAPES = Array.from({ length: 8 }, (_, k) => {
  const first = 0.06 + hash(k, 1, 91) * 0.4
  return [first, first + 0.2 + hash(k, 2, 92) * 0.3].map(c => Math.min(0.94, c))
})
const pixelCss = () =>
  `.px rect,.hb rect{opacity:var(--b);animation-timing-function:linear;animation-iteration-count:infinite;animation-duration:var(--d);animation-delay:calc(var(--d) * var(--f) * -1)}
.px rect{width:${SQ}px;height:${SQ}px;rx:${RX}px}.hb rect{width:${HL.w}px;height:${HL.h}px;rx:${HL.h / 2}px}.hb{fill-opacity:.5}
${SHAPES.map(centres => {
  // sampled every 5% for the breaths, and closely around each pulse so its peak is kept
  const ts = new Set<number>(Array.from({ length: 21 }, (_, n) => n / 20))
  for (const c of centres) for (const d of [-0.06, -0.03, 0, 0.03, 0.06]) ts.add(Math.round((c + d) * 1000) / 1000)
  return [...ts].filter(t => t >= 0 && t <= 1).sort((a, b) => a - b)
}).map(
  (stops, k) =>
    `.s${k}{animation-name:p${k}}@keyframes p${k}{${stops
      .map(t => {
        const { br, pu } = cycleAt(SHAPES[k] ?? [], t)
        return `${(t * 100).toFixed(1)}%{opacity:calc(var(--b) + var(--a) * ${br.toFixed(2)} + (var(--p) - var(--b)) * ${pu.toFixed(2)})}`
      })
      .join('')}}`,
).join('\n')}
.calm{--k:1.5}.busy{--k:1}.hot{--k:.7}.slow{--s:${SLOW}}
${PULSE.lengths.map((s, k) => `.d${k}{--d:calc(${s}s * var(--k) * var(--s, 1))}`).join('')}
${Array.from({ length: PULSE.moments }, (_, k) => `.f${k}{--f:${(k / PULSE.moments).toFixed(3)}}`).join('')}
${PULSE.rest.map((v, k) => `.b${k}{--b:${v};--p:${PULSE.peak[k]};--a:${PULSE.breath[k]}}`).join('')}
`

// the shared pieces: a cell at every place of the grid (the faint grid of empty cells) and the glass track's fine grain
function defs(W: number) {
  const cells = Array.from({ length: ROWS }, (_, r) => `<rect x="${INSET}" y="${r * PITCH + INSET}" width="${SQ}" height="${SQ}" rx="${RX}"/>`).join('')
  return (
    `<pattern id="ta" x="0" y="${DOT_Y}" width="${PITCH}" height="${ROWS * PITCH}" patternUnits="userSpaceOnUse"><g fill="#fff">${cells}</g></pattern>` +
    `<filter id="nz" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`
  )
}

// Now and then the pixels gather into a small sign near the handle, hold it a moment and scatter back into the field:
// on what happens (a turn starting or ending, a window running low or coming back) and, while things are quiet, once
// in a while for fun. Every sign is five pixels high, drawn in the meter's own pixels; `colour` overrides the
// meter's tint. Each of its pixels lights a moment apart from the others, so it gathers out of the twinkle.
const SIGNS: Record<string, { art: string[]; colour?: string }> = {
  bolt: { art: ['...##', '..##.', '.####', '..##.', '.##..'], colour: '#7FB2F0' }, // a turn starts
  check: { art: ['.....', '....#', '...#.', '#.#..', '.#...'], colour: '#5EC48C' }, // a turn ends
  warn: { art: ['..#..', '.#.#.', '.#.#.', '#...#', '#####'], colour: '#E09A1E' }, // a window drops below 20% or 10% left
  heart: { art: ['.#.#.', '#####', '#####', '.###.', '..#..'], colour: '#E5484D' }, // a window has reset
  moon: { art: ['.###', '##..', '#...', '##..', '.###'], colour: '#9DB8FF' }, // a long while with nothing running
  star: { art: ['..#..', '.###.', '#####', '.###.', '..#..'], colour: '#F2C14E' },
  smile: { art: ['.#.#.', '.#.#.', '.....', '#...#', '.###.'], colour: '#F59AC1' },
  arrow: { art: ['..#..', '...#.', '#####', '...#.', '..#..'], colour: '#5EC4B8' }, // only while the 5 hour window is on or ahead of an even pace
}
// A sign teleports: it gathers, holds, scatters, and gathers again a few columns further from the handle, three times,
// dimmer at each stop; while it is between stops a few cells on the way flash, as if its pixels flew across.
const SIGN_STOP_MS = 2200 // one stop: gather, hold, scatter
const SIGN_HOP_S = 1.5 // seconds from one stop to the next (the stops overlap a little, so one scatters as the next gathers)
const SIGN_STOPS = [1, 0.72, 0.45] // brightness at each stop
const SIGN_MS = SIGN_STOP_MS + (SIGN_STOPS.length - 1) * SIGN_HOP_S * 1000
// while a sign shows, every pixel of the meters slowly takes on its colour and then slowly returns to its own
const TINT_MS = 6500
const SURPRISES = ['star', 'smile', 'arrow']
const MOON_AFTER_MS = 10 * 60_000
const SIGN_GAP_MS = 3 * 60_000 // a surprise waits at least this long after the last sign

type Row = {
  kind: string
  status: number // index into STATUS; 0 is plenty left
  id: string
  name: string
  value: string
  detail: string
  note: { text: string; isWarn: boolean } | null
  fill: number // 0-100: how much of the track the pixels and handle take
  color: string
  beat: Beat
  isSlow: boolean
  pace: number | null
  isLow: boolean
  isRefill: boolean
}

// pixels that break off the handle and drift back while usage is being spent
const CRUMBS = [
  { y: -4, s: 2.5, dy: -5, d: 0 },
  { y: -1, s: 2, dy: 3, d: 0.25 },
  { y: 2, s: 3, dy: -2, d: 0.5 },
  { y: -3, s: 1.5, dy: 6, d: 0.75 },
  { y: 0, s: 2.5, dy: -7, d: 1 },
  { y: 3, s: 2, dy: 4, d: 1.2 },
]

// `signNow`: the sign this row shows (if any) and how long ago it appeared, so a redraw picks it up where it was
// `place`: where the meter sits (its left edge and its line); `W` is the meter's own width
function rowSvg(row: Row, i: number, W: number, isBusy: boolean, signNow: { name: string; age: number } | null, tintNow: { colour: string; age: number } | null, place = { x: 0, y: i * ROW_H }) {
  const { id, color: c } = row
  const fw = (row.fill / 100) * W
  const hx = Math.max(0, fw - THUMB_W / 2) // the handle's left edge
  const dw = Math.max(0, hx) // the pixels run right up to it
  const base = hex(c)
  // the last column reaches in under the handle, so no gap is left between the pixels and the handle
  const cols = Math.ceil(dw / PITCH)
  const light1 = rgb(mix(base, WHITE, 0.55))
  const at = (col: number, r: number) => `x="${(col * PITCH + INSET).toFixed(1)}" y="${(DOT_Y + r * PITCH + INSET).toFixed(1)}" width="${SQ}" height="${SQ}" rx="${RX}"`

  // the pixels: one at every cell, coloured grey → tint → light along the bar, all blinking at random (see PULSE)
  const tint = tintNow ? hex(tintNow.colour) : null
  const stop = (offset: string, own: string, taken: (t: number[]) => number[]) =>
    `<stop offset="${offset}" stop-color="${own}">${tint && tintNow ? `<animate attributeName="stop-color" values="${own};${rgb(taken(tint))};${rgb(taken(tint))};${own}" keyTimes="0;.25;.7;1" calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1;.4 0 .2 1" dur="${TINT_MS / 1000}s" begin="-${(tintNow.age / 1000).toFixed(2)}s" fill="freeze"/>` : ''}</stop>`
  const colour = `<linearGradient id="${id}c" x1="0" x2="${dw.toFixed(1)}" gradientUnits="userSpaceOnUse">${stop('0', rgb(GREY), t => mix(GREY, t, 0.35))}${stop('.6', c, t => t)}${stop('1', rgb(mix(base, WHITE, 0.5)), t => mix(t, WHITE, 0.5))}</linearGradient>`
  // Each grid row is a group, so a pixel is just its x and its classes. To stay well inside the engine's size limit a
  // meter animates at most MAX_COLS columns (on a very wide window the far, dimmest end is left to the faint grid),
  // and wide meters leave out the highlight bars
  const from = Math.max(0, cols - MAX_COLS)
  const hasBars = SQ >= 5 && cols < 200 // the bars only read on large pixels
  let cells = ''
  let bars = ''
  for (let r = 0; r < ROWS; r++) {
    let line = ''
    let barLine = ''
    for (let col = from; col < cols; col++) {
      const nX = ((col + 0.5) * PITCH) / Math.max(1, dw)
      const level = Math.min(PULSE.rest.length - 1, Math.floor(Math.pow(nX, 0.8) * PULSE.rest.length))
      const pick = (k: number, n: number) => Math.floor(hash(col, r, i + k) * n)
      // shorter cycles (more pulses) towards the handle, longer ones towards the far end, always with some spread
      const d = Math.min(PULSE.lengths.length - 1, Math.floor(hash(col, r, i + 61) * 5 + (1 - nX) * 4))
      const cls = `s${pick(60, SHAPES.length)} d${d} f${pick(62, PULSE.moments)} b${level}`
      const x = (col * PITCH + INSET).toFixed(1)
      line += `<rect x="${x}" class="${cls}"/>`
      if (hasBars && nX > 0.7) barLine += `<rect x="${(col * PITCH + INSET + HL.dx).toFixed(1)}" class="${cls}"/>`
    }
    const y = DOT_Y + r * PITCH + INSET
    cells += `<g transform="translate(0 ${y.toFixed(1)})">${line}</g>`
    if (barLine) bars += `<g transform="translate(0 ${(y + HL.dy).toFixed(1)})">${barLine}</g>`
  }
  const pixels = `<g fill="url(#${id}c)" class="px">${cells}</g><g fill="${light1}" class="hb">${bars}</g>`

  // the spent part: a few of the faint grid's cells (see the track) now and then light up in the tint
  const sx = hx + THUMB_W + 1
  const sw = W - sx
  let spent = ''
  if (sw > PITCH) {
    const first = Math.ceil(sx / PITCH)
    const n = Math.floor(sw / PITCH)
    for (let k = 0; k < Math.min(8, Math.floor(n / 8)); k++) {
      const col = first + Math.floor(hash(k, i, 51) * n)
      const r = Math.floor(hash(k, i, 52) * ROWS)
      const d = 2.4 + hash(k, i, 53) * 2.4
      spent += `<rect ${at(col, r)} fill="${c}" class="gh" style="animation-duration:${d.toFixed(2)}s;animation-delay:-${(hash(k, i, 54) * d).toFixed(2)}s"/>`
    }
  }

  // the glass track: a faint fill, a fine grain, the faint grid of empty cells end to end (under the pixels and the
  // handle alike, so no gap opens beside either), a shade along the top edge and a glint along the bottom
  const track =
    `<clipPath id="${id}t"><rect x="0" y="${TRACK_Y}" width="${W}" height="${BH}" rx="${BH / 2}"/></clipPath>` +
    `<rect x="0" y="${TRACK_Y}" width="${W}" height="${BH}" rx="${BH / 2}" fill="#808080" fill-opacity=".14"/>` +
    `<g clip-path="url(#${id}t)"><rect x="0" y="${TRACK_Y}" width="${W}" height="${BH}" filter="url(#nz)" opacity=".05"/><rect x="0" y="${TRACK_Y}" width="${W}" height="${BH}" fill="url(#ta)" opacity=".08"/><rect x="0" y="${TRACK_Y}" width="${W}" height="1" fill="#000" fill-opacity=".35"/><rect x="0" y="${TRACK_Y + BH - 1}" width="${W}" height="1" fill="#fff" fill-opacity=".06"/></g>`

  // the handle: a light vertical gradient, a thin edge and two fine grip lines
  const handle =
    fw > 0
      ? `<linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${rgb(mix(WHITE, base, 0.2))}"/></linearGradient>` +
        `<rect x="${hx.toFixed(1)}" y="${TRACK_Y - 2}" width="${THUMB_W}" height="${BH + 4}" rx="6" fill="url(#${id}h)" stroke="#000" stroke-opacity=".28"${row.isLow ? ' class="hl"' : ''}/>` +
        [0.42, 0.58].map(p => `<line x1="${(hx + THUMB_W * p).toFixed(1)}" x2="${(hx + THUMB_W * p).toFixed(1)}" y1="${TRACK_Y + 6}" y2="${TRACK_Y + BH - 6}" stroke="#000" stroke-opacity=".22"/>`).join('')
      : ''

  const refill = row.isRefill ? `<animate attributeName="width" from="0" to="${fw.toFixed(1)}" dur="1.6s" calcMode="spline" keyTimes="0;1" keySplines=".3 .6 .2 1" fill="freeze"/>` : ''
  // the even pace: two small notches, on the track's top and bottom edges, where the handle would be had the window been
  // spent evenly; the track itself stays clear
  const px = row.pace !== null && row.pace > 0 && row.pace < 100 ? (row.pace / 100) * W : null
  const paceLine =
    px !== null
      ? `<g fill="#fff" fill-opacity=".8"><rect x="${(px - 3).toFixed(1)}" y="${TRACK_Y - 1}" width="6" height="4" rx="1.5"/><rect x="${(px - 3).toFixed(1)}" y="${TRACK_Y + BH - 3}" width="6" height="4" rx="1.5"/></g>`
      : ''
  const crumbs = isBusy && hx > 6 ? CRUMBS.map(k => `<rect x="${(hx - 2).toFixed(1)}" y="${TRACK_Y + BH / 2 + k.y}" width="${k.s}" height="${k.s}" fill="${c}" class="cr" style="--dy:${k.dy}px;animation-delay:${k.d}s"/>`).join('') : ''
  // the run-out estimate sits on a small line under the meter
  const note = row.note ? `<text x="0" y="${TRACK_Y + BH + NOTE_H - 2}" class="${row.note.isWarn ? 'nw' : 'nd'}">${esc(row.note.text)}</text>` : ''

  return `<g transform="translate(${place.x.toFixed(1)} ${place.y})" class="${row.beat}${row.isSlow ? ' slow' : ''}">${colour}
<text x="0" y="12" class="ul">${esc(row.name)}</text>${note}
<text x="${W}" y="12" text-anchor="end" class="un"${row.status > 0 ? ` style="fill:${c}"` : ''}>${esc(row.value)}<tspan class="ul" dx="6">${esc(row.detail)}</tspan></text>
${track}
<clipPath id="${id}k"><rect x="0" y="${TRACK_Y}" width="${fw.toFixed(1)}" height="${BH}" rx="${BH / 2}">${refill}</rect></clipPath>
<g clip-path="url(#${id}k)"><rect x="0" y="${TRACK_Y}" width="${fw.toFixed(1)}" height="${BH}" fill="${c}" fill-opacity=".06"/><g class="mood">${pixels}</g>${signSvg(signNow, cols, i, c)}</g>${spent}${paceLine}${crumbs}${handle}</g>`
}

// The sign's pixels. It shows up in a few places at once along the bar, each copy a beat after the one before: the
// first just short of the handle, the others further back (two or three in all, as the bar has room; a bar too short
// for even one shows none). The field around it carries on as it was; the sign simply lights up on top of it, then
// teleports back from the handle stop by stop (see SIGN_STOPS), never sliding.
const SIGN_SPOTS = [0.94, 0.62, 0.3] // where the copies first gather, as shares of the bar's pixel columns
const SIGN_STAGGER = 0.35 // seconds between one copy and the next

function signSvg(signNow: { name: string; age: number } | null, cols: number, i: number, tint: string) {
  const def = signNow ? SIGNS[signNow.name] : undefined
  if (!signNow || !def || signNow.age >= SIGN_MS + SIGN_STAGGER * SIGN_SPOTS.length * 1000) return ''
  const w = def.art[0]?.length ?? 0
  const hop = w + 5 // columns from one stop to the next
  const fill = rgb(mix(hex(def.colour ?? tint), WHITE, 0.6))
  const starts: number[] = []
  for (const spot of SIGN_SPOTS) {
    const start = Math.min(cols - 3 - w, Math.round(spot * cols - w / 2))
    // each copy needs its own room: off the far end and clear of the copies already placed
    if (start < 2 || starts.some(s => Math.abs(s - start) < w + 4)) continue
    starts.push(start)
  }
  const pixels = (at: number, salt: number) => {
    let out = ''
    def.art.forEach((line, r) =>
      [...line].forEach((ch, k) => {
        if (ch !== '#') return
        const x = (at + k) * PITCH + INSET
        const y = DOT_Y + r * PITCH + INSET
        out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" style="--j:${(hash(k + salt, r, i + 7) * 0.4).toFixed(2)}s"/>`
      }),
    )
    return out
  }
  return starts
    .map((start, n) => {
      const age = (signNow.age / 1000 - n * SIGN_STAGGER).toFixed(2)
      let out = ''
      SIGN_STOPS.forEach((strength, k) => {
        const at = start - k * hop
        if (at < 1) return
        const begins = k * SIGN_HOP_S
        out += `<g opacity="${strength}" style="--o:${begins}s">${pixels(at, n * 11 + k * 5)}</g>`
        // between this stop and the next, a few cells on the way flash as the pixels fly across
        const next = at - hop
        if (k === SIGN_STOPS.length - 1 || next < 1) return
        let sparks = ''
        for (let m = 0; m < 6; m++) {
          const col = next + Math.floor(hash(m, k, n + i * 3 + 21) * (hop + w))
          const r = Math.floor(hash(m, k, n + i * 3 + 22) * ROWS)
          const when = begins + SIGN_HOP_S * (0.75 + hash(m, k, n + 23) * 0.5)
          sparks += `<rect x="${(col * PITCH + INSET).toFixed(1)}" y="${(DOT_Y + r * PITCH + INSET).toFixed(1)}" style="--o:${when.toFixed(2)}s"/>`
        }
        out += `<g class="fly" opacity="${(strength * 0.8).toFixed(2)}">${sparks}</g>`
      })
      return `<g class="sg" fill="${fill}" style="--e:${age}s">${out}</g>`
    })
    .join('')
}

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a: number[], b: number[], m: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))
const rgb = (c: number[]) => `rgb(${c.join(',')})`
const GREY = [112, 110, 120]
const WHITE = [255, 255, 255]

const LOW_ALARM = 5 // below this much left the handle beats red
const REFILL_MS = 4000 // how long after a reset the meter still plays its refill
// when each window last reset, so its meter fills up again from empty once
const refilledAt = new Map<string, number>()

function limitRow(l: Limit, i: number, now: number, isBusy: boolean): Row {
  const left = Math.max(0, Math.min(100, 100 - l.used))
  const pace = paceLeft(l, now)
  const isLow = left < LOW_ALARM
  const status = Math.max(0, statusOf(left))
  return {
    id: `u${i}`,
    kind: l.kind,
    name: LIMIT_NAME[l.kind] ?? l.kind,
    value: `%${Math.round(left)}`,
    detail: untilReset(l.resetsAt, now),
    note: eta(l, now),
    fill: left,
    color: STATUS[status]?.colour ?? STATUS[0]!.colour,
    status,
    beat: isLow ? 'hot' : isBusy ? 'busy' : 'calm',
    isSlow: l.kind === 'seven_day',
    pace,
    isLow,
    isRefill: now - (refilledAt.get(l.kind) ?? -Infinity) < REFILL_MS,
  }
}

// The 5 hour and weekly meters share one line, side by side: the 5 hour one takes two thirds of the width, the weekly
// one the rest. Any other number of meters stacks, one per line.
const SIDE_GAP = 16
// a line is taller by NOTE_H when some meter has an estimate to show under it
const NOTE_H = 14
const lineH = (rows: readonly Row[]) => ROW_H + (rows.some(r => r.note) ? NOTE_H : 0)
function layout(rows: readonly Row[], W: number): { x: number; w: number; y: number }[] {
  if (rows.length !== 2) return rows.map((_, i) => ({ x: 0, w: W, y: i * lineH(rows) }))
  const first = Math.round(((W - SIDE_GAP) * 2) / 3)
  return [
    { x: 0, w: first, y: 0 },
    { x: first + SIDE_GAP, w: W - first - SIDE_GAP, y: 0 },
  ]
}
const metersHeight = (rows: readonly Row[]) => (rows.length === 2 ? 1 : rows.length) * lineH(rows) - 6

// `moodFor`: how long ago the turn started (while busy) or ended (while not), so the field eases from where it was
function metersSvg(rows: readonly Row[], total: number, isBusy: boolean, moodFor: number, shown: Sign | null = null, now = 0) {
  const shownColour = shown ? SIGNS[shown.name]?.colour : undefined
  const tintNow = shown && shownColour && now - shown.at < TINT_MS ? { colour: shownColour, age: now - shown.at } : null
  const [from, to] = isBusy ? [QUIET, 1] : [1, QUIET]
  const easing = moodFor < EASE_MS ? `animation:mood ${EASE_MS / 1000}s ease-in-out -${(moodFor / 1000).toFixed(2)}s 1 both;` : ''
  const moodCss = `.mood{opacity:${to};${easing}}@keyframes mood{from{opacity:${from}}to{opacity:${to}}}`
  const PAD = 6 // room for the handle at 100%, so nothing is cut at the edge
  const W = total - PAD * 2
  const H = metersHeight(rows)
  const spots = layout(rows, W)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${H}" viewBox="0 0 ${total} ${H}"><style>
.ul{font:400 12px 'Anthropic Sans',ui-sans-serif,system-ui,sans-serif;fill:#fff;fill-opacity:.65}.un{font:600 13px 'Anthropic Sans',ui-sans-serif,system-ui,sans-serif;fill:#fff}
.nd,.nw{font:400 11px 'Anthropic Sans',ui-sans-serif,system-ui,sans-serif}.nd{fill:#fff;fill-opacity:.5}.nw{fill:#F0B44C}
${pixelCss()}
${moodCss}
.gh{opacity:0;animation:gh ease-in-out infinite}@keyframes gh{0%,100%{opacity:0}50%{opacity:.5}}
.cr{opacity:0;animation:cr 1.5s cubic-bezier(.2,.6,.3,1) infinite}
@keyframes cr{0%{transform:translate(0,0);opacity:0}15%{opacity:1}100%{transform:translate(-36px,var(--dy));opacity:0}}
.hl{animation:hl 1.1s ease-out infinite}@keyframes hl{0%,28%,70%,100%{fill:#fff}14%{fill:#FFD9D9}}
.sg rect{width:${SQ}px;height:${SQ}px;rx:${RX}px;opacity:0;animation:sg ${SIGN_STOP_MS / 1000}s ease-in-out both;animation-delay:calc(var(--j, 0s) + var(--o) - var(--e))}
@keyframes sg{0%{opacity:0}14%{opacity:.6}22%{opacity:1}68%{opacity:1}82%{opacity:.35}100%{opacity:0}}
.sg .fly rect{animation:fly .45s ease-out both;animation-delay:calc(var(--o) - var(--e))}
@keyframes fly{0%,100%{opacity:0}35%{opacity:.85}}
@media (prefers-reduced-motion:reduce){.px rect,.hb rect,.gh,.cr,.hl,.mood,.sg{animation:none}.gh,.cr,.sg{display:none}}
</style><defs>${defs(W)}</defs><g transform="translate(${PAD} 0)">${rows.map((r, i) => rowSvg(r, i, spots[i]?.w ?? W, isBusy, shown && (shown.kind === r.kind || (i === 0 && !rows.some(x => x.kind === shown.kind))) ? { name: shown.name, age: now - shown.at } : null, tintNow, spots[i])).join('')}</g></svg>`
}

// ---------- engine glue ----------

// when the main conversation's turn last started or ended, so the field eases between its brightnesses from there
let moodSince = 0

// the lines a window warns at as it runs low, and which of them each window has already warned at (cleared once it
// is back above); the first sounds the limit tone too
const LOW_LEFT = [20, 10]
const warned = new Set<string>()

// a window that drops below 20% or 10% left shows the warning sign once per line (the tone at 20%), not again until it
// recovers; the windows that just crossed a line are returned
function warnLow($: EngineInterface, list: readonly Limit[]): string[] {
  const crossed: string[] = []
  for (const l of list) {
    const left = 100 - l.used
    for (const line of LOW_LEFT) {
      const key = `${l.kind}:${line}`
      if (left >= line) warned.delete(key)
      else if (!warned.has(key)) {
        warned.add(key)
        if (line === LOW_LEFT[0]) play($, 'limit')
        crossed.push(l.kind)
      }
    }
  }
  return crossed
}

async function showSign($: EngineInterface, name: string, kind = 'five_hour') {
  const at = await $.clock.now()
  const fill: Sign = { name, kind, at }
  await update($, sign, () => fill)
}

// while nothing runs: the moon once after a long quiet spell, and now and then a surprise
let isMoonShown = false
async function idleSigns($: EngineInterface) {
  const now = await $.clock.now()
  if (await read($, busy)) return
  if (!isMoonShown && now - moodSince > MOON_AFTER_MS) {
    isMoonShown = true
    await showSign($, 'moon')
    return
  }
  const last = await read($, sign)
  if (last && now - last.at < SIGN_GAP_MS) return
  if (Math.random() > 0.3) return
  const five = (await read($, limits)).find(l => l.kind === 'five_hour')
  const pace = five ? paceLeft(five, now) : null
  const isOnPace = five !== undefined && (pace === null || 100 - five.used >= pace)
  const pool = SURPRISES.filter(n => n !== 'arrow' || isOnPace)
  await showSign($, pool[Math.floor(Math.random() * pool.length)] ?? 'star')
}

// the engine reports a window only after the session's first API response; until then the last reading kept
// in the store (a window that has reset since reads as unused) stands in, so the meters show from the first second
async function syncLimits($: EngineInterface, rate: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const fresh: Limit[] = rate.filter(r => r.kind in LIMIT_NAME).map(r => ({ kind: r.kind, used: r.percentUsed, resetsAt: r.resetsAt }))
  if (fresh.length > 0) {
    const crossed = warnLow($, fresh)
    const before = await read($, limits)
    const now = await $.clock.now()
    // a window that gave back most of what was used has reset: its meter fills up again once, and the person hears of it
    for (const l of fresh) {
      const was = before.find(b => b.kind === l.kind)
      if (was && was.used - l.used >= 30) {
        refilledAt.set(l.kind, now)
        $.ui.toast(`${LIMIT_NAME[l.kind] ?? l.kind} hakkı yenilendi`)
        play($, 'reset')
        await showSign($, 'heart', l.kind)
      }
    }
    if (crossed[0]) await showSign($, 'warn', crossed[0])
    record(fresh, now)
    await $.store.set('history', history)
    await update($, limits, () => fresh)
    await $.store.set('limits', fresh)

    return
  }
  if ((await read($, limits)).length > 0) return
  const saved = await $.store.get('limits')
  if (!Array.isArray(saved)) return
  const now = await $.clock.now()
  const kept: Limit[] = saved
    .filter((l): l is Limit => typeof l?.kind === 'string' && typeof l?.used === 'number' && l.kind in LIMIT_NAME)
    .map(l => (l.resetsAt && Date.parse(l.resetsAt) < now ? { kind: l.kind, used: 0 } : l))
  if (kept.length > 0) await update($, limits, () => kept)
}

// the engine's player first (afplay on macOS); PowerShell where it cannot play
function play($: EngineInterface, name: 'limit' | 'reset') {
  const file = `${$.plugin.root}/sounds/${name}.wav`.replace(/\//g, '\\')
  void $.audio.play({ asset: `sounds/${name}.wav` }).catch(() =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { timeoutMs: 5000 })
      .catch(() => undefined),
  )
}



export const register: Register = on => {
  // the main conversation's turn runs: the meters show usage being spent
  on('turn.start', async ($, e, next) => {
    moodSince = await $.clock.now()
    isMoonShown = false
    await showSign($, 'bolt')
    await update($, busy, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      moodSince = await $.clock.now()
      await showSign($, 'check')
      await update($, busy, () => false)
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('history')
    if (saved && typeof saved === 'object') history = saved as Record<string, Sample[]>
    // the first API response may come late and a window moves while idle: look again once a minute
    $.clock.every(60_000, async () => {
      await syncLimits($, (await $.session.usage()).rateLimits)
      await idleSigns($)
    })
    await syncLimits($, (await $.session.usage()).rateLimits)
    await $.command.register({ name: 'meters', description: 'Show or hide the 5 hour and weekly usage meters' })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await syncLimits($, e.rateLimits)

    return next(e)
  })

  on('command.run', { command: 'meters' }, async $ => {
    const open = await read($, isOpen)
    await update($, isOpen, () => !open)

    return { text: open ? 'Meters hidden.' : 'Meters shown.' }
  })

  // always drawn, so the person sees the mod is loaded; dim while there is nothing to show
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const count = (await read($, limits)).length
    const open = await read($, isOpen)
    const { Box, Button } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    const press = () => (count === 0 ? $.ui.toast('stride is on. The meters appear after the first reply.') : update($, isOpen, () => !open))

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="meters-toggle" dimColor={count === 0 || !open} label="Usage" onPress={press} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lim = await read($, limits)
    if (lim.length === 0 || e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const now = await $.clock.now()
    const isBusy = await read($, busy)
    // the 5 hour meter first, so it takes the wider place
    const order = (k: string) => (k === 'five_hour' ? 0 : 1)
    const rows = [...lim].sort((a, b) => order(a.kind) - order(b.kind)).map((l, i) => limitRow(l, i, now, isBusy))
    const alt = rows.map(r => `${r.name} ${r.value}${r.note ? ` (${r.note.text})` : ''}`).join('; ')
    // Desktop reports ~8 CSS px per column
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)

    return (
      <Box flexDirection="column">
        {Svg ? <Svg key="usage" source={metersSvg(rows, total, isBusy, now - moodSince, await read($, sign), now)} alt={alt} width={total} height={metersHeight(rows)} /> : <Text dimColor>{alt}</Text>}
      </Box>
    )
  })
}
