import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { page$, pageLayout$ } from "../signals/react-router.ts";
import { SidebarLayout } from "./okou-page/sidebar-layout.tsx";
import { StandaloneLayout } from "./okou-page/directed-shared.tsx";

function PageSlot() {
  const page = useGet(page$);
  return page ?? null;
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
