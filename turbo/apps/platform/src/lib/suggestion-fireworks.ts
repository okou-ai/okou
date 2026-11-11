import { animationFrame } from "signal-timers";
import { monotonicNow } from "./time.ts";

const COLORS = ["#ec4784", "#df9b27", "#4489db", "#2a9e83", "#9856bf"] as const;
const DURATION = 1500;

interface Bloom {
  readonly x: number;
  readonly y: number;
  readonly delay: number;
  readonly radius: number;
  readonly count: number;
}

function drawStar(context: CanvasRenderingContext2D, radius: number) {
  context.beginPath();
  context.moveTo(-radius, 0);
  context.lineTo(-radius / 4, -radius / 4);
  context.lineTo(0, -radius);
  context.lineTo(radius / 4, -radius / 4);
  context.lineTo(radius, 0);
  context.lineTo(radius / 4, radius / 4);
  context.lineTo(0, radius);
  context.lineTo(-radius / 4, radius / 4);
  context.closePath();
  context.fill();
}

function makeParticles(blooms: readonly Bloom[]) {
  let seed = 5719;
  const random = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return (seed - 1) / 2_147_483_646;
  };
  return blooms.flatMap((bloom, bloomIndex) => {
    return Array.from({ length: bloom.count }, (_, index) => {
      return {
        bloom,
        angle: (index * Math.PI * 2) / bloom.count + random() * 0.14,
        delay: bloom.delay + random() * 60,
        life: 850 + random() * 220,
        radius: bloom.radius * (0.62 + random() * 0.5),
        length: 5 + random() * 5,
        width: 2 + random() * 1.9,
        kind: index % 7 === 0 ? "star" : index % 3 === 0 ? "paper" : "ray",
        color: COLORS[(index + bloomIndex) % COLORS.length],
        spin: random() * 7 - 3.5,
      };
    });
  });
}

function renderParticles(
  context: CanvasRenderingContext2D,
  particles: ReturnType<typeof makeParticles>,
  elapsed: number,
) {
  for (const particle of particles) {
    const age = (elapsed - particle.delay) / particle.life;
    if (age < 0 || age > 1) {
      continue;
    }
    const distance = 5 + (1 - Math.pow(1 - age, 3)) * particle.radius;
    const dx = Math.cos(particle.angle);
    const dy = Math.sin(particle.angle);
    context.save();
    context.translate(
      particle.bloom.x + dx * distance * 1.12,
      particle.bloom.y + dy * distance * 0.72 + age * age * 9,
    );
    context.globalAlpha = Math.min(1, age * 9) * Math.pow(1 - age, 0.65);
    context.fillStyle = particle.color;
    context.strokeStyle = particle.color;
    context.lineWidth = particle.width;
    context.lineCap = "round";
    if (particle.kind === "star") {
      drawStar(context, 3.2 + (1 - age) * 2.4);
    } else if (particle.kind === "paper") {
      context.rotate(particle.angle + particle.spin * age);
      context.fillRect(
        -particle.width / 2,
        -particle.length / 2,
        particle.width,
        particle.length,
      );
    } else {
      context.beginPath();
      context.moveTo(-dx * particle.length, -dy * particle.length * 0.72);
      context.lineTo(0, 0);
      context.stroke();
    }
    context.restore();
  }
}

/** One finite, pointer-transparent celebration owned by the home card's canvas. */
export function playSuggestionFireworks(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const context = canvas.getContext("2d");
  if (motion.matches || !context) {
    return;
  }
  const card = canvas.parentElement;
  const icon = card?.querySelector("[data-suggestion-icon]");
  const copy = card?.querySelector("[data-suggestion-copy]");
  if (!card || !icon || !copy) {
    throw new Error("Suggestion celebration is missing its card content");
  }
  const rect = canvas.getBoundingClientRect();
  const iconRect = icon.getBoundingClientRect();
  const copyRect = copy.getBoundingClientRect();
  const { width, height } = rect;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const style = getComputedStyle(card);
  const radius = Number.parseFloat(style.borderRadius);
  const accent = `hsl(${style.getPropertyValue("--brand-text")})`;
  const wash = `hsl(${style.getPropertyValue("--brand-subtle")})`;
  const safeCopy = {
    x: copyRect.left - rect.left - 6,
    y: copyRect.top - rect.top - 4,
    width: copyRect.width + 12,
    height: copyRect.height + 8,
  };
  const clearStart = Math.min(width - 24, safeCopy.x + safeCopy.width + 12);
  const clearWidth = Math.max(0, width - clearStart - 12);
  const blooms: Bloom[] = [
    {
      x: iconRect.left + iconRect.width / 2 - rect.left,
      y: height / 2,
      delay: 0,
      radius: 36,
      count: 32,
    },
  ];
  if (width > 560) {
    for (const [index, fraction] of [0.18, 0.51, 0.83].entries()) {
      blooms.push({
        x: clearStart + clearWidth * fraction,
        y: height * (index === 1 ? 0.38 : 0.58),
        delay: 60 + index * 150,
        radius: 48,
        count: 38,
      });
    }
  } else {
    for (const [index, fraction] of [0.27, 0.76].entries()) {
      blooms.push({
        x: clearStart + clearWidth * fraction,
        y: height * 0.52,
        delay: 70 + index * 230,
        radius: 34,
        count: 36,
      });
    }
  }
  const particles = makeParticles(blooms);
  const startedAt = monotonicNow();
  let finished = false;
  const stop = () => {
    finished = true;
    context.clearRect(0, 0, width, height);
    motion.removeEventListener("change", onMotionChange);
    window.removeEventListener("resize", stop);
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
    const elapsed = monotonicNow() - startedAt;
    if (elapsed >= DURATION) {
      stop();
      return;
    }
    context.clearRect(0, 0, width, height);
    context.save();
    context.beginPath();
    context.roundRect(0, 0, width, height, radius);
    context.clip();
    const highlight = Math.min(elapsed / 120, 1, (DURATION - elapsed) / 500);
    context.globalAlpha = highlight * 0.75;
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = highlight * 0.6;
    context.strokeStyle = accent;
    context.lineWidth = 1;
    context.stroke();
    const visible = new Path2D();
    visible.rect(0, 0, width, height);
    visible.rect(safeCopy.x, safeCopy.y, safeCopy.width, safeCopy.height);
    context.clip(visible, "evenodd");
    renderParticles(context, particles, elapsed);
    context.restore();
    animationFrame(drawFrame, { signal });
  };
  motion.addEventListener("change", onMotionChange);
  window.addEventListener("resize", stop, { once: true });
  signal.addEventListener("abort", stop, { once: true });
  animationFrame(drawFrame, { signal });
}
