// The final four-petal logomark, inline so its ink follows `currentColor`: the
// 404 page draws it in the theme's brand orange, a workspace without a logo in
// its colourway's mark colour.
export function OkouLogomark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 138 140">
      <path
        d="M603.905 167.457C589.107 72.5824 507.091 0 408.052 0H391.948C292.909 0 210.893 72.5824 196.095 167.457C84.6763 187.186 0 284.43 0 401.5C0 518.57 84.6763 615.814 196.095 635.543C210.893 730.418 292.909 803 391.948 803H408.052C507.091 803 589.107 730.418 603.905 635.543C715.324 615.814 800 518.57 800 401.5C800 284.43 715.324 187.186 603.905 167.457ZM533.446 462.622C489.972 557.593 394.947 607.255 321.248 573.551C247.549 539.798 223.031 435.446 266.554 340.475C310.028 245.504 405.054 195.842 478.752 229.546C552.451 263.299 576.969 367.651 533.446 462.622Z"
        transform="translate(0.26 0) scale(0.17173)"
        fill="currentColor"
      />
    </svg>
  );
}
