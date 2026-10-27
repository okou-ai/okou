import { useId, type SVGProps } from "react";

// Official mark: https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/web/192px.svg
export function BrandGoogleDrive({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | string }) {
  const id = useId();
  const mask = `${id}-mask`;
  const yellowGradient = `${id}-yellowGradient`;
  const blueGradient = `${id}-blueGradient`;
  const greenGradient = `${id}-greenGradient`;

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
        width="168"
        height="154"
        x="12"
        y="18"
        maskUnits="userSpaceOnUse"
      >
        <path
          fill="#fff"
          d="M63.09 37c14.626-25.333 51.193-25.334 65.819 0l45.033 78c14.626 25.334-3.657 57.001-32.91 57.001H50.967c-29.253 0-47.536-31.667-32.91-57.001z"
        />
      </mask>
      <g mask={`url(#${mask})`}>
        <path
          fill={`url(#${yellowGradient})`}
          d="M206.905 172.02h-91.888l-19.015-32.934 45.944-79.578z"
        />
        <path
          fill={`url(#${blueGradient})`}
          d="M-14.919 172.006 50.04 59.494v.002L31.032 92.422h38.02L115 172.004l-129.918.001z"
        />
        <path
          fill={`url(#${greenGradient})`}
          d="M96.007-20.085 141.954 59.5l-19.011 32.928H31.048z"
        />
      </g>
      <defs>
        <linearGradient
          id={yellowGradient}
          x1="193.6"
          x2="103.09"
          y1="165.6"
          y2="111.21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".09" stopColor="#ffe921" />
          <stop offset="1" stopColor="#fec700" />
        </linearGradient>
        <linearGradient
          id={blueGradient}
          x1="114.4"
          x2="15.53"
          y1="181.61"
          y2="121.8"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".15" stopColor="#a9a8ff" />
          <stop offset=".33" stopColor="#6d97ff" />
          <stop offset=".48" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient
          id={greenGradient}
          x1="128.88"
          x2="28.7"
          y1="37.88"
          y2="84.64"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".55" stopColor="#0ebc5f" />
          <stop offset=".85" stopColor="#78c9ff" />
        </linearGradient>
      </defs>
    </svg>
  );
}
