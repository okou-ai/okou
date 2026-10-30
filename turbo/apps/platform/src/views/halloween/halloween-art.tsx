import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { halloweenStageMotion$ } from "../../signals/halloween/halloween-motion.ts";

// Original campaign artwork, with restrained stage lighting around the content.
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
    position: "left-[2%] top-[21%] md:left-[9%] md:top-[23%] md:w-[76px]",
  },
  {
    Icon: HalloweenPumpkin,
    position: "right-[2%] top-[15%] md:right-[10%] md:top-[20%] md:w-[84px]",
  },
  { Icon: HalloweenCandy, position: "bottom-[18%] left-[17%] md:w-12" },
  { Icon: HalloweenGhost, position: "bottom-[17%] right-[8%] md:w-16" },
  {
    Icon: HalloweenPumpkin,
    position: "left-[5%] top-[60%] hidden md:block md:w-12",
  },
  {
    Icon: HalloweenCandy,
    position: "right-[30%] top-[13%] md:right-[28%] md:top-[13%] md:w-10",
  },
] as const;

export function HalloweenStage({
  quiet = false,
}: {
  readonly quiet?: boolean;
}) {
  const motion = useSet(halloweenStageMotion$);
  if (quiet) {
    return (
      <div
        className="pointer-events-none absolute inset-0 -z-10 hidden overflow-hidden md:block"
        aria-hidden="true"
      >
        <div className="absolute bottom-20 left-2 h-10 w-8 opacity-15">
          <HalloweenGhost />
        </div>
        <div className="absolute bottom-20 right-2 size-8 opacity-15">
          <HalloweenPumpkin />
        </div>
      </div>
    );
  }
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
      <div
        data-beam
        className="absolute -top-24 left-[12%] h-[90%] w-[180px] origin-top bg-[linear-gradient(180deg,#d8e6ff10,#7ea7dd08_60%,transparent)] blur-2xl [clip-path:polygon(40%_0,60%_0,100%_100%,0_100%)] md:w-[300px]"
      />
      <div
        data-beam
        className="absolute -top-24 right-[12%] h-[90%] w-[180px] origin-top bg-[linear-gradient(180deg,#eed7ad14,#91addf08_60%,transparent)] blur-2xl [clip-path:polygon(40%_0,60%_0,100%_100%,0_100%)] md:w-[300px]"
      />
      <div
        data-beam
        className="absolute -top-40 left-[calc(50%-200px)] h-[80%] w-[400px] origin-top bg-[linear-gradient(180deg,#e8c68d0a,transparent)] blur-3xl"
      />
      <div className="absolute left-1/2 top-[46%] h-[660px] w-[660px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#adbfdb0c]" />
      <div className="absolute left-1/2 top-[46%] h-[870px] w-[870px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#adbfdb08]" />
      <div className="absolute -bottom-[220px] -left-[15%] h-[320px] w-[130%] rounded-[50%] border-t border-[#e8c68d1a] bg-[repeating-radial-gradient(ellipse_at_50%_0,transparent_0_88px,#97b9e30c_89px_90px,transparent_91px_140px)] shadow-[0_-20px_100px_#6c9ee40a] md:-bottom-[190px]" />
      <div className="absolute left-[21%] top-[34%] size-1 rounded-full bg-[#e8c68d66] shadow-[180px_-130px_0_#e8c68d33,620px_72px_0_#e8c68d44,750px_-80px_0_#e8c68d26,90px_350px_0_#e8c68d26,550px_310px_0_#e8c68d33]" />
    </div>
  );
}
