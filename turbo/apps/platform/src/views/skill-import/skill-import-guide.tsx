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
        "mx-0.5 inline-flex -translate-y-px items-center gap-1 rounded-md border px-1.5 align-middle text-xs font-medium leading-5",
        highlighted
          ? "border-[hsl(var(--primary-200))] bg-[hsl(var(--primary-0))] text-[hsl(var(--primary-600))]"
          : "border-border bg-muted text-foreground",
      )}
    >
      <Icon size={12} aria-hidden="true" />
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
}: {
  readonly index: number;
  readonly children: ReactNode;
  readonly note?: string;
}) {
  return (
    <li className="flex gap-3">
      <span
        className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-medium text-muted-foreground ring-1 ring-border"
        aria-hidden="true"
      >
        {index}
      </span>
      <div className="min-w-0">
        <p className="text-sm leading-6 text-foreground">{children}</p>
        {note ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {note}
          </p>
        ) : null}
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

/** The control the first step names, ringed and labelled in the scene. */
function SceneCallout({ label }: { readonly label: string }) {
  return (
    <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-[#242424] px-1.5 py-[3px] text-[10px] font-medium leading-none text-[#ffffff]">
      {label}
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
function ClaudeCodeScene() {
  const { t } = useTranslation();
  const codeTab = t(($) => {
    return $.onboarding.sourcesFirst.skills.guide.controls.codeTab;
  });

  return (
    <SceneFrame className="bg-[#F9F8F6]">
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
                <SceneCallout label={codeTab} />
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
function CodexScene() {
  const { t } = useTranslation();

  return (
    <SceneFrame className="bg-[#F3F3F3]">
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
  copyStep = false,
  className,
}: {
  readonly provider: SkillImportProvider;
  /** Leads with copying the prompt, where the copy button follows the steps. */
  readonly copyStep?: boolean;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const first = copyStep ? 2 : 1;

  return (
    <div
      className={cn(
        "grid items-center gap-5 sm:grid-cols-[minmax(0,1fr)_236px]",
        className,
      )}
    >
      <ol
        aria-label={t(($) => {
          return $.onboarding.sourcesFirst.skills.guide.label;
        })}
        className="flex flex-col gap-3.5"
      >
        {copyStep ? (
          <GuideStep index={1}>
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
      {provider === "codex" ? <CodexScene /> : <ClaudeCodeScene />}
    </div>
  );
}
