import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { useSet } from "ccstate-react";
import { setConnectorsScope$ } from "../../signals/okou-page/settings/connector-directory-route.ts";
import {
  DetailPageBreadcrumbBar,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";

export function RemoteDetailPage({
  title,
  network = false,
  onBack,
  children,
}: {
  readonly title: string;
  readonly network?: boolean;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const setScope = useSet(setConnectorsScope$);
  return (
    <DetailPageShell>
      <DetailPageBreadcrumbBar>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            onBack();
            setScope("discover");
          }}
        >
          {t(($) => {
            return $.connectors.catalog.title;
          })}
        </Button>
        <ChevronRight size={14} aria-hidden />
        <Button variant="quiet" size="sm" onClick={onBack}>
          {t(($) => {
            return network
              ? $.connectors.catalog.scope.privateNetwork
              : $.connectors.catalog.scope.remoteControl;
          })}
        </Button>
        <ChevronRight size={14} aria-hidden />
        <span className="px-2 text-foreground" aria-current="page">
          {title}
        </span>
      </DetailPageBreadcrumbBar>
      <DetailPageMain constrainContent>{children}</DetailPageMain>
    </DetailPageShell>
  );
}
