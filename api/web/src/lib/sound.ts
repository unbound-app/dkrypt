let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

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

export function vibrateCompletion(success: boolean): void {
  if (!('vibrate' in navigator)) return;
  navigator.vibrate(success ? [12, 35, 18] : [30, 45, 30]);
}
