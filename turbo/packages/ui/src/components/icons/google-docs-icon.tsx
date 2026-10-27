import { useId, type SVGProps } from "react";

// Official mark: https://www.gstatic.com/images/branding/productlogos/docs_2026/v2/web/192px.svg
export function BrandGoogleDocs({
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
      {/* White preserves the source alpha mask as SVG's default luminance mask. */}
      <mask
        id={mask}
        maskUnits="userSpaceOnUse"
        x="32"
        y="8"
        width="128"
        height="176"
      >
        <path
          d="M130.334 184L61.6 184C52.6565 184 48.1848 184 44.6375 182.596C39.5029 180.563 35.4374 176.497 33.4045 171.362C32 167.815 32 163.343 32 154.4L32 37.6C32 28.6565 32 24.1848 33.4045 20.6375C35.4374 15.5029 39.5029 11.4374 44.6375 9.40447C48.1848 8 52.6565 8 61.6 8L100 8L154.793 62.7933L154.793 62.7934C156.454 64.4543 157.285 65.2848 157.923 66.2239C158.845 67.5811 159.479 69.1131 159.785 70.725C159.997 71.8404 159.997 73.0264 159.995 75.3985C159.96 124.317 159.938 124.799 159.937 154.366C159.937 163.332 159.937 167.816 158.532 171.363C156.499 176.498 152.434 180.562 147.299 182.596C143.752 184 139.279 184 130.334 184Z"
          fill="#fff"
        />
      </mask>
      <g mask={`url(#${mask})`}>
        <path
          d="M159.94 184L31.9999 184L31.9999 8.00001L99.9999 8L159.999 68L159.94 184Z"
          fill="#3186FF"
        />
        <g filter={`url(#${blur})`}>
          <path
            d="M43 192H149V70.2271V20H43V192Z"
            fill={`url(#${pageGradient})`}
          />
        </g>
      </g>
      <path
        d="M154.995 62.9951C152.489 61.1143 149.375 60 146 60H112.8C105.731 60 100 54.2692 100 47.2002V8L154.995 62.9951Z"
        fill="#76BBFF"
      />
      <rect x="64.001" y="114" width="64" height="12" rx="6" fill="white" />
      <rect x="64.001" y="143" width="48" height="12" rx="6" fill="white" />
      <defs>
        <filter
          id={blur}
          x="31"
          y="8"
          width="130"
          height="196"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="BackgroundImageFix"
            result="shape"
          />
          <feGaussianBlur
            stdDeviation="6"
            result="effect1_foregroundBlur_37242_8762"
          />
        </filter>
        <linearGradient
          id={pageGradient}
          x1="96"
          y1="59.2839"
          x2="54.6124"
          y2="171.338"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.33" stopColor="#3186FF" />
          <stop offset="1" stopColor="#A9A8FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
