import type { ReactNode } from "react";

const INK = "fill-foreground/70";
const LINE = "fill-foreground/15";
const PAPER = "fill-card stroke-surface-border";
const BLUE = "fill-[#dce8fa] dark:fill-[#33455f]";
const MINT = "fill-[#dceee5] dark:fill-[#314f43]";
const LILAC = "fill-[#e8e0f5] dark:fill-[#4a3d60]";
const PEACH = "fill-[#f4e1d3] dark:fill-[#61483b]";

function Cover({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 320 180"
      aria-hidden
      className="block size-full bg-[color-mix(in_oklab,var(--color-artifact-image)_4%,var(--color-card))]"
    >
      {children}
    </svg>
  );
}

function Avatar({
  x,
  y,
  color,
  variant = 0,
}: {
  readonly x: number;
  readonly y: number;
  readonly color: string;
  readonly variant?: number;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="23" className={color} />
      <path d="M-15 20Q-14 5 0 6Q14 5 15 20" className="fill-[#7d9286]" />
      <ellipse
        cy="-4"
        rx="8"
        ry="10"
        className={variant === 1 ? "fill-[#bf896d]" : "fill-[#e8b99b]"}
      />
      <path
        d={
          variant === 2
            ? "M-9-3Q-12-18 0-17Q12-18 10 0L5-6Q-3-5-6-10Z"
            : "M-8-6Q-9-17 1-16Q10-15 9-4Q0-13-8-6"
        }
        className="fill-[#534740]"
      />
    </g>
  );
}

function ProfileCards({ speakers = false }: { readonly speakers?: boolean }) {
  return (
    <Cover>
      {[BLUE, LILAC, MINT].map((color, index) => {
        const x = 18 + index * 98;
        return (
          <g key={color}>
            <rect
              x={x}
              y="24"
              width="88"
              height="132"
              rx="12"
              className={PAPER}
            />
            <Avatar x={x + 44} y={62} color={color} variant={index} />
            <rect
              x={x + 19}
              y="98"
              width="50"
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x={x + 27}
              y="110"
              width="34"
              height="4"
              rx="2"
              className={LINE}
            />
            {speakers ? (
              <g className="fill-[#8d7ab8] dark:fill-[#b7a4dd]">
                <rect
                  x={x + 25}
                  y="129"
                  width="38"
                  height="15"
                  rx="7.5"
                  className={LILAC}
                />
                <rect x={x + 40} y="132" width="7" height="6" rx="3" />
                <path
                  d={`M${x + 38} 136q0 7 6 7q6 0 6-7`}
                  fill="none"
                  stroke="currentColor"
                  className="text-[#8d7ab8]"
                />
              </g>
            ) : (
              <path
                d={`M${x + 18} 140l9-7 9 3 9-11 9 5 12-8`}
                fill="none"
                strokeWidth="2"
                className="stroke-[#85ad9c]"
              />
            )}
          </g>
        );
      })}
    </Cover>
  );
}

function CustomerList() {
  return (
    <Cover>
      <rect x="18" y="18" width="284" height="144" rx="12" className={PAPER} />
      {[MINT, LILAC, PEACH].map((color, index) => {
        const y = 32 + index * 42;
        return (
          <g key={color}>
            <rect
              x="31"
              y={y}
              width="29"
              height="29"
              rx="8"
              className={color}
            />
            <path
              d={`M40 ${y + 20}v-11h11v11m-7-14v14m4-14v14`}
              fill="none"
              className="stroke-foreground/40"
              strokeWidth="1.5"
            />
            <rect
              x="73"
              y={y + 4}
              width={[83, 63, 74][index]}
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x="73"
              y={y + 16}
              width="104"
              height="4"
              rx="2"
              className={LINE}
            />
            <rect
              x="231"
              y={y + 6}
              width="55"
              height="17"
              rx="8.5"
              className={MINT}
            />
            <path
              d={`M241 ${y + 14}l3 3 5-6`}
              fill="none"
              strokeWidth="1.5"
              className="stroke-[#71a18c]"
            />
            <rect
              x="255"
              y={y + 12}
              width="21"
              height="4"
              rx="2"
              className="fill-[#71a18c]"
            />
          </g>
        );
      })}
    </Cover>
  );
}

function DecisionMakers() {
  return (
    <Cover>
      <path
        d="M160 74v26M84 124v-24h152v24"
        fill="none"
        className="stroke-[#b6cbbb] dark:stroke-[#688575]"
        strokeWidth="2"
      />
      {[
        { x: 160, y: 48, color: MINT },
        { x: 84, y: 137, color: BLUE },
        { x: 236, y: 137, color: LILAC },
      ].map(({ x, y, color }, index) => {
        return (
          <g key={color}>
            <rect
              x={x - 63}
              y={y - 28}
              width="126"
              height="56"
              rx="12"
              className={PAPER}
            />
            <g transform={`translate(${x - 37} ${y}) scale(.75)`}>
              <Avatar x={0} y={0} color={color} variant={index} />
            </g>
            <rect
              x={x - 9}
              y={y - 7}
              width="51"
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x={x - 9}
              y={y + 5}
              width="33"
              height="4"
              rx="2"
              className={LINE}
            />
          </g>
        );
      })}
    </Cover>
  );
}

function Podcasts() {
  return (
    <Cover>
      {[PEACH, LILAC, MINT].map((color, index) => {
        const x = 18 + index * 98;
        return (
          <g key={color}>
            <rect
              x={x}
              y="28"
              width="88"
              height="124"
              rx="10"
              className={color}
            />
            <circle cx={x + 44} cy="77" r="24" className="fill-card/70" />
            <rect
              x={x + 39}
              y="61"
              width="10"
              height="25"
              rx="5"
              className="fill-foreground/50"
            />
            <path
              d={`M${x + 34} 78v3a10 10 0 0 0 20 0v-3m-10 13v8`}
              fill="none"
              strokeWidth="2"
              className="stroke-foreground/50"
            />
            <rect
              x={x + 16}
              y="116"
              width="56"
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x={x + 24}
              y="128"
              width="40"
              height="4"
              rx="2"
              className="fill-foreground/25"
            />
          </g>
        );
      })}
    </Cover>
  );
}

function AffiliatePrograms() {
  return (
    <Cover>
      <rect x="18" y="18" width="284" height="144" rx="12" className={PAPER} />
      {[30, 20, 15].map((value, index) => {
        const y = 34 + index * 42;
        return (
          <g key={value}>
            <rect
              x="31"
              y={y}
              width="25"
              height="25"
              rx="7"
              className={[BLUE, PEACH, LILAC][index]}
            />
            <rect
              x="68"
              y={y + 4}
              width="60"
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x="68"
              y={y + 16}
              width="40"
              height="4"
              rx="2"
              className={LINE}
            />
            <rect
              x="151"
              y={y + 9}
              width="99"
              height="8"
              rx="4"
              className={MINT}
            />
            <rect
              x="151"
              y={y + 9}
              width={value * 3}
              height="8"
              rx="4"
              className="fill-[#8ab6a2]"
            />
            <text
              x="286"
              y={y + 18}
              textAnchor="end"
              fontSize="11"
              className="fill-muted-foreground"
            >
              {value}%
            </text>
          </g>
        );
      })}
    </Cover>
  );
}

function Traffic() {
  return (
    <Cover>
      <rect x="18" y="18" width="284" height="144" rx="12" className={PAPER} />
      {[54, 82, 110].map((y) => {
        return (
          <path key={y} d={`M34 ${y}H286`} className="stroke-foreground/10" />
        );
      })}
      <path
        d="M34 120l28-8 28 3 28-17 28 4 28-21 28 3 28-22 28 5 28-21v84H34Z"
        className="fill-[#9bc3af]/15"
      />
      <g
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          d="M34 120l28-8 28 3 28-17 28 4 28-21 28 3 28-22 28 5 28-21"
          className="stroke-[#76a590]"
        />
        <path
          d="M34 124l28-4 28 3 28-10 28 3 28-9 28 2 28-8 28 3 28-12"
          className="stroke-[#a693c9]"
        />
        <path
          d="M34 116l28-9 28 3 28-14 28 1 28-10 28 5 28-4 28-7 28 3"
          className="stroke-[#d1ad7b]"
        />
      </g>
      {["fill-[#76a590]", "fill-[#a693c9]", "fill-[#d1ad7b]"].map(
        (color, index) => {
          return (
            <g key={color}>
              <circle cx={39 + index * 87} cy="145" r="3" className={color} />
              <rect
                x={48 + index * 87}
                y="143"
                width="50"
                height="4"
                rx="2"
                className={LINE}
              />
            </g>
          );
        },
      )}
    </Cover>
  );
}

function SearchOpportunities() {
  return (
    <Cover>
      <rect x="18" y="18" width="284" height="144" rx="12" className={PAPER} />
      <circle
        cx="39"
        cy="38"
        r="5"
        fill="none"
        className="stroke-foreground/50"
        strokeWidth="1.5"
      />
      <path d="M43 42l5 5" className="stroke-foreground/50" strokeWidth="1.5" />
      <rect x="59" y="35" width="107" height="5" rx="2.5" className={LINE} />
      {[98, 74, 48].map((width, index) => {
        const y = 69 + index * 31;
        return (
          <g key={width}>
            <rect
              x="34"
              y={y}
              width={96 - index * 9}
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x="149"
              y={y - 2}
              width="105"
              height="9"
              rx="4.5"
              className={LILAC}
            />
            <rect
              x="149"
              y={y - 2}
              width={width}
              height="9"
              rx="4.5"
              className="fill-[#b4a0d4]"
            />
            <text
              x="286"
              y={y + 6}
              textAnchor="end"
              fontSize="10"
              className="fill-muted-foreground"
            >
              {["12k", "8.1k", "3.4k"][index]}
            </text>
          </g>
        );
      })}
    </Cover>
  );
}

function AdCreatives() {
  return (
    <Cover>
      <rect x="18" y="24" width="88" height="132" rx="10" className={PEACH} />
      <rect x="116" y="24" width="88" height="132" rx="10" className={MINT} />
      <rect x="214" y="24" width="88" height="132" rx="10" className={LILAC} />
      <circle cx="48" cy="60" r="16" className="fill-[#c29b7b]" />
      <path
        d="M31 80h52m-52 8h32"
        strokeWidth="2"
        className="stroke-[#a88365]"
      />
      <path d="M63 143v-21a18 18 0 0 1 36 0v21Z" className="fill-[#c29b7b]" />
      <circle
        cx="160"
        cy="71"
        r="27"
        fill="none"
        strokeWidth="1.5"
        className="stroke-[#83a693]"
      />
      <path d="M134 70h52m-26-26v54" className="stroke-[#83a693]" />
      <path
        d="M252 44l10 24 24 10-24 10-10 24-10-24-24-10 24-10Z"
        className="fill-[#ab96cd]"
      />
      {[31, 129, 227].map((x) => {
        return (
          <g key={x}>
            <rect
              x={x}
              y="120"
              width="39"
              height="4"
              rx="2"
              className="fill-foreground/45"
            />
            <rect
              x={x}
              y="130"
              width="26"
              height="3"
              rx="1.5"
              className="fill-foreground/25"
            />
          </g>
        );
      })}
    </Cover>
  );
}

function Products() {
  return (
    <Cover>
      {[MINT, PEACH, LILAC].map((color, index) => {
        const x = 62 + index * 98;
        const y = [57, 37, 49][index]!;
        return (
          <g key={color}>
            <ellipse
              cx={x}
              cy="124"
              rx="25"
              ry="5"
              className="fill-foreground/5"
            />
            <rect
              x={x - 9}
              y={y - 10}
              width="18"
              height="18"
              rx="4"
              className="fill-foreground/25"
            />
            <rect
              x={x - 18}
              y={y}
              width="36"
              height={121 - y}
              rx="11"
              className={color}
            />
            <path
              d={`M${x - 10} ${y + 14}v${92 - y}`}
              strokeWidth="3"
              strokeLinecap="round"
              className="stroke-card/50"
            />
            <text
              x={x}
              y="148"
              textAnchor="middle"
              fontSize="12"
              className={INK}
            >
              {["$28", "$32", "$24"][index]}
            </text>
            <rect
              x={x - 18}
              y="157"
              width="36"
              height="3"
              rx="1.5"
              className={LINE}
            />
          </g>
        );
      })}
    </Cover>
  );
}

function Sources() {
  return (
    <Cover>
      <rect x="20" y="18" width="280" height="144" rx="12" className={PAPER} />
      {[BLUE, PEACH, MINT].map((color, index) => {
        const y = 33 + index * 42;
        return (
          <g key={color}>
            <rect
              x="34"
              y={y}
              width="39"
              height="29"
              rx="5"
              className={color}
            />
            <text
              x="53.5"
              y={y + 20}
              textAnchor="middle"
              fontSize="14"
              fontFamily="Georgia, serif"
              className="fill-foreground/50"
            >
              {index + 1}
            </text>
            <rect
              x="86"
              y={y + 3}
              width={[151, 118, 137][index]}
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x="86"
              y={y + 15}
              width="174"
              height="4"
              rx="2"
              className={LINE}
            />
            <rect
              x="86"
              y={y + 24}
              width="89"
              height="3"
              rx="1.5"
              className={LINE}
            />
          </g>
        );
      })}
    </Cover>
  );
}

function ToolComparison() {
  return (
    <Cover>
      <rect x="18" y="18" width="284" height="144" rx="12" className={PAPER} />
      {[BLUE, LILAC, MINT].map((color, index) => {
        const y = 33 + index * 43;
        return (
          <g key={color}>
            <rect
              x="32"
              y={y}
              width="28"
              height="28"
              rx="8"
              className={color}
            />
            <rect
              x="71"
              y={y + 6}
              width="64"
              height="5"
              rx="2.5"
              className={INK}
            />
            <rect
              x="71"
              y={y + 18}
              width="40"
              height="4"
              rx="2"
              className={LINE}
            />
            <text
              x="192"
              y={y + 18}
              textAnchor="end"
              fontSize="11"
              className="fill-muted-foreground"
            >
              {["$29", "$45", "$18"][index]}
            </text>
            {[0, 1, 2, 3].map((dot) => {
              return (
                <circle
                  key={dot}
                  cx={215 + dot * 17}
                  cy={y + 13}
                  r="5"
                  className={
                    dot < [3, 4, 2][index]!
                      ? "fill-[#92b7a7]"
                      : "fill-foreground/10"
                  }
                />
              );
            })}
          </g>
        );
      })}
    </Cover>
  );
}

export const PEOPLE_SUGGESTION_COVERS = [
  { id: "customers", Preview: CustomerList },
  { id: "creators", Preview: ProfileCards },
  { id: "decisionMakers", Preview: DecisionMakers },
  {
    id: "speakers",
    Preview: () => {
      return <ProfileCards speakers />;
    },
  },
  { id: "podcasts", Preview: Podcasts },
  { id: "affiliates", Preview: AffiliatePrograms },
] as const;

export const RESEARCH_SUGGESTION_COVERS = [
  { id: "traffic", Preview: Traffic },
  { id: "searchOpportunities", Preview: SearchOpportunities },
  { id: "ads", Preview: AdCreatives },
  { id: "products", Preview: Products },
  { id: "topic", Preview: Sources },
  { id: "tools", Preview: ToolComparison },
] as const;
