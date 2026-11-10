import { useLastLoadable } from "ccstate-react";
import { CircleCheck, Mail } from "lucide-react";
import { Badge, buttonVariants, cn } from "@okouai/ui";
import {
  integrationCardLayout,
  type IntegrationCardLayout,
} from "./components/integration-card-layout.ts";
import { useTranslation } from "react-i18next";
import { Link } from "../router/link.tsx";
import { emailLinkStatus$ } from "../../signals/okou-page/email.ts";

export function EmailCard({ layout }: { layout: IntegrationCardLayout }) {
  const { t } = useTranslation();
  const classes = integrationCardLayout(layout);
  const status = useLastLoadable(emailLinkStatus$);
  const email = status.state === "hasData" ? status.data.emails[0] : null;
  return (
    <div data-slot="integration-card" className={classes.frame}>
      <div className={classes.header}>
        <Mail
          aria-hidden="true"
          className={cn("shrink-0 text-foreground", classes.icon)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-sm font-medium text-foreground">
            {t(($) => {
              return $.works.email.title;
            })}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {t(($) => {
              return $.works.email.description;
            })}
          </div>
        </div>
        {email ? (
          <Badge className="min-w-0 max-w-20 shrink-0 text-xs font-medium text-secondary-foreground sm:max-w-52">
            <CircleCheck className="shrink-0 text-green-600" />
            <span className="truncate">{email}</span>
          </Badge>
        ) : null}
        {status.state === "hasData" && status.data.configured ? (
          <Link
            pathname="/settings/email"
            className={buttonVariants({
              variant: "outline",
              size: "sm",
              className: "h-8 shrink-0 rounded-lg",
            })}
          >
            {t(($) => {
              return email
                ? $.works.email.manage
                : $.connectors.actions.connect;
            })}
          </Link>
        ) : (
          <span className="h-8 w-20 shrink-0" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
