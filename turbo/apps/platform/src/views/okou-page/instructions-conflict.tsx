import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

export function InstructionsConflict({
  loading,
  onReload,
}: {
  readonly loading: boolean;
  readonly onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="mt-4 space-y-3 text-sm">
      <p>
        {t(($) => {
          return $.myOkou.conflict;
        })}
      </p>
      <Button variant="outline" disabled={loading} onClick={onReload}>
        {t(($) => {
          return $.myOkou.reload;
        })}
      </Button>
    </div>
  );
}
