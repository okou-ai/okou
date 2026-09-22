import { DirectionProvider } from "@base-ui/react/direction-provider";
import { localeDirection } from "../i18n/resources.ts";
import { locale$ } from "../signals/locale.ts";
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { page$, pageLayout$ } from "../signals/react-router.ts";
import {
  appSkeletonOverlayMounted$,
  appSkeletonVisible$,
  bootstrapSkeletonActive$,
  unmountAppSkeletonOverlay$,
} from "../signals/app-skeleton.ts";
import { AppSkeleton } from "./okou-page/app-skeleton.tsx";
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

export function AppSkeletonOverlay() {
  const page = useGet(page$);
  const mounted = useGet(appSkeletonOverlayMounted$);
  const skeletonVisible = useGet(appSkeletonVisible$);
  const bootstrapSkeletonActive = useGet(bootstrapSkeletonActive$);
  const unmountAppSkeletonOverlay = useSet(unmountAppSkeletonOverlay$);
  const visible = !bootstrapSkeletonActive && (!page || skeletonVisible);

  if (!mounted || bootstrapSkeletonActive) {
    return null;
  }

  return <AppSkeleton visible={visible} onHidden={unmountAppSkeletonOverlay} />;
}

export function Router() {
  const locale = useGet(locale$);
  return (
    <DirectionProvider direction={localeDirection(locale)}>
      <LayoutHost>
        <PageSlot />
      </LayoutHost>
    </DirectionProvider>
  );
}
