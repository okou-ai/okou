// Cloudflare Access icon from Cloudflare Docs; paths unchanged (CC BY 4.0).
// https://github.com/cloudflare/cloudflare-docs/blob/4513fc9b54b7838d36cdf7f4abdb3620d8742c68/src/icons/access.svg
// https://creativecommons.org/licenses/by/4.0/
export function CloudflareAccessIcon({ size }: { readonly size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M9.2 2.698a5.3 5.3 0 0 0-5.04 3.657l-.035.11H5.1l.022-.052a4.375 4.375 0 1 1 .308 3.835l-.05-.088H4.358l.06.123q.138.297.317.575A5.303 5.303 0 1 0 9.2 2.698" />
      <path d="M9.448 7.272 7.59 5.415l-.617.617 1.08 1.083H0l.52.872h8.63zm-.013 3.941-.618-.618 1.08-1.082H1.425l-.518-.875h10.088l.298.717z" />
    </svg>
  );
}
