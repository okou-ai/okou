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
                ? "fill-current opacity-100"
                : "fill-current opacity-40"
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
      <path
        d="M25 57C36 55 39 45 50 47S67 37 76 39 92 25 101 29 116 19 127 23 142 14 153 18"
        fill="none"
        className="stroke-current opacity-75"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25 62C37 56 42 60 50 54S67 49 76 51 91 40 101 44 117 34 127 36 142 29 153 31"
        fill="none"
        className="stroke-current"
        strokeOpacity="0.85"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="153"
        cy="18"
        r="2.6"
        className="fill-current opacity-75 stroke-background"
      />
    </>
  );
}

function PieChartArtwork() {
  const slices = [
    { className: "fill-current opacity-75", end: 151, start: 0 },
    { className: "fill-current opacity-40", end: 252, start: 154 },
    { className: "fill-current opacity-60", end: 318, start: 255 },
    { className: "fill-current opacity-35", end: 358, start: 321 },
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
      <path
        d="M28 63 146 15"
        className="stroke-current"
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
              index % 4 === 0
                ? "fill-current opacity-60"
                : "fill-current opacity-75"
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
      <path
        d="M25 61C37 56 42 59 51 51S68 47 77 43 91 32 102 36 115 27 127 30 142 18 153 20V69H25Z"
        className="fill-current"
        fillOpacity="0.16"
      />
      <path
        d="M25 61C37 56 42 59 51 51S68 47 77 43 91 32 102 36 115 27 127 30 142 18 153 20"
        fill="none"
        className="stroke-current opacity-75"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M25 65C38 62 43 64 51 60S68 55 77 57 91 46 102 49 115 42 127 44 142 37 153 39V69H25Z"
        className="fill-current"
        fillOpacity="0.1"
      />
      <path
        d="M25 65C38 62 43 64 51 60S68 55 77 57 91 46 102 49 115 42 127 44 142 37 153 39"
        fill="none"
        className="stroke-current opacity-60"
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
    "fill-current opacity-75",
    "fill-current opacity-25",
    "fill-current opacity-60",
  ] as const;
  return (
    <>
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
    "fill-current opacity-15",
    "fill-current opacity-25",
    "fill-current opacity-40",
    "fill-current opacity-55",
    "fill-current opacity-100",
  ] as const;
  return (
    <>
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
      {bubbles.map(([cx, cy, radius], index) => {
        return (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={radius}
            className={
              index === 5
                ? "fill-current opacity-60"
                : "fill-current opacity-75"
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
            className="stroke-current opacity-20"
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
            className="stroke-current opacity-20"
            strokeWidth="0.7"
          />
        );
      })}
      <polygon
        points="77,14 101,30 101,58 77,68 53,58 60,34"
        className="fill-current stroke-current"
        fillOpacity="0.15"
        strokeWidth="1.5"
      />
      <polygon
        points="77,22 94,34 107,61 77,62 48,61 58,33"
        className="fill-current stroke-current"
        fillOpacity="0.1"
        strokeWidth="1.3"
      />
    </>
  );
}

function SankeyChartArtwork() {
  return (
    <>
      <path
        d="M32 21C57 21 59 28 81 28S110 17 130 17"
        fill="none"
        className="stroke-current"
        strokeOpacity="0.34"
        strokeWidth="14"
      />
      <path
        d="M32 53C57 53 58 42 81 42S109 56 130 56"
        fill="none"
        className="stroke-current"
        strokeOpacity="0.38"
        strokeWidth="18"
      />
      <path
        d="M88 31C105 31 111 37 130 37"
        fill="none"
        className="stroke-current"
        strokeOpacity="0.34"
        strokeWidth="8"
      />
      <path
        d="M88 49C105 49 111 69 130 69"
        fill="none"
        className="stroke-current"
        strokeOpacity="0.34"
        strokeWidth="7"
      />
      <rect
        x="24"
        y="10"
        width="8"
        height="53"
        rx="2"
        className="fill-current opacity-100"
      />
      <rect
        x="80"
        y="20"
        width="8"
        height="39"
        rx="2"
        className="fill-current opacity-55"
      />
      <rect
        x="130"
        y="10"
        width="8"
        height="15"
        rx="2"
        className="fill-current opacity-75"
      />
      <rect
        x="130"
        y="31"
        width="8"
        height="13"
        rx="2"
        className="fill-current opacity-60"
      />
      <rect
        x="130"
        y="51"
        width="8"
        height="24"
        rx="2"
        className="fill-current opacity-35"
      />
    </>
  );
}

function GanttChartArtwork() {
  const items = [
    { className: "fill-current opacity-75", row: 0, start: 0, width: 43 },
    { className: "fill-current opacity-40", row: 1, start: 24, width: 56 },
    { className: "fill-current opacity-60", row: 2, start: 50, width: 43 },
    { className: "fill-current opacity-35", row: 3, start: 84, width: 39 },
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
              className="stroke-current opacity-20"
              strokeWidth="0.7"
            />
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
              className="stroke-current opacity-20"
              strokeWidth="0.7"
            />
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
        className="stroke-current opacity-30"
        strokeDasharray="2 2"
        strokeWidth="1"
      />
    </>
  );
}

function BarRaceChartArtwork() {
  const rows = [
    { className: "fill-current opacity-75", label: "1", value: 92, width: 104 },
    { className: "fill-current opacity-60", label: "2", value: 78, width: 85 },
    { className: "fill-current opacity-35", label: "3", value: 64, width: 68 },
    { className: "fill-current opacity-40", label: "4", value: 49, width: 50 },
  ] as const;
  return (
    <>
      {rows.map((row, index) => {
        const y = 11 + index * 18;
        return (
          <g key={row.label}>
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
          </g>
        );
      })}
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
              className={
                rising
                  ? "stroke-current opacity-35"
                  : "stroke-current opacity-30"
              }
              strokeWidth="1.2"
            />
            <rect
              x={x - 4}
              y={top}
              width="8"
              height={Math.max(bottom - top, 2)}
              className={
                rising ? "fill-current opacity-35" : "fill-current opacity-30"
              }
            />
          </g>
        );
      })}
      <path
        d="M31 49C47 45 60 47 69 40S91 38 107 28 129 24 145 27"
        fill="none"
        className="stroke-current opacity-45"
        strokeWidth="1.2"
      />
    </>
  );
}

function FunnelChartArtwork() {
  const stages = [
    {
      className: "fill-current opacity-100",
      label: "100%",
      points: "20,12 116,12 106,27 30,27",
    },
    {
      className: "fill-current opacity-75",
      label: "73%",
      points: "31,31 105,31 95,46 41,46",
    },
    {
      className: "fill-current opacity-40",
      label: "49%",
      points: "42,50 94,50 84,65 52,65",
    },
    {
      className: "fill-current opacity-25",
      label: "28%",
      points: "53,69 83,69 76,81 60,81",
    },
  ] as const;
  return (
    <>
      {stages.map((stage) => {
        return (
          <polygon
            key={stage.label}
            points={stage.points}
            className={stage.className}
          />
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
        className="stroke-current opacity-75"
      />
      <RingSegment
        radius={32}
        strokeWidth={8}
        dasharray="52 149"
        dashoffset={-120}
        className="stroke-current opacity-60"
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
        className="stroke-current opacity-40"
      />
      <RingSegment
        radius={20}
        strokeWidth={7}
        dasharray="34 92"
        dashoffset={-76}
        className="stroke-current opacity-35"
      />
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
              className="stroke-current"
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
            <path
              d={FLIGHT_LINE_ARROW_HEAD}
              className="fill-current opacity-60"
            >
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
            className="stroke-current opacity-60"
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
              className="stroke-current"
              strokeOpacity="0.55"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <path
              d={FLIGHT_LINE_ARROW_HEAD}
              className="fill-current opacity-60"
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
        className="stroke-current"
        strokeOpacity="0.22"
        strokeWidth="0.6"
      />
      <circle
        cx={FLIGHT_LINE_HUB.x}
        cy={FLIGHT_LINE_HUB.y}
        r="4.6"
        fill="none"
        className="stroke-current"
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
            className="stroke-current"
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
        className="fill-current opacity-60"
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
        className="stroke-current opacity-20"
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

/**
 * Each artwork's own content bounds, measured with `getBBox` in a browser and
 * padded by 3 units. One shared frame cannot centre them: dropping the legend
 * columns left pie, funnel and the nested donut drawn in the left half of a
 * frame that still spanned the full width, and radar never filled it at all.
 * Framing each drawing on itself centres every tile and gives the row one
 * optical weight, which a single viewBox cannot do for shapes this different.
 */
const CHART_VIEW_BOX = {
  bar: "26 20.3 122 51.8",
  line: "22 12.4 136.6 52.6",
  pie: "20 9 68 68",
  scatter: "23.8 10.5 125.2 56.7",
  area: "22 16.8 134 55.2",
  "stacked-bar": "26 10 122 61",
  heatmap: "22 6 123 63",
  bubble: "26 8 121 60",
  radar: "44.6 7 65.4 74",
  sankey: "21 7 120 71",
  gantt: "22 7 134 71",
  "bar-race": "23 8 126 71",
  candlestick: "24 8.3 128 43.8",
  funnel: "17 9 102 75",
  "nested-donut": "27 9 70 70",
  "route-map": "6 12.2 153 64",
  "choropleth-map": "1 6 158 78",
  "word-cloud": "1.8 4.9 155.1 81",
} as const satisfies Record<VisualizationChart, string>;

export function VisualizationChartPreview({
  chart,
}: {
  readonly chart: VisualizationChart;
}) {
  const Artwork = CHART_ARTWORKS[chart];
  return (
    <svg
      viewBox={CHART_VIEW_BOX[chart]}
      className="h-full w-full"
      aria-hidden
      focusable="false"
    >
      <Artwork />
    </svg>
  );
}
