import { useEffect, useRef } from 'react';

type RingState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface RingProps {
  state: RingState;
  audioLevel?: number; // 0-1, microphone amplitude when listening
}

// Canvas-based ring with waveform, particles, and ripples
export default function Ring({ state, audioLevel = 0 }: RingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);
  const lastStateRef = useRef<RingState>('idle');

  interface Particle {
    angle: number;
    radius: number;
    baseRadius: number;
    speed: number;
    size: number;
    opacity: number;
    life: number;
    maxLife: number;
    vr: number; // radial velocity
  }

  interface Ripple {
    radius: number;
    maxRadius: number;
    opacity: number;
    speed: number;
  }

  // Spawn a ripple when state changes
  useEffect(() => {
    if (state !== lastStateRef.current) {
      lastStateRef.current = state;
      ripplesRef.current.push({ radius: 60, maxRadius: 140, opacity: 0.7, speed: 2.5 });
    }
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    // Spawn initial particles
    const spawnParticles = (count: number) => {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const base = 80 + Math.random() * 30;
        particlesRef.current.push({
          angle,
          radius: base,
          baseRadius: base,
          speed: 0.003 + Math.random() * 0.008,
          size: 1 + Math.random() * 2,
          opacity: 0.3 + Math.random() * 0.6,
          life: 0,
          maxLife: 180 + Math.random() * 120,
          vr: (Math.random() - 0.5) * 0.3,
        });
      }
    };
    spawnParticles(24);

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      const cx = W / 2;
      const cy = H / 2;
      const t = (timeRef.current += 1);

      ctx.clearRect(0, 0, W, H);

      // ── Colour palette per state ─────────────────────────────────
      const palette = {
        idle:      { primary: '#22d3ee', glow: '#0891b2', dim: 0.45 },
        listening: { primary: '#67e8f9', glow: '#22d3ee', dim: 0.85 },
        thinking:  { primary: '#818cf8', glow: '#6366f1', dim: 0.70 },
        speaking:  { primary: '#a5f3fc', glow: '#22d3ee', dim: 0.95 },
        error:     { primary: '#f87171', glow: '#ef4444', dim: 0.80 },
      }[state];

      // ── Ripples ──────────────────────────────────────────────────
      ripplesRef.current = ripplesRef.current.filter(r => r.opacity > 0.01);
      for (const r of ripplesRef.current) {
        ctx.beginPath();
        ctx.arc(cx, cy, r.radius, 0, Math.PI * 2);
        ctx.strokeStyle = palette.primary;
        ctx.globalAlpha = r.opacity * 0.6;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        r.radius += r.speed;
        r.opacity *= 0.96;
      }

      // ── Background glow blob ────────────────────────────────────
      const glowR = 55 + Math.sin(t * 0.03) * 8 + audioLevel * 20;
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      grd.addColorStop(0, palette.glow + '55');
      grd.addColorStop(0.5, palette.glow + '18');
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();

      // ── Outer slow-spin dashed ring ─────────────────────────────
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.004);
      ctx.strokeStyle = palette.primary + '30';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 12]);
      ctx.beginPath();
      ctx.arc(0, 0, 128, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // ── Waveform ring ────────────────────────────────────────────
      const POINTS = 128;
      const baseR = 96;
      const waveAmp = state === 'speaking' ? 14 + audioLevel * 20
                    : state === 'listening' ? 6 + audioLevel * 28
                    : state === 'thinking'  ? 5
                    : 2;
      const waveSpeed = state === 'thinking' ? 0.07 : 0.045;
      const waves    = state === 'speaking'  ? 4
                     : state === 'listening' ? 3
                     : 2;

      ctx.beginPath();
      for (let i = 0; i <= POINTS; i++) {
        const ang = (i / POINTS) * Math.PI * 2;
        const noise = Math.sin(ang * waves + t * waveSpeed)
                    + Math.sin(ang * (waves + 1) - t * waveSpeed * 0.7) * 0.5;
        const r = baseR + noise * waveAmp * palette.dim;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = palette.primary;
      ctx.lineWidth = state === 'speaking' || state === 'listening' ? 2.5 : 1.5;
      ctx.globalAlpha = palette.dim;
      ctx.shadowColor = palette.glow;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // ── Inner solid ring ─────────────────────────────────────────
      const innerPulse = state === 'speaking' || state === 'listening'
        ? Math.sin(t * 0.06) * 3
        : state === 'thinking' ? Math.sin(t * 0.08) * 2 : 0;
      ctx.beginPath();
      ctx.arc(cx, cy, 70 + innerPulse, 0, Math.PI * 2);
      ctx.strokeStyle = palette.primary;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.85;
      ctx.shadowColor = palette.glow;
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // ── Thinking arc spinner ─────────────────────────────────────
      if (state === 'thinking') {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.06);
        ctx.beginPath();
        ctx.arc(0, 0, 70, 0, Math.PI * 1.2);
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9;
        ctx.shadowColor = '#6366f1';
        ctx.shadowBlur = 16;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // ── Particles ────────────────────────────────────────────────
      // Replenish
      if (particlesRef.current.length < 20) spawnParticles(6);

      particlesRef.current = particlesRef.current.filter(p => p.life < p.maxLife);
      for (const p of particlesRef.current) {
        p.life++;
        p.angle += p.speed * (state === 'thinking' ? 1.8 : state === 'speaking' ? 1.3 : 0.7);
        p.radius = p.baseRadius + Math.sin(t * 0.04 + p.angle * 3) * 12 + audioLevel * 15;

        const fade = p.life < 20
          ? p.life / 20
          : p.life > p.maxLife - 30
          ? (p.maxLife - p.life) / 30
          : 1;

        const px = cx + Math.cos(p.angle) * p.radius;
        const py = cy + Math.sin(p.angle) * p.radius;

        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = palette.primary;
        ctx.globalAlpha = p.opacity * fade * palette.dim;
        ctx.shadowColor = palette.glow;
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      // ── Error cross ──────────────────────────────────────────────
      if (state === 'error') {
        const sz = 16;
        ctx.beginPath();
        ctx.moveTo(cx - sz, cy - sz); ctx.lineTo(cx + sz, cy + sz);
        ctx.moveTo(cx + sz, cy - sz); ctx.lineTo(cx - sz, cy + sz);
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9;
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [state, audioLevel]);

  // Label per state
  const label = {
    idle:      'Standby',
    listening: 'Listening',
    thinking:  'Processing',
    speaking:  'Speaking',
    error:     'Error',
  }[state];

  const labelColor = {
    idle:      'text-cyan-500/70',
    listening: 'text-cyan-300',
    thinking:  'text-indigo-300',
    speaking:  'text-cyan-100',
    error:     'text-red-400',
  }[state];

  return (
    <div className="relative flex items-center justify-center w-72 h-72 md:w-80 md:h-80">
      <canvas
        ref={canvasRef}
        width={320}
        height={320}
        className="absolute inset-0 w-full h-full"
      />
      {/* Text centred in the ring */}
      <div className="z-10 text-center select-none pointer-events-none">
        <h1 className="text-4xl md:text-5xl font-mono tracking-[0.35em] text-cyan-50 font-bold uppercase drop-shadow-[0_0_12px_rgba(34,211,238,0.9)]">
          Autom
        </h1>
        <p className={`text-xs mt-2 uppercase tracking-widest font-mono transition-colors duration-300 ${labelColor}`}>
          {label}
        </p>
      </div>
    </div>
  );
}
