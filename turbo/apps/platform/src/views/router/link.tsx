import { useSet } from "ccstate-react";
import type { MouseEvent, Ref } from "react";
import {
  generateRouterPath,
  detachedNavigateTo$,
} from "../../signals/route.ts";

type PathName = Parameters<typeof generateRouterPath>[0];
type PathParams = Parameters<typeof generateRouterPath>[1];

interface NavigationOptions {
  pathParams?: PathParams;
  searchParams?: URLSearchParams;
  hash?: string;
}

function buildHref(
  path: string,
  searchParams?: URLSearchParams,
  hash?: string,
): string {
  const search = searchParams?.toString();
  const fragment = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  return `${search ? `${path}?${search}` : path}${fragment}`;
}

// ---------------------------------------------------------------------------
// Link component
// ---------------------------------------------------------------------------

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  pathname: PathName;
  options?: NavigationOptions;
  ref?: Ref<HTMLAnchorElement>;
}

export function Link({
  pathname,
  options,
  children,
  onClick,
  ref,
  ...rest
}: LinkProps) {
  const navigate = useSet(detachedNavigateTo$);
  const path = generateRouterPath(pathname, options?.pathParams);
  const href = buildHref(path, options?.searchParams, options?.hash);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    const target = e.currentTarget.target;
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      (target && target !== "_self") ||
      e.currentTarget.hasAttribute("download")
    ) {
      return;
    }

    e.preventDefault();
    navigate(pathname, options);
  };

  return (
    <a ref={ref} href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
