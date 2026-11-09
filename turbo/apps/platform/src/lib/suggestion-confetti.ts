import { animationFrame } from "signal-timers";
import { monotonicNow } from "./time.ts";

type Color = readonly [number, number, number];
const CONFETTI_COLORS: readonly Color[] = [
  [230, 169, 37],
  [214, 70, 93],
  [53, 125, 199],
  [39, 164, 143],
  [133, 90, 185],
  [235, 128, 62],
  [206, 84, 145],
];

interface Particle {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly start: number;
  readonly dragX: number;
  readonly dragY: number;
  readonly gravity: number;
  readonly width: number;
  readonly height: number;
  readonly phase: number;
  readonly flip: number;
  readonly spin: number;
  readonly angle: number;
  readonly flutter: number;
  readonly wind: number;
  readonly life: number;
  readonly depth: number;
  readonly color: Color;
  readonly ribbon: boolean;
  readonly metallic: boolean;
}
function randomGenerator(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d_2b_79_f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeParticles(): Particle[] {
  const random = randomGenerator(54_129);
  const range = (min: number, max: number) => {
    return min + random() * (max - min);
  };
  const normal = () => {
    return (
      Math.sqrt(-2 * Math.log(Math.max(0.0001, random()))) *
      Math.cos(2 * Math.PI * random())
    );
  };
  const count = 1050;
  return Array.from({ length: count }, (_, index): Particle => {
    const side = index % 2 === 0 ? 1 : -1;
    const depth = range(0.55, 1.2);
    const ribbon = random() < 0.065;
    const trail = random() < 0.22;
    const angle =
      (Math.max(12, Math.min(84, (side === 1 ? 52 : 49) + normal() * 16)) *
        Math.PI) /
      180;
    const speed = trail
      ? range(90, 590)
      : Math.max(380, Math.min(1280, 845 + normal() * 195));
    const dragY = range(1.45, 2.8) + (ribbon ? 0.35 : 0);
    return {
      x: (side === 1 ? 7 : 633) + range(-2, 2),
      y: range(330, 336),
      vx: side * Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,
      start: range(0.025, trail ? 0.27 : 0.17) + (side === -1 ? 0.015 : 0),
      dragX: range(1.25, 2.15),
      dragY,
      gravity: range(280, 380),
      width: (ribbon ? range(1.5, 2.5) : range(2.5, 5.5)) * depth,
      height: (ribbon ? range(18, 32) : range(5, 10.5)) * depth,
      phase: range(0, Math.PI * 2),
      flip: range(3.6, 9.2),
      spin: range(-5, 5),
      angle: range(0, Math.PI * 2),
      flutter: range(2, 9),
      wind: range(-7, 7),
      life: range(3.6, 4.85),
      color: CONFETTI_COLORS[Math.floor(random() * CONFETTI_COLORS.length)],
      depth,
      ribbon,
      metallic: random() < 0.18,
    };
  }).sort((a, b) => {
    return a.depth - b.depth;
  });
}

function tint(color: Color, brightness: number, back: boolean) {
  return `rgb(${color
    .map((value) => {
      return Math.round(
        Math.min(255, value * brightness + (back ? (255 - value) * 0.27 : 0)),
      );
    })
    .join(",")})`;
}

function drawPaper(
  context: CanvasRenderingContext2D,
  particle: Particle,
  age: number,
) {
  const tilt = Math.cos(particle.phase + age * particle.flip);
  const width = particle.width * (0.12 + Math.abs(tilt) * 0.88);
  const height = particle.height;
  const shear =
    Math.sin(particle.phase + age * particle.flip * 0.63) * width * 0.35;
  const brightness = particle.metallic
    ? 0.7 + Math.abs(tilt) * 0.55
    : 0.8 + Math.abs(tilt) * 0.22;
  context.fillStyle = tint(particle.color, brightness, tilt < 0);
  context.beginPath();
  context.moveTo(-width / 2 + shear, -height / 2);
  context.lineTo(width / 2 + shear, -height / 2);
  context.lineTo(width / 2 - shear, height / 2);
  context.lineTo(-width / 2 - shear, height / 2);
  context.closePath();
  context.fill();
  if (particle.metallic && Math.abs(tilt) > 0.6) {
    context.strokeStyle = "rgba(255,255,255,0.4)";
    context.lineWidth = 0.45;
    context.beginPath();
    context.moveTo(-width / 2 + shear, -height / 2);
    context.lineTo(width / 2 + shear, -height / 2);
    context.stroke();
  }
}

function drawRibbon(
  context: CanvasRenderingContext2D,
  particle: Particle,
  age: number,
) {
  const segments = 9;
  for (let index = 0; index < segments; index++) {
    const t = index / segments;
    const next = (index + 1) / segments;
    const phase = particle.phase + age * particle.flip * 0.7;
    const fold = Math.cos(phase + t * Math.PI * 2);
    const width = particle.width * (0.18 + Math.abs(fold) * 0.82);
    const x = Math.sin(phase + t * 5) * 2.2;
    const nextX = Math.sin(phase + next * 5) * 2.2;
    context.fillStyle = tint(
      particle.color,
      0.72 + Math.abs(fold) * 0.36,
      fold < 0,
    );
    context.beginPath();
    context.moveTo(x - width / 2, (t - 0.5) * particle.height);
    context.lineTo(x + width / 2, (t - 0.5) * particle.height);
    context.lineTo(nextX + width / 2, (next - 0.5) * particle.height);
    context.lineTo(nextX - width / 2, (next - 0.5) * particle.height);
    context.closePath();
    context.fill();
  }
}

function render(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  particles: readonly Particle[],
  time: number,
) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(canvas.width / 640, canvas.height / 360);
  for (const particle of particles) {
    const age = time - particle.start;
    if (age < 0 || age >= particle.life) {
      continue;
    }
    // Gravity plus air resistance, with independently varied paper weight/drag.
    const terminalSpeed = particle.gravity / particle.dragY;
    const x =
      particle.x +
      (particle.vx * (1 - Math.exp(-particle.dragX * age))) / particle.dragX +
      particle.wind * age +
      (Math.sin(particle.phase + age * 3.4) - Math.sin(particle.phase)) *
        particle.flutter *
        Math.min(1, age);
    const y =
      particle.y +
      ((particle.vy - terminalSpeed) * (1 - Math.exp(-particle.dragY * age))) /
        particle.dragY +
      terminalSpeed * age;
    if (x < -35 || x > 675 || y > 395 || y < -45) {
      continue;
    }
    const fade = Math.min(1, age / 0.025, (particle.life - age) / 0.65);
    context.save();
    context.globalAlpha = fade * Math.min(1, 0.85 + 0.12 * particle.depth);
    context.translate(x, y);
    const spin = particle.spin * ((1 - Math.exp(-age * 2)) / 2 + age * 0.28);
    context.rotate(particle.angle + spin);
    if (particle.ribbon) {
      drawRibbon(context, particle, age);
    } else {
      drawPaper(context, particle, age);
    }
    context.restore();
  }
  context.restore();
}

/** One finite decorative burst, owned by the mounted completion canvas. */
export function playSuggestionConfetti(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const particles = makeParticles();
  const startedAt = monotonicNow();
  let finished = false;
  const stop = () => {
    finished = true;
    context.clearRect(0, 0, canvas.width, canvas.height);
    motion.removeEventListener("change", onMotionChange);
    signal.removeEventListener("abort", stop);
  };
  const onMotionChange = () => {
    if (motion.matches) {
      stop();
    }
  };
  const drawFrame = () => {
    if (finished || signal.aborted) {
      return;
    }
    const elapsed = (monotonicNow() - startedAt) / 1000;
    if (elapsed >= 5.2) {
      stop();
      return;
    }
    render(context, canvas, particles, elapsed);
    animationFrame(drawFrame, { signal });
  };
  motion.addEventListener("change", onMotionChange);
  signal.addEventListener("abort", stop, { once: true });
  animationFrame(drawFrame, { signal });
}
