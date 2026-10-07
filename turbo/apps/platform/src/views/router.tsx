import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { page$, pageCommitRef$, pageLayout$ } from "../signals/react-router.ts";
import { SidebarLayout } from "./okou-page/sidebar-layout.tsx";
import { StandaloneLayout } from "./okou-page/directed-shared.tsx";

function PageSlot() {
  const page = useGet(page$);
  const pageCommitRef = useSet(useGet(pageCommitRef$));
  // `contents` keeps the page a layout child of the surrounding shell.
  return (
    <div ref={pageCommitRef} className="contents">
      {page}
    </div>
  );
}

function LayoutHost({ children }: { children: ReactNode }) {
  const layout = useGet(pageLayout$);
  if (layout === "sidebar") {
    return <SidebarLayout>{children}</SidebarLayout>;
  }
  if (layout === "standalone") {
    return <StandaloneLayout>{children}</StandaloneLayout>;
  }
  return <>{children}</>;
}

export function Router() {
  return (
    <>
      <LayoutHost>
        <PageSlot />
      </LayoutHost>
    </>
  );
}
