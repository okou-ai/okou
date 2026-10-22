import { ArrowUp, Monitor, Plug, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ComputerUseChatIllustration() {
  const { t } = useTranslation();
  return (
    <svg
      viewBox="0 0 460 180"
      role="img"
      aria-label={t(($) => {
        return $.chat.computerUse.setupSteps.chatDescription;
      })}
      className="h-full w-full text-foreground"
    >
      <rect
        x="8"
        y="72"
        width="444"
        height="100"
        rx="20"
        className="fill-background stroke-border"
      />
      <Plus x={26} y={142} size={20} />
      <rect
        x="60"
        y="136"
        width="32"
        height="32"
        rx="8"
        className="fill-state-hover"
      />
      <Plug x={66} y={142} size={20} />
      <rect
        x="408"
        y="138"
        width="28"
        height="28"
        rx="8"
        className="fill-gray-200"
      />
      <ArrowUp x={412} y={142} size={20} />
      <rect
        x="58"
        y="8"
        width="338"
        height="120"
        rx="14"
        className="fill-popover stroke-border drop-shadow-sm"
      />
      <text x="78" y="34" className="fill-muted-foreground text-sm">
        {t(($) => {
          return $.chat.computerUse.yourComputer;
        })}
      </text>
      <Monitor x={78} y={55} size={20} />
      <text x="110" y="71" className="fill-foreground text-base">
        {t(($) => {
          return $.chat.computerUse.setupSteps.thisMac;
        })}
      </text>
      <rect
        x="338"
        y="54"
        width="36"
        height="22"
        rx="11"
        className="fill-primary"
      />
      <circle cx="363" cy="65" r="8" className="fill-white" />
      <Plug x={78} y={95} size={20} />
      <text x="110" y="111" className="fill-foreground text-base">
        {t(($) => {
          return $.chat.computerUse.connectMyComputer;
        })}
      </text>
    </svg>
  );
}
