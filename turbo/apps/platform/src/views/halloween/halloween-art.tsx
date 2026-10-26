import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { halloweenStageMotion$ } from "../../signals/halloween/halloween-motion.ts";

// Artwork and stage geometry from Rebecca's approved quiz prototype.
export function HalloweenMark() {
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden="true">
      <g fill="#F6A21B">
        <ellipse cx="32" cy="13" rx="9" ry="11" />
        <ellipse cx="32" cy="51" rx="9" ry="11" />
        <ellipse cx="13" cy="32" rx="11" ry="9" />
        <ellipse cx="51" cy="32" rx="11" ry="9" />
        <ellipse
          cx="18.5"
          cy="18.5"
          rx="10"
          ry="8.5"
          transform="rotate(-45 18.5 18.5)"
        />
        <ellipse
          cx="45.5"
          cy="18.5"
          rx="10"
          ry="8.5"
          transform="rotate(45 45.5 18.5)"
        />
        <ellipse
          cx="18.5"
          cy="45.5"
          rx="10"
          ry="8.5"
          transform="rotate(45 18.5 45.5)"
        />
        <ellipse
          cx="45.5"
          cy="45.5"
          rx="10"
          ry="8.5"
          transform="rotate(-45 45.5 45.5)"
        />
      </g>
      <circle cx="32" cy="32" r="7.5" fill="#fff" />
    </svg>
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

export function HalloweenCandy() {
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden="true">
      <ellipse cx="32" cy="32" rx="14" ry="11" fill="#F6A21B" />
      <path d="M18 32 6 22v20zM46 32 58 22v20z" fill="#EFD9C0" />
      <path
        d="M22 26h20M22 32h20M22 38h20"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        opacity=".85"
      />
    </svg>
  );
}

const haunt = [
  {
    Icon: HalloweenGhost,
    position: "left-[3%] top-[22%] md:left-[7%] md:top-[19%] md:w-[95px]",
  },
  {
    Icon: HalloweenPumpkin,
    position: "right-[2%] top-[15%] md:right-[8%] md:top-[18%] md:w-[110px]",
  },
  { Icon: HalloweenCandy, position: "bottom-[16%] left-[17%] md:w-[65px]" },
  { Icon: HalloweenGhost, position: "bottom-[13%] right-[5%] md:w-20" },
  {
    Icon: HalloweenPumpkin,
    position: "left-[3%] top-[55%] hidden md:block md:w-16",
  },
  {
    Icon: HalloweenCandy,
    position: "right-[32%] top-[12%] md:right-[26%] md:top-[10%] md:w-12",
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
              "absolute h-[68px] w-[58px] opacity-[.12] saturate-[.65] md:h-[105px] md:opacity-[.16]",
              position,
            )}
          >
            <Icon />
          </div>
        );
      })}
      <div
        data-beam
        className="absolute -top-[90px] left-[9%] h-[115%] w-[170px] origin-top bg-[linear-gradient(180deg,#b9d5ff38,#618dff0a_80%,transparent)] opacity-70 blur-[6px] [clip-path:polygon(48%_0,52%_0,100%_100%,0_100%)] md:w-[270px]"
      />
      <div
        data-beam
        className="absolute -top-[90px] right-[9%] h-[115%] w-[170px] origin-top bg-[linear-gradient(180deg,#9cc6ff55,#618dff08_80%,transparent)] opacity-70 blur-[6px] [clip-path:polygon(48%_0,52%_0,100%_100%,0_100%)] md:w-[270px]"
      />
      <div
        data-beam
        className="absolute -top-[90px] left-[calc(50%-135px)] h-[115%] w-[270px] origin-top bg-[linear-gradient(180deg,#b9d5ff38,#618dff0a_80%,transparent)] opacity-[.23] blur-[6px] [clip-path:polygon(48%_0,52%_0,100%_100%,0_100%)]"
      />
      <div className="absolute left-1/2 top-[46%] h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#7aa9ff16]" />
      <div className="absolute left-1/2 top-[46%] h-[920px] w-[920px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#7aa9ff0a]" />
      <div className="absolute -bottom-[180px] -left-[15%] h-[300px] w-[130%] rounded-[50%] border-t border-[#8ab2ff3d] bg-[repeating-radial-gradient(ellipse_at_50%_0,transparent_0_55px,#6e9df329_56px_57px,transparent_58px_90px)] shadow-[0_-15px_80px_#416dff18] md:-bottom-[120px]" />
      <div className="absolute inset-x-0 top-[33%] h-40 bg-[radial-gradient(circle,#7aabff_1px,transparent_2px)] bg-[size:38px_28px] opacity-35 [mask-image:linear-gradient(90deg,#000,transparent_28%,transparent_72%,#000)]" />
    </div>
  );
}
