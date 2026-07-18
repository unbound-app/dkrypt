let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

// A short two-tone chime built from plain oscillators - no binary asset to bundle/license.
export function playChime(): void {
  const audioCtx = getContext();
  if (!audioCtx) return;
  void audioCtx.resume();

  const now = audioCtx.currentTime;
  const notes = [
    { freq: 880, start: 0 },
    { freq: 1174.66, start: 0.09 },
  ];

  for (const { freq, start } of notes) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.15, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.3);
  }
}
