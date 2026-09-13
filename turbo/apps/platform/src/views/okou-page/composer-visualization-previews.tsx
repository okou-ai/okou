import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { VisualizationChart } from "../../signals/okou-page/composer-visualization.ts";
import {
  FLIGHT_LINE_ARROWS,
  FLIGHT_LINE_HUB,
  FLIGHT_LINE_PATHS,
  WORD_CLOUD_TERMS,
  WORLD_COUNTRY_TIERS,
  WORLD_GRATICULE_PATH,
} from "./composer-visualization-preview-data.ts";

const PLOT = { left: 25, right: 153, top: 9, bottom: 69 } as const;
const X_LABELS = ["01", "02", "03", "04", "05", "06"] as const;
const Y_TICKS = [
  { label: "80", y: 9 },
  { label: "60", y: 24 },
  { label: "40", y: 39 },
  { label: "20", y: 54 },
  { label: "0", y: 69 },
] as const;

function CartesianFrame({
  xLabels = X_LABELS,
}: {
  readonly xLabels?: readonly string[];
}) {
  const step = (PLOT.right - PLOT.left) / Math.max(xLabels.length - 1, 1);
  return (
    <g>
      {Y_TICKS.map(({ label, y }) => {
        return (
          <g key={label}>
            <line
              x1={PLOT.left}
              x2={PLOT.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeOpacity="0.68"
              strokeWidth="0.7"
            />
            <text
              x="20"
              y={y + 2}
              textAnchor="end"
              className="fill-muted-foreground"
              fillOpacity="0.72"
              fontSize="5.5"
            >
              {label}
            </text>
          </g>
        );
      })}
      {xLabels.map((label, index) => {
        return (
          <text
            key={label}
            x={PLOT.left + index * step}
            y="79"
            textAnchor="middle"
            className="fill-muted-foreground"
            fillOpacity="0.72"
            fontSize="5.5"
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}

function SeriesLegend({ count = 2 }: { readonly count?: 2 | 3 }) {
  return (
    <g transform="translate(108 4)">
      <circle cx="0" cy="0" r="2" className="fill-chart-blue-500" />
      <line
        x1="4"
        x2="14"
        y1="0"
        y2="0"
        className="stroke-muted-foreground"
        strokeOpacity="0.55"
        strokeWidth="1.2"
      />
      <circle cx="20" cy="0" r="2" className="fill-chart-orange" />
      <line
        x1="24"
        x2="34"
        y1="0"
        y2="0"
        className="stroke-muted-foreground"
        strokeOpacity="0.55"
        strokeWidth="1.2"
      />
      {count === 3 ? (
        <circle cx="40" cy="0" r="2" className="fill-chart-green" />
      ) : null}
    </g>
  );
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function pieSlicePath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const start = polarPoint(cx, cy, radius, endAngle);
  const end = polarPoint(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M${cx} ${cy}L${start.x} ${start.y}A${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}Z`;
}

function BarChartArtwork() {
  const bars = [37, 48, 32, 55, 44, 61] as const;
  return (
    <>
      <CartesianFrame />
      {bars.map((value, index) => {
        const height = (value / 80) * 60;
        return (
          <rect
            key={value}
            x={29 + index * 21}
            y={PLOT.bottom - height}
            width="11"
            height={height}
            rx="1.5"
            className={
              index === bars.length - 1
                ? "fill-chart-blue-600"
                : "fill-chart-blue-300"
            }
          />
        );
      })}
    </>
  );
}

function LineChartArtwork() {
  return (
    <>
      <CartesianFrame />
      <SeriesLegend />
      <path
        d="M25 57C36 55 39 45 50 47S67 37 76 39 92 25 101 29 116 19 127 23 142 14 153 18"
        fill="none"
        className="stroke-chart-blue-500"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25 62C37 56 42 60 50 54S67 49 76 51 91 40 101 44 117 34 127 36 142 29 153 31"
        fill="none"
        className="stroke-chart-orange"
        strokeOpacity="0.85"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="153"
        cy="18"
        r="2.6"
        className="fill-chart-blue-500 stroke-background"
      />
    </>
  );
}

function PieChartArtwork() {
  const slices = [
    { className: "fill-chart-blue-500", end: 151, start: 0 },
    { className: "fill-chart-blue-300", end: 252, start: 154 },
    { className: "fill-chart-orange", end: 318, start: 255 },
    { className: "fill-chart-green", end: 358, start: 321 },
  ] as const;
  const legend = [
    ["42%", "fill-chart-blue-500"],
    ["28%", "fill-chart-blue-300"],
    ["18%", "fill-chart-orange"],
    ["12%", "fill-chart-green"],
  ] as const;
  return (
    <>
      {slices.map((slice) => {
        return (
          <path
            key={slice.start}
            d={pieSlicePath(54, 43, 31, slice.start, slice.end)}
            className={`${slice.className} stroke-background`}
            strokeWidth="1.5"
          />
        );
      })}
      {legend.map(([label, className], index) => {
        return (
          <g key={label} transform={`translate(103 ${24 + index * 14})`}>
            <circle cx="0" cy="0" r="3" className={className} />
            <text x="8" y="2" className="fill-muted-foreground" fontSize="6.5">
              {label}
            </text>
            <line
              x1="28"
              x2="44"
              y1="0"
              y2="0"
              className="stroke-border"
              strokeWidth="1.5"
            />
          </g>
        );
      })}
    </>
  );
}

function ScatterChartArtwork() {
  const points = [
    [30, 61],
    [38, 54],
    [47, 57],
    [55, 45],
    [67, 47],
    [76, 37],
    [87, 43],
    [97, 31],
    [109, 34],
    [119, 23],
    [132, 28],
    [143, 16],
  ] as const;
  return (
    <>
      <CartesianFrame />
      <path
        d="M28 63 146 15"
        className="stroke-chart-orange"
        strokeOpacity="0.75"
        strokeDasharray="3 3"
        strokeWidth="1.1"
      />
      {points.map(([cx, cy], index) => {
        return (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={index % 4 === 0 ? 3.2 : 2.5}
            className={
              index % 4 === 0 ? "fill-chart-orange" : "fill-chart-blue-500"
            }
            fillOpacity={index % 4 === 0 ? 0.92 : 0.72}
          />
        );
      })}
    </>
  );
}

function AreaChartArtwork() {
  return (
    <>
      <CartesianFrame />
      <SeriesLegend />
      <path
        d="M25 61C37 56 42 59 51 51S68 47 77 43 91 32 102 36 115 27 127 30 142 18 153 20V69H25Z"
        className="fill-chart-blue-500"
        fillOpacity="0.16"
      />
      <path
        d="M25 61C37 56 42 59 51 51S68 47 77 43 91 32 102 36 115 27 127 30 142 18 153 20"
        fill="none"
        className="stroke-chart-blue-500"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M25 65C38 62 43 64 51 60S68 55 77 57 91 46 102 49 115 42 127 44 142 37 153 39V69H25Z"
        className="fill-chart-orange"
        fillOpacity="0.1"
      />
      <path
        d="M25 65C38 62 43 64 51 60S68 55 77 57 91 46 102 49 115 42 127 44 142 37 153 39"
        fill="none"
        className="stroke-chart-orange"
        strokeWidth="1.4"
      />
    </>
  );
}

function StackedBarChartArtwork() {
  const bars = [
    { id: "01", values: [18, 11, 8] },
    { id: "02", values: [23, 13, 10] },
    { id: "03", values: [17, 16, 9] },
    { id: "04", values: [26, 12, 11] },
    { id: "05", values: [21, 19, 12] },
    { id: "06", values: [29, 17, 10] },
  ] as const;
  const colors = [
    "fill-chart-blue-500",
    "fill-chart-blue-200",
    "fill-chart-orange",
  ] as const;
  return (
    <>
      <CartesianFrame />
      <SeriesLegend count={3} />
      {bars.map(({ id, values }, index) => {
        let offset = 0;
        return values.map((value, segment) => {
          const y = PLOT.bottom - offset - value;
          offset += value;
          return (
            <rect
              key={`${id}-${value}`}
              x={29 + index * 21}
              y={y}
              width="11"
              height={value - 1}
              rx="1"
              className={colors[segment]}
            />
          );
        });
      })}
    </>
  );
}

function HeatmapChartArtwork() {
  const colors = [
    "fill-chart-blue-100",
    "fill-chart-blue-200",
    "fill-chart-blue-300",
    "fill-chart-blue-400",
    "fill-chart-blue-600",
  ] as const;
  return (
    <>
      {["1", "2", "3", "4", "5"].map((label, row) => {
        return (
          <text
            key={label}
            x="18"
            y={17 + row * 12}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize="5.5"
          >
            {label}
          </text>
        );
      })}
      {[0, 1, 2, 3, 4].flatMap((row) => {
        return [0, 1, 2, 3, 4, 5, 6, 7].map((column) => {
          const level = (row * 7 + column * 3 + row * column) % colors.length;
          return (
            <rect
              key={`${row}-${column}`}
              x={25 + column * 15}
              y={9 + row * 12}
              width="12"
              height="9"
              rx="1.5"
              className={colors[level]}
            />
          );
        });
      })}
      {["01", "02", "03", "04", "05", "06", "07", "08"].map((label, index) => {
        return (
          <text
            key={label}
            x={31 + index * 15}
            y="76"
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize="5.5"
          >
            {label}
          </text>
        );
      })}
      <rect
        x="119"
        y="81"
        width="8"
        height="3"
        className="fill-chart-blue-100"
      />
      <rect
        x="127"
        y="81"
        width="8"
        height="3"
        className="fill-chart-blue-300"
      />
      <rect
        x="135"
        y="81"
        width="8"
        height="3"
        className="fill-chart-blue-400"
      />
      <rect
        x="143"
        y="81"
        width="8"
        height="3"
        className="fill-chart-blue-600"
      />
    </>
  );
}

function BubbleChartArtwork() {
  const bubbles = [
    [34, 57, 5],
    [48, 43, 8],
    [65, 54, 11],
    [78, 31, 6],
    [96, 42, 9],
    [116, 24, 13],
    [137, 48, 7],
  ] as const;
  return (
    <>
      <CartesianFrame />
      {bubbles.map(([cx, cy, radius], index) => {
        return (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={radius}
            className={
              index === 5 ? "fill-chart-orange" : "fill-chart-blue-500"
            }
            fillOpacity={index === 5 ? 0.78 : 0.34 + index * 0.055}
            strokeWidth="1"
          />
        );
      })}
    </>
  );
}

function RadarChartArtwork() {
  const center = { x: 77, y: 44 } as const;
  const axes = [0, 60, 120, 180, 240, 300] as const;
  const polygon = (radius: number) => {
    return axes
      .map((angle) => {
        const point = polarPoint(center.x, center.y, radius, angle);
        return `${point.x},${point.y}`;
      })
      .join(" ");
  };
  return (
    <>
      {[12, 23, 34].map((radius) => {
        return (
          <polygon
            key={radius}
            points={polygon(radius)}
            fill="none"
            className="stroke-border"
            strokeOpacity="0.8"
            strokeWidth="0.7"
          />
        );
      })}
      {axes.map((angle) => {
        const point = polarPoint(center.x, center.y, 34, angle);
        return (
          <line
            key={angle}
            x1={center.x}
            x2={point.x}
            y1={center.y}
            y2={point.y}
            className="stroke-border"
            strokeWidth="0.7"
          />
        );
      })}
      <polygon
        points="77,14 101,30 101,58 77,68 53,58 60,34"
        className="fill-chart-blue-500 stroke-chart-blue-500"
        fillOpacity="0.15"
        strokeWidth="1.5"
      />
      <polygon
        points="77,22 94,34 107,61 77,62 48,61 58,33"
        className="fill-chart-orange stroke-chart-orange"
        fillOpacity="0.1"
        strokeWidth="1.3"
      />
      <SeriesLegend />
    </>
  );
}

function SankeyChartArtwork() {
  return (
    <>
      <path
        d="M32 21C57 21 59 28 81 28S110 17 130 17"
        fill="none"
        className="stroke-chart-blue-500"
        strokeOpacity="0.34"
        strokeWidth="14"
      />
      <path
        d="M32 53C57 53 58 42 81 42S109 56 130 56"
        fill="none"
        className="stroke-chart-blue-300"
        strokeOpacity="0.38"
        strokeWidth="18"
      />
      <path
        d="M88 31C105 31 111 37 130 37"
        fill="none"
        className="stroke-chart-orange"
        strokeOpacity="0.34"
        strokeWidth="8"
      />
      <path
        d="M88 49C105 49 111 69 130 69"
        fill="none"
        className="stroke-chart-green"
        strokeOpacity="0.34"
        strokeWidth="7"
      />
      <rect
        x="24"
        y="10"
        width="8"
        height="53"
        rx="2"
        className="fill-chart-blue-600"
      />
      <rect
        x="80"
        y="20"
        width="8"
        height="39"
        rx="2"
        className="fill-chart-blue-400"
      />
      <rect
        x="130"
        y="10"
        width="8"
        height="15"
        rx="2"
        className="fill-chart-blue-500"
      />
      <rect
        x="130"
        y="31"
        width="8"
        height="13"
        rx="2"
        className="fill-chart-orange"
      />
      <rect
        x="130"
        y="51"
        width="8"
        height="24"
        rx="2"
        className="fill-chart-green"
      />
      <text x="24" y="83" className="fill-muted-foreground" fontSize="5.5">
        100
      </text>
      <text x="80" y="83" className="fill-muted-foreground" fontSize="5.5">
        76
      </text>
      <text x="130" y="83" className="fill-muted-foreground" fontSize="5.5">
        51
      </text>
    </>
  );
}

function GanttChartArtwork() {
  const items = [
    { className: "fill-chart-blue-500", row: 0, start: 0, width: 43 },
    { className: "fill-chart-blue-300", row: 1, start: 24, width: 56 },
    { className: "fill-chart-orange", row: 2, start: 50, width: 43 },
    { className: "fill-chart-green", row: 3, start: 84, width: 39 },
  ] as const;
  return (
    <>
      {["01", "02", "03", "04", "05", "06"].map((label, index) => {
        return (
          <g key={label}>
            <line
              x1={32 + index * 23}
              x2={32 + index * 23}
              y1="13"
              y2="70"
              className="stroke-border"
              strokeOpacity="0.62"
              strokeWidth="0.7"
            />
            <text
              x={32 + index * 23}
              y="9"
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="5.5"
            >
              {label}
            </text>
          </g>
        );
      })}
      {["1", "2", "3", "4"].map((label, index) => {
        return (
          <g key={label}>
            <line
              x1="25"
              x2="153"
              y1={18 + index * 16}
              y2={18 + index * 16}
              className="stroke-border"
              strokeOpacity="0.45"
              strokeWidth="0.7"
            />
            <text
              x="18"
              y={21 + index * 16}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize="5.5"
            >
              {label}
            </text>
          </g>
        );
      })}
      {items.map((item) => {
        return (
          <rect
            key={item.row}
            x={28 + item.start}
            y={14 + item.row * 16}
            width={item.width}
            height="8"
            rx="2.5"
            className={item.className}
          />
        );
      })}
      <path
        d="M101 10V75"
        className="stroke-chart-red"
        strokeDasharray="2 2"
        strokeWidth="1"
      />
    </>
  );
}

function BarRaceChartArtwork() {
  const rows = [
    { className: "fill-chart-blue-500", label: "1", value: 92, width: 104 },
    { className: "fill-chart-orange", label: "2", value: 78, width: 85 },
    { className: "fill-chart-green", label: "3", value: 64, width: 68 },
    { className: "fill-chart-blue-300", label: "4", value: 49, width: 50 },
  ] as const;
  return (
    <>
      {rows.map((row, index) => {
        const y = 11 + index * 18;
        return (
          <g key={row.label}>
            <text
              x="20"
              y={y + 8}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize="6"
            >
              {row.label}
            </text>
            <rect
              x="26"
              y={y}
              width="120"
              height="11"
              rx="3"
              className="fill-muted"
              fillOpacity="0.55"
            />
            <rect
              x="26"
              y={y}
              width={row.width}
              height="11"
              rx="3"
              className={row.className}
            />
            <text
              x={30 + row.width}
              y={y + 8}
              className="fill-foreground"
              fontSize="6"
              fontWeight="600"
            >
              {row.value}
            </text>
          </g>
        );
      })}
      <circle cx="142" cy="82" r="4" className="fill-chart-blue-500" />
      <path d="m141 80 3 2-3 2Z" className="fill-background" />
      <text
        x="134"
        y="84"
        textAnchor="end"
        className="fill-muted-foreground"
        fontSize="5.5"
      >
        06
      </text>
    </>
  );
}

function CandlestickChartArtwork() {
  const candles = [
    { close: 49, high: 61, low: 32, open: 39 },
    { close: 42, high: 57, low: 28, open: 51 },
    { close: 56, high: 68, low: 39, open: 45 },
    { close: 38, high: 60, low: 30, open: 54 },
    { close: 62, high: 73, low: 45, open: 48 },
    { close: 67, high: 77, low: 51, open: 58 },
    { close: 54, high: 72, low: 46, open: 65 },
  ] as const;
  const y = (value: number) => {
    return PLOT.bottom - (value / 80) * 60;
  };
  return (
    <>
      <CartesianFrame xLabels={["01", "02", "03", "04", "05", "06", "07"]} />
      {candles.map((candle, index) => {
        const rising = candle.close >= candle.open;
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        const x = 31 + index * 19;
        return (
          <g key={x}>
            <line
              x1={x}
              x2={x}
              y1={y(candle.high)}
              y2={y(candle.low)}
              className={rising ? "stroke-chart-green" : "stroke-chart-red"}
              strokeWidth="1.2"
            />
            <rect
              x={x - 4}
              y={top}
              width="8"
              height={Math.max(bottom - top, 2)}
              className={rising ? "fill-chart-green" : "fill-chart-red"}
            />
          </g>
        );
      })}
      <path
        d="M31 49C47 45 60 47 69 40S91 38 107 28 129 24 145 27"
        fill="none"
        className="stroke-chart-gold"
        strokeWidth="1.2"
      />
    </>
  );
}

function FunnelChartArtwork() {
  const stages = [
    {
      className: "fill-chart-blue-600",
      label: "100%",
      points: "20,12 116,12 106,27 30,27",
    },
    {
      className: "fill-chart-blue-500",
      label: "73%",
      points: "31,31 105,31 95,46 41,46",
    },
    {
      className: "fill-chart-blue-300",
      label: "49%",
      points: "42,50 94,50 84,65 52,65",
    },
    {
      className: "fill-chart-blue-200",
      label: "28%",
      points: "53,69 83,69 76,81 60,81",
    },
  ] as const;
  return (
    <>
      {stages.map((stage, index) => {
        return (
          <g key={stage.label}>
            <polygon points={stage.points} className={stage.className} />
            <circle
              cx="129"
              cy={20 + index * 19}
              r="2.5"
              className={stage.className}
            />
            <text
              x="136"
              y={22 + index * 19}
              className="fill-muted-foreground"
              fontSize="6.5"
            >
              {stage.label}
            </text>
          </g>
        );
      })}
    </>
  );
}

function RingSegment({
  className,
  dasharray,
  dashoffset,
  radius,
  strokeWidth,
}: {
  readonly className: string;
  readonly dasharray: string;
  readonly dashoffset: number;
  readonly radius: number;
  readonly strokeWidth: number;
}) {
  return (
    <circle
      cx="62"
      cy="44"
      r={radius}
      fill="none"
      className={className}
      strokeDasharray={dasharray}
      strokeDashoffset={dashoffset}
      strokeWidth={strokeWidth}
      transform="rotate(-90 62 44)"
    />
  );
}

function NestedDonutChartArtwork() {
  return (
    <>
      <circle
        cx="62"
        cy="44"
        r="32"
        fill="none"
        className="stroke-muted"
        strokeWidth="8"
      />
      <RingSegment
        radius={32}
        strokeWidth={8}
        dasharray="116 85"
        dashoffset={0}
        className="stroke-chart-blue-500"
      />
      <RingSegment
        radius={32}
        strokeWidth={8}
        dasharray="52 149"
        dashoffset={-120}
        className="stroke-chart-orange"
      />
      <circle
        cx="62"
        cy="44"
        r="20"
        fill="none"
        className="stroke-muted"
        strokeWidth="7"
      />
      <RingSegment
        radius={20}
        strokeWidth={7}
        dasharray="72 54"
        dashoffset={0}
        className="stroke-chart-blue-300"
      />
      <RingSegment
        radius={20}
        strokeWidth={7}
        dasharray="34 92"
        dashoffset={-76}
        className="stroke-chart-green"
      />
      <text
        x="62"
        y="42"
        textAnchor="middle"
        className="fill-foreground"
        fontSize="9"
        fontWeight="700"
      >
        68%
      </text>
      <text
        x="62"
        y="51"
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize="5.5"
      >
        100
      </text>
      {[
        ["42", "fill-chart-blue-500"],
        ["26", "fill-chart-orange"],
        ["18", "fill-chart-blue-300"],
        ["14", "fill-chart-green"],
      ].map(([label, className], index) => {
        return (
          <g key={label} transform={`translate(113 ${23 + index * 14})`}>
            <circle r="2.7" className={className} />
            <text x="8" y="2" className="fill-muted-foreground" fontSize="6">
              {label}%
            </text>
          </g>
        );
      })}
    </>
  );
}

// The gallery loops one outbound arrow per curve every four seconds. The comet
// covers 14% of a curve, so its head runs 0.56s ahead of the trailing dash.
const FLIGHT_LINE_CYCLE_SECONDS = 4;
const FLIGHT_LINE_ARROW_LEAD_SECONDS = 0.56;
const FLIGHT_LINE_ARROW_HEAD = "M0 0L-3.2 1.7L-3.2-1.7Z";
const FLIGHT_LINE_RIPPLES = [0, 1, 2] as const;

function FlightLineMotion() {
  return (
    <g className="motion-reduce:hidden">
      {FLIGHT_LINE_PATHS.map((d, index) => {
        const begin =
          (-index * FLIGHT_LINE_CYCLE_SECONDS) / FLIGHT_LINE_PATHS.length;
        return (
          <g key={d}>
            <path
              d={d}
              fill="none"
              pathLength="100"
              strokeDasharray="14 86"
              className="stroke-chart-orange"
              strokeOpacity="0.55"
              strokeWidth="1.2"
              strokeLinecap="round"
            >
              <animate
                attributeName="stroke-dashoffset"
                values="100;0"
                dur={`${FLIGHT_LINE_CYCLE_SECONDS}s`}
                begin={`${begin}s`}
                repeatCount="indefinite"
              />
            </path>
            <path d={FLIGHT_LINE_ARROW_HEAD} className="fill-chart-orange">
              <animateMotion
                path={d}
                rotate="auto"
                dur={`${FLIGHT_LINE_CYCLE_SECONDS}s`}
                begin={`${begin - FLIGHT_LINE_ARROW_LEAD_SECONDS}s`}
                repeatCount="indefinite"
              />
            </path>
          </g>
        );
      })}
      {FLIGHT_LINE_RIPPLES.map((index) => {
        const begin =
          (-index * FLIGHT_LINE_CYCLE_SECONDS) / FLIGHT_LINE_RIPPLES.length;
        return (
          <circle
            key={index}
            cx={FLIGHT_LINE_HUB.x}
            cy={FLIGHT_LINE_HUB.y}
            r="2.2"
            fill="none"
            className="stroke-chart-orange"
            strokeWidth="0.7"
          >
            <animate
              attributeName="r"
              values="2.2;7.5"
              dur={`${FLIGHT_LINE_CYCLE_SECONDS}s`}
              begin={`${begin}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="stroke-opacity"
              values="0.5;0"
              dur={`${FLIGHT_LINE_CYCLE_SECONDS}s`}
              begin={`${begin}s`}
              repeatCount="indefinite"
            />
          </circle>
        );
      })}
    </g>
  );
}

function FlightLineStill() {
  return (
    <g className="hidden motion-reduce:block">
      {FLIGHT_LINE_ARROWS.map(({ angle, trail, x, y }) => {
        return (
          <g key={trail}>
            <path
              d={trail}
              fill="none"
              className="stroke-chart-orange"
              strokeOpacity="0.55"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <path
              d={FLIGHT_LINE_ARROW_HEAD}
              className="fill-chart-orange"
              transform={`translate(${x} ${y}) rotate(${angle})`}
            />
          </g>
        );
      })}
      <circle
        cx={FLIGHT_LINE_HUB.x}
        cy={FLIGHT_LINE_HUB.y}
        r="7"
        fill="none"
        className="stroke-chart-orange"
        strokeOpacity="0.22"
        strokeWidth="0.6"
      />
      <circle
        cx={FLIGHT_LINE_HUB.x}
        cy={FLIGHT_LINE_HUB.y}
        r="4.6"
        fill="none"
        className="stroke-chart-orange"
        strokeOpacity="0.45"
        strokeWidth="0.7"
      />
    </g>
  );
}

function RouteMapChartArtwork() {
  return (
    // The route preview carries no legend, so the map sits lower than in the
    // choropleth to stay vertically centred.
    <g transform="translate(0 6)">
      {WORLD_COUNTRY_TIERS.map(({ d, tone }) => {
        return (
          <path
            key={tone}
            d={d}
            className="fill-gray-300 stroke-background"
            strokeWidth="0.4"
            strokeLinejoin="round"
          />
        );
      })}
      {FLIGHT_LINE_PATHS.map((d) => {
        return (
          <path
            key={d}
            d={d}
            fill="none"
            className="stroke-chart-blue-500"
            strokeOpacity="0.5"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        );
      })}
      <FlightLineMotion />
      <FlightLineStill />
      <circle
        cx={FLIGHT_LINE_HUB.x}
        cy={FLIGHT_LINE_HUB.y}
        r="2.2"
        className="fill-chart-orange"
      />
    </g>
  );
}

function ChoroplethMapChartArtwork() {
  return (
    <>
      <path
        d={WORLD_GRATICULE_PATH}
        fill="none"
        className="stroke-border"
        strokeOpacity="0.5"
        strokeWidth="0.5"
      />
      {WORLD_COUNTRY_TIERS.map(({ d, tone }) => {
        return (
          <path
            key={tone}
            d={d}
            className={`${tone} stroke-background`}
            strokeWidth="0.3"
            strokeLinejoin="round"
          />
        );
      })}
      <g transform="translate(49 78)">
        <text
          x="-3"
          y="3"
          textAnchor="end"
          className="fill-muted-foreground"
          fontSize="5"
        >
          0
        </text>
        {WORLD_COUNTRY_TIERS.map(({ tone }, index) => {
          return (
            <rect
              key={tone}
              x={index * 8}
              y="0"
              width="8"
              height="3"
              className={tone}
            />
          );
        })}
        <text x="43" y="3" className="fill-muted-foreground" fontSize="5">
          100
        </text>
      </g>
    </>
  );
}

function WordCloudChartArtwork() {
  const { t } = useTranslation();
  const charts = t(
    ($) => {
      return $.chat.taskChips.visualization.charts;
    },
    { returnObjects: true },
  );
  return (
    <>
      {WORD_CLOUD_TERMS.map(
        ({ chart, fontSize, rotated, textLength, tone, x, y }) => {
          return (
            <text
              key={chart}
              x={x}
              y={y}
              textAnchor="middle"
              textLength={textLength}
              lengthAdjust="spacingAndGlyphs"
              className={tone}
              fontSize={fontSize}
              fontWeight="600"
              transform={rotated ? `rotate(-90 ${x} ${y})` : undefined}
            >
              {charts[chart]}
            </text>
          );
        },
      )}
    </>
  );
}

const CHART_ARTWORKS = {
  area: AreaChartArtwork,
  bar: BarChartArtwork,
  "bar-race": BarRaceChartArtwork,
  bubble: BubbleChartArtwork,
  candlestick: CandlestickChartArtwork,
  "choropleth-map": ChoroplethMapChartArtwork,
  funnel: FunnelChartArtwork,
  gantt: GanttChartArtwork,
  heatmap: HeatmapChartArtwork,
  line: LineChartArtwork,
  "nested-donut": NestedDonutChartArtwork,
  pie: PieChartArtwork,
  radar: RadarChartArtwork,
  "route-map": RouteMapChartArtwork,
  sankey: SankeyChartArtwork,
  scatter: ScatterChartArtwork,
  "stacked-bar": StackedBarChartArtwork,
  "word-cloud": WordCloudChartArtwork,
} satisfies Record<VisualizationChart, ComponentType>;

export function VisualizationChartPreview({
  chart,
}: {
  readonly chart: VisualizationChart;
}) {
  const Artwork = CHART_ARTWORKS[chart];
  return (
    <svg
      viewBox="0 0 160 90"
      className="h-full w-full"
      aria-hidden
      focusable="false"
    >
      <Artwork />
    </svg>
  );
}
