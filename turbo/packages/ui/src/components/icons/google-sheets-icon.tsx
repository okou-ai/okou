import { useId, type SVGProps } from "react";

// Official mark: https://www.gstatic.com/images/branding/productlogos/sheets_2026q3/v1/web/192px.svg
export function BrandGoogleSheets({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | string }) {
  const id = useId();
  const mask = `${id}-mask`;
  const blur = `${id}-blur`;
  const pageGradient = `${id}-pageGradient`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill="none"
      viewBox="0 0 192 192"
      aria-hidden="true"
      {...props}
    >
      <path
        fill="#009954"
        d="M183.96 117.4c0 8.94 0 13.41-1.4 16.96a20 20 0 0 1-11.23 11.24c-3.55 1.4-8.02 1.4-16.97 1.4h-60.8c-8.94 0-13.41 0-16.96-1.4a20 20 0 0 1-11.23-11.24c-1.4-3.55-1.4-8.02-1.4-16.96V74.6c0-8.94 0-13.42 1.4-16.96A20 20 0 0 1 76.6 46.4C80.15 45 84.62 45 93.56 45h60.8c8.95 0 13.42 0 16.97 1.4a20 20 0 0 1 11.23 11.24c1.4 3.54 1.4 8.02 1.4 16.96z"
      />
      {/* White preserves the source alpha mask as SVG's default luminance mask. */}
      <mask
        id={mask}
        width="161"
        height="128"
        x="7"
        y="32"
        maskUnits="userSpaceOnUse"
      >
        <path
          fill="#fff"
          d="M167.96 130.4c0 8.94 0 13.41-1.4 16.96a20 20 0 0 1-11.23 11.24c-3.55 1.4-8.02 1.4-16.97 1.4H37.56c-8.94 0-13.41 0-16.96-1.4a20 20 0 0 1-11.23-11.24c-1.4-3.55-1.4-8.02-1.4-16.96V61.6c0-8.94 0-13.42 1.4-16.96A20 20 0 0 1 20.6 33.4C24.15 32 28.62 32 37.56 32h100.8c8.95 0 13.42 0 16.97 1.4a20 20 0 0 1 11.23 11.24c1.4 3.54 1.4 8.02 1.4 16.96z"
        />
      </mask>
      <g mask={`url(#${mask})`}>
        <path fill="#0ebc5f" d="M167.96 160h-160V32h160z" />
        <g filter={`url(#${blur})`}>
          <path
            fill={`url(#${pageGradient})`}
            d="M183.96 65a20 20 0 0 0-20-20h-104a20 20 0 0 0-20 20v62a20 20 0 0 0 20 20h104a20 20 0 0 0 20-20z"
          />
        </g>
      </g>
      <path
        fill="#fff"
        d="M47.96 122a6 6 0 0 1-6-6V77h-14a6 6 0 0 1 0-12h14V52a6 6 0 0 1 12 0v13h58a6 6 0 1 1 0 12h-58v39a6 6 0 0 1-6 6"
      />
      <defs>
        <linearGradient
          id={pageGradient}
          x1="61.73"
          x2="163.21"
          y1="88.31"
          y2="88.31"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0ebc5f" />
          <stop offset=".95" stopColor="#78c9ff" />
        </linearGradient>
        <filter
          id={blur}
          width="168"
          height="126"
          x="27.96"
          y="33"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur
            result="effect1_foregroundBlur_2015_872"
            stdDeviation="6"
          />
        </filter>
      </defs>
    </svg>
  );
}
