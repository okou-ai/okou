// Where the import prompt is run: the steps in the tool, beside the corner of
// its window that holds the control the first step names.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  ChevronDown,
  Clock,
  Code,
  Folder,
  House,
  Laptop,
  Library,
  MessageCircle,
  PanelLeft,
  Plus,
  Search,
  Shapes,
  SlidersHorizontal,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@okouai/ui";
import type { SkillImportProvider } from "../../signals/skill-import/skill-import.ts";

/**
 * Stands in for the control inside a translated step, so the sentence keeps
 * its own word order around the chip.
 */
const CONTROL_SLOT = "\u{E000}";

/** A control of the tool, drawn inline as the step names it. */
function GuideControl({
  icon: Icon,
  label,
  highlighted = false,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly highlighted?: boolean;
}) {
  return (
    <span
      className={cn(
        "mx-0.5 inline-flex items-center gap-1 whitespace-nowrap align-bottom font-medium",
        highlighted ? "text-brand-text" : "text-foreground",
      )}
    >
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

/** A translated step with the control drawn where its sentence places it. */
function withControl(text: string, control: ReactNode): ReactNode {
  const [before, after] = text.split(CONTROL_SLOT);
  return (
    <>
      {before}
      {control}
      {after}
    </>
  );
}

function GuideStep({
  index,
  children,
  note,
  action,
  detail,
}: {
  readonly index: number;
  readonly children: ReactNode;
  readonly note?: string;
  /** A control that does the step, at the end of its line. */
  readonly action?: ReactNode;
  /** Whatever the step opens beneath it. */
  readonly detail?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground",
          action ? "mt-1.5" : "mt-0.5",
        )}
        aria-hidden="true"
      >
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm leading-6 text-foreground">{children}</p>
          {action}
        </div>
        {note ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {note}
          </p>
        ) : null}
        {detail}
      </div>
    </li>
  );
}

/** The window's own traffic lights, which say "desktop app" at a glance. */
function WindowControls() {
  return (
    <span className="flex gap-1.5">
      <i className="size-[9px] rounded-full bg-[#FF5F57]" />
      <i className="size-[9px] rounded-full bg-[#FEBC2E]" />
      <i className="size-[9px] rounded-full bg-[#28C840]" />
    </span>
  );
}

/**
 * A corner of the tool's window, cropped and fading out to the right and
 * below. The scene keeps the tool's own colours literally, so it reads as
 * that app in either theme.
 */
function SceneFrame({
  className,
  children,
}: {
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative h-[176px] overflow-hidden rounded-xl border border-border max-sm:hidden",
        className,
      )}
    >
      <div className="absolute inset-0 [mask-composite:intersect] [mask-image:linear-gradient(to_right,#000_86%,transparent),linear-gradient(to_bottom,#000_78%,transparent)]">
        {children}
      </div>
    </div>
  );
}

function ClaudeNavItem({
  icon: Icon,
  label,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
}) {
  return (
    <p className="flex items-center gap-2 text-xs text-[#3D3B38]">
      <Icon size={13} className="text-[#6B6864]" />
      {label}
    </p>
  );
}

/** The Claude app's top-left corner, with the Code tab ringed. */
function ClaudeCodeScene({ className }: { readonly className?: string }) {
  const { t } = useTranslation();
  return (
    <SceneFrame className={cn("bg-[#F9F8F6]", className)}>
      <div className="flex h-full">
        <div className="w-[204px] shrink-0 border-r border-[#ECEAE6] px-3 pt-3">
          <div className="flex items-center">
            <WindowControls />
            <span className="ml-3 flex items-center gap-2 text-[#8A8782]">
              <PanelLeft size={13} />
              <ArrowLeft size={12} />
              <ArrowRight size={12} />
            </span>
            <span className="ml-auto flex items-center rounded-[7px] bg-[#EFEDE9] p-[2px]">
              <span className="relative flex h-[22px] w-6 items-center justify-center text-[#8A8782]">
                <MessageCircle size={12} />
                <i className="absolute right-1 top-[3px] size-1 rounded-full bg-[#F59E0B]" />
              </span>
              <span className="relative flex h-[22px] w-6 items-center justify-center rounded-[5px] bg-[#ffffff] text-[#2B2926] ring-2 ring-[#FFA500] ring-offset-1 ring-offset-[#EFEDE9]">
                <Code size={12} strokeWidth={2} />
              </span>
            </span>
          </div>
          <div className="mt-9 flex flex-col gap-[11px]">
            <ClaudeNavItem
              icon={Plus}
              label={t(($) => {
                return $.onboarding.sourcesFirst.skills.guide.scene.claudeNew;
              })}
            />
            <ClaudeNavItem
              icon={Folder}
              label={t(($) => {
                return $.onboarding.sourcesFirst.skills.guide.scene
                  .claudeProjects;
              })}
            />
            <ClaudeNavItem
              icon={Shapes}
              label={t(($) => {
                return $.onboarding.sourcesFirst.skills.guide.scene
                  .claudeArtifacts;
              })}
            />
            <ClaudeNavItem
              icon={SlidersHorizontal}
              label={t(($) => {
                return $.onboarding.sourcesFirst.skills.guide.scene
                  .claudeCustomize;
              })}
            />
          </div>
        </div>
        <div className="flex-1 px-3 pt-[11px] text-[#2B2926]">
          <Laptop size={13} />
        </div>
      </div>
    </SceneFrame>
  );
}

/** The Codex app's top-left corner, with New chat ringed. */
function CodexScene({ className }: { readonly className?: string }) {
  const { t } = useTranslation();

  return (
    <SceneFrame className={cn("bg-[#F3F3F3]", className)}>
      <div className="px-3 pt-3">
        <WindowControls />
      </div>
      <div className="flex h-full pt-2">
        <div className="flex w-10 shrink-0 flex-col items-center gap-2 pl-1 text-[#8C8C8C]">
          <span className="flex size-[26px] items-center justify-center rounded-md bg-[#EDEDED] text-[#1F1F1F]">
            <House size={14} />
          </span>
          <span className="flex size-[26px] items-center justify-center">
            <Clock size={14} />
          </span>
          <span className="flex size-[26px] items-center justify-center">
            <Library size={14} />
          </span>
        </div>
        <div className="w-[180px] shrink-0 rounded-tl-lg bg-[#FAFAFA] px-3 pt-2.5">
          <div className="flex items-center text-[#1F1F1F]">
            <span className="text-sm font-semibold">
              {t(($) => {
                return $.onboarding.sourcesFirst.subscription.codex;
              })}
            </span>
            <ChevronDown size={12} className="ml-0.5 text-[#8C8C8C]" />
            <span className="ml-auto flex gap-2.5 text-[#8C8C8C]">
              <Bell size={13} />
              <Search size={13} />
            </span>
          </div>
          <p className="-mx-1.5 mt-3 inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-[#1F1F1F] ring-2 ring-[#FFA500]">
            <SquarePen size={13} />
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.controls.newChat;
            })}
          </p>
          <p className="mt-3 text-[11px] text-[#9A9A9A]">
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.scene.codexProjects;
            })}
          </p>
          <p className="mt-1.5 text-[11px] text-[#BDBDBD]">
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.scene
                .codexNoProjects;
            })}
          </p>
        </div>
        <div className="flex-1 bg-[#ffffff]" />
      </div>
    </SceneFrame>
  );
}

/** The tool's own steps, numbered on from whatever the guide put first. */
function ClaudeCodeSteps({ first }: { readonly first: number }) {
  const { t } = useTranslation();
  const slot = { control: CONTROL_SLOT };

  return (
    <>
      <GuideStep
        index={first}
        note={t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.claudeCode.openAppNote;
        })}
      >
        {withControl(
          t(($) => {
            return $.onboarding.sourcesFirst.skills.guide.claudeCode.openApp;
          }, slot),
          <GuideControl
            icon={Code}
            highlighted
            label={t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.controls.codeTab;
            })}
          />,
        )}
      </GuideStep>
      <GuideStep
        index={first + 1}
        note={t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.claudeCode
            .stayLocalNote;
        })}
      >
        {withControl(
          t(($) => {
            return $.onboarding.sourcesFirst.skills.guide.claudeCode.stayLocal;
          }, slot),
          <GuideControl
            icon={Laptop}
            label={t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.controls.local;
            })}
          />,
        )}
      </GuideStep>
      <GuideStep index={first + 2}>
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.paste;
        })}
      </GuideStep>
    </>
  );
}

function CodexSteps({ first }: { readonly first: number }) {
  const { t } = useTranslation();
  const slot = { control: CONTROL_SLOT };

  return (
    <>
      <GuideStep
        index={first}
        note={t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.codex.openAppNote;
        })}
      >
        {withControl(
          t(($) => {
            return $.onboarding.sourcesFirst.skills.guide.codex.openApp;
          }, slot),
          <GuideControl
            icon={SquarePen}
            highlighted
            label={t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.controls.newChat;
            })}
          />,
        )}
      </GuideStep>
      <GuideStep index={first + 1}>
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.paste;
        })}
      </GuideStep>
      <GuideStep index={first + 2}>
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.codex.keepOpen;
        })}
      </GuideStep>
    </>
  );
}

/**
 * Both tools also offer a chat that cannot read this machine's files, so the
 * guide names the place in the tool where the prompt can do its work.
 */
export function SkillImportGuide({
  provider,
  copyStep,
  stacked = false,
  className,
}: {
  readonly provider: SkillImportProvider;
  /**
   * Leads with copying the prompt: the copy control on the step's line, and
   * whatever it opens beneath it.
   */
  readonly copyStep?: {
    readonly action: ReactNode;
    readonly detail: ReactNode;
  };
  /** The scene spans the top, with the steps in one column below it. */
  readonly stacked?: boolean;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const first = copyStep ? 2 : 1;
  const sceneClassName = stacked ? "h-[140px]" : undefined;

  return (
    <div
      className={cn(
        stacked
          ? "flex flex-col gap-5"
          : "grid items-center gap-5 sm:grid-cols-[minmax(0,1fr)_236px]",
        className,
      )}
    >
      {stacked ? (
        provider === "codex" ? (
          <CodexScene className={sceneClassName} />
        ) : (
          <ClaudeCodeScene className={sceneClassName} />
        )
      ) : null}
      <ol
        aria-label={t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.label;
        })}
        className="flex flex-col gap-4"
      >
        {copyStep ? (
          <GuideStep
            index={1}
            action={copyStep.action}
            detail={copyStep.detail}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.guide.copy;
            })}
          </GuideStep>
        ) : null}
        {provider === "codex" ? (
          <CodexSteps first={first} />
        ) : (
          <ClaudeCodeSteps first={first} />
        )}
      </ol>
      {stacked ? null : provider === "codex" ? (
        <CodexScene />
      ) : (
        <ClaudeCodeScene />
      )}
    </div>
  );
}
