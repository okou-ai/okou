import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { halloweenStageMotion$ } from "../../signals/halloween/halloween-motion.ts";

// Exact four-petal path from Rudy's final October 9 brand kit.
export function HalloweenMark() {
  return (
    <svg viewBox="0 0 800 803" className="h-full w-full" aria-hidden="true">
      <path
        d="M603.905 167.457C589.107 72.5824 507.091 0 408.052 0H391.948C292.909 0 210.893 72.5824 196.095 167.457C84.6763 187.186 0 284.43 0 401.5C0 518.57 84.6763 615.814 196.095 635.543C210.893 730.418 292.909 803 391.948 803H408.052C507.091 803 589.107 730.418 603.905 635.543C715.324 615.814 800 518.57 800 401.5C800 284.43 715.324 187.186 603.905 167.457ZM533.446 462.622C489.972 557.593 394.947 607.255 321.248 573.551C247.549 539.798 223.031 435.446 266.554 340.475C310.028 245.504 405.054 195.842 478.752 229.546C552.451 263.299 576.969 367.651 533.446 462.622Z"
        fill="currentColor"
      />
    </svg>
  );
}

// Official illustrations retain their original pose, proportions and palette.
const hostArt = platformStaticAssetUrl(
  "views/halloween/assets/okou-host-20d3b8ef1be2.webp",
);
const doodleArt = platformStaticAssetUrl(
  "views/halloween/assets/okou-zigzag-e39bf12f5a55.webp",
);
const taskArt = [
  platformStaticAssetUrl("views/halloween/assets/okou-paint-50a18528935f.webp"),
  platformStaticAssetUrl(
    "views/okou-page/assets/get-started-slack-12b969d9d2a7.png",
  ),
  platformStaticAssetUrl(
    "views/okou-page/assets/get-started-prompt-39ad0cd9e05f.png",
  ),
] as const;

export function HalloweenHost({ className }: { readonly className: string }) {
  return <img src={hostArt} alt="" aria-hidden className={className} />;
}

export function HalloweenTaskArt({ index }: { readonly index: number }) {
  return (
    <img
      src={taskArt[index]}
      alt=""
      aria-hidden
      className="h-20 w-20 shrink-0 object-contain md:h-[124px] md:w-full"
    />
  );
}

export function HalloweenHeroArt() {
  return (
    <div
      className="relative order-first mx-auto flex h-[192px] w-full max-w-[420px] items-center justify-center overflow-hidden rounded-3xl bg-[#FAF5F3] md:order-last md:h-[440px] md:rounded-[32px]"
      aria-hidden
    >
      <img
        src={doodleArt}
        alt=""
        className="absolute inset-x-0 bottom-0 h-12 w-full bg-[#F9E840] object-cover md:h-20"
      />
      <div className="absolute left-5 top-5 size-8 text-[#FFA500] md:left-7 md:top-7">
        <HalloweenMark />
      </div>
      <HalloweenHost className="relative h-[164px] w-auto max-w-[70%] object-contain md:h-[332px] md:max-w-[82%]" />
      <div className="absolute bottom-8 left-5 h-14 w-12 -rotate-12 md:bottom-14 md:left-6 md:h-20 md:w-[72px]">
        <HalloweenPumpkin />
      </div>
    </div>
  );
}

export function HalloweenGhost() {
  return (
    <svg viewBox="0 0 120 130" className="h-full w-full" aria-hidden="true">
      <g fill="#F8F7F3" stroke="#E7E4DD" strokeWidth="2">
        <ellipse cx="13" cy="76" rx="8" ry="6" />
        <ellipse cx="107" cy="76" rx="8" ry="6" />
        <path
          d="M22 60c0-25 16-44 38-44s38 19 38 44v54l-10-8-9 9-9-9-10 9-9-9-9 9-10-8z"
          strokeLinejoin="round"
        />
      </g>
      <g fill="#2C2D33">
        <ellipse cx="47" cy="58" rx="5.5" ry="7.5" />
        <ellipse cx="73" cy="58" rx="5.5" ry="7.5" />
      </g>
      <g fill="#F0DAD1">
        <ellipse cx="35" cy="73" rx="6" ry="3.6" />
        <ellipse cx="85" cy="73" rx="6" ry="3.6" />
      </g>
    </svg>
  );
}

export function HalloweenPumpkin() {
  return (
    <svg viewBox="0 0 120 120" className="h-full w-full" aria-hidden="true">
      <path
        d="M60 30c-3-9 3-16 12-19"
        stroke="#6E8B3D"
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="60" cy="74" rx="44" ry="36" fill="#F0A126" />
      <ellipse cx="60" cy="74" rx="29" ry="35" fill="#F7AC38" />
      <ellipse cx="60" cy="74" rx="13" ry="34" fill="#FBB653" />
      <path
        d="M37 66l9-13 9 13zM65 66l9-13 9 13zM38 82q22 17 44 0-22 9-44 0z"
        fill="#2C2D33"
      />
    </svg>
  );
}

const haunt = [
  {
    Icon: HalloweenGhost,
    position: "bottom-[12%] left-[2%] md:left-[3%] md:w-[76px]",
  },
  {
    Icon: HalloweenPumpkin,
    position: "right-[2%] top-[15%] md:right-[4%] md:top-[15%] md:w-[84px]",
  },
] as const;

export function HalloweenStage() {
  const motion = useSet(halloweenStageMotion$);
  return (
    <div
      ref={motion}
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {haunt.map(({ Icon, position }) => {
        return (
          <div
            key={position}
            data-haunt
            className={cn(
              "absolute h-16 w-12 opacity-[.13] saturate-[.35] md:h-[84px] md:opacity-[.18]",
              position,
            )}
          >
            <Icon />
          </div>
        );
      })}
      <div className="absolute -bottom-20 -right-20 size-[340px] text-[#B4DEF5] opacity-[.025] md:size-[500px]">
        <HalloweenMark />
      </div>
    </div>
  );
}
