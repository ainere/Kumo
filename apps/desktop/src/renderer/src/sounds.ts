/**
 * Chimes for a finished turn and for an approval that waits on the user.
 * The store calls `chime` only when `prefs.sounds` is on.
 *
 * Synthesized, no audio files: each note is a struck glass, a sine
 * fundamental with a slightly detuned twin (a slow shimmer of beating), three
 * soft inharmonic partials and a faint high glint, each with a quick
 * raised-cosine attack and its own exponential decay, faded out cleanly at
 * the end. Samples are computed once per kind and sample rate, normalized to
 * a peak of exactly 1, and played through a gain of at most PEAK, so a chime
 * can never clip; at most two ring at once, so neither can two together.
 *
 *   done:     E5 then B5, a fifth up, 120ms apart (1.37s in all)
 *   approval: one D5, a little lower, softer and longer (1.40s)
 */

export type ChimeKind = "done" | "approval";

/** A note: its fundamental, when it starts, its share of the mix, how bright and how long it rings. */
interface Note {
  freq: number;
  at: number;
  level: number;
  /** Scales the upper partials' levels. */
  brightness: number;
  /** Scales every decay time. */
  ring: number;
}

/** The glass: [frequency ratio, level, decay time constant in seconds]. Ratios off the harmonic series read as glass, not a tone. */
const PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 0.42],
  [2.32, 0.2, 0.2],
  [4.25, 0.08, 0.11],
  [6.63, 0.035, 0.065],
  // The glint: high and gone almost at once.
  [9.38, 0.018, 0.035],
];
/** The fundamental's twin, this many Hz sharp, at this level: under two slow beats over the chime. */
const TWIN_HZ = 1.3;
const TWIN_LEVEL = 0.32;

const ATTACK_S = 0.004;
const FADE_S = 0.14;

const CHIMES: Record<ChimeKind, { notes: Note[]; length: number }> = {
  done: {
    notes: [
      { freq: 659.26, at: 0, level: 0.78, brightness: 1, ring: 1 },
      { freq: 987.77, at: 0.12, level: 1, brightness: 1, ring: 1 },
    ],
    length: 1.37,
  },
  approval: {
    notes: [{ freq: 587.33, at: 0, level: 1, brightness: 0.7, ring: 1.15 }],
    length: 1.4,
  },
};

/** Peak output at volume 100. Two chimes at once still stay under full scale. */
const PEAK = 0.45;
const MAX_VOICES = 2;
/** The same chime again within this long is dropped (a burst of approvals rings once). */
const REPEAT_MS = 250;

/** Volume 0–100 as gain: perceptual, so 50 sounds about half as loud, not barely quieter. */
export function chimeGain(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 0;
  return PEAK * (v / 100) ** 2;
}

const buffers = new Map<string, AudioBuffer>();

/** The chime's samples, peak-normalized to 1. */
function chimeBuffer(ctx: BaseAudioContext, kind: ChimeKind): AudioBuffer {
  const key = `${kind}@${ctx.sampleRate}`;
  const cached = buffers.get(key);
  if (cached) return cached;

  const { notes, length } = CHIMES[kind];
  const rate = ctx.sampleRate;
  const total = Math.ceil(length * rate);
  const data = new Float32Array(total);
  const nyquist = rate / 2;

  for (const note of notes) {
    const start = Math.round(note.at * rate);
    const voices: Array<[number, number, number]> = PARTIALS.map(([ratio, level, tau], i) => [
      note.freq * ratio,
      level * (i === 0 ? 1 : note.brightness),
      tau * note.ring,
    ]);
    voices.push([note.freq + TWIN_HZ, TWIN_LEVEL, PARTIALS[0][2] * note.ring]);
    for (const [freq, level, tau] of voices) {
      if (freq >= nyquist * 0.9) continue;
      const w = (2 * Math.PI * freq) / rate;
      const attack = ATTACK_S * rate;
      for (let n = 0; start + n < total; n++) {
        const t = n / rate;
        const env = Math.exp(-t / tau);
        if (env < 1e-5) break;
        const rise = n < attack ? 0.5 - 0.5 * Math.cos((Math.PI * n) / attack) : 1;
        data[start + n] += note.level * level * rise * env * Math.sin(w * n);
      }
    }
  }

  // A clean tail: a raised-cosine fade over the last FADE_S.
  const fade = Math.round(FADE_S * rate);
  for (let i = 0; i < fade; i++) data[total - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fade);

  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < total; i++) data[i] /= peak;

  const buffer = ctx.createBuffer(1, total, rate);
  buffer.copyToChannel(data, 0);
  buffers.set(key, buffer);
  return buffer;
}

/**
 * Schedule one chime on any context (a live one, or an OfflineAudioContext to
 * measure it). Returns its source, or null when the volume is 0.
 */
export function scheduleChime(
  ctx: BaseAudioContext,
  kind: ChimeKind,
  volume: number,
  when = ctx.currentTime,
  destination: AudioNode = ctx.destination
): AudioBufferSourceNode | null {
  const gain = chimeGain(volume);
  if (gain <= 0) return null;
  const source = new AudioBufferSourceNode(ctx, { buffer: chimeBuffer(ctx, kind) });
  const level = new GainNode(ctx, { gain });
  source.connect(level).connect(destination);
  source.onended = () => {
    source.disconnect();
    level.disconnect();
  };
  source.start(when);
  return source;
}

let context: AudioContext | null = null;
let voices = 0;
const lastPlayed: Partial<Record<ChimeKind, number>> = {};

export function chime(kind: ChimeKind, volume: number): void {
  try {
    if (chimeGain(volume) <= 0 || !(kind in CHIMES)) return;
    const now = performance.now();
    if (voices >= MAX_VOICES || now - (lastPlayed[kind] ?? -Infinity) < REPEAT_MS) return;
    context ??= new AudioContext({ latencyHint: "interactive" });
    if (context.state === "suspended") void context.resume().catch(() => {});
    // A hair ahead, so a context that was just resumed doesn't cut the attack.
    const source = scheduleChime(context, kind, volume, context.currentTime + 0.02);
    if (!source) return;
    lastPlayed[kind] = now;
    voices++;
    source.addEventListener("ended", () => {
      voices = Math.max(0, voices - 1);
    });
  } catch {
    // No audio device, or audio blocked: a chime is never worth an error.
  }
}
