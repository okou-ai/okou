import type { ReactNode } from "react";
import {
  Bold,
  ChevronRight,
  Folder,
  FolderOpen,
  Globe,
  Italic,
  List,
  Lock,
  MessageCircle,
  Route,
  Settings2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { FeatureGuideMedia } from "@okouai/api-contracts/contracts/feature-guides";
import { surfaceVariants } from "@okouai/ui/components/ui/card";
import { cn } from "@okouai/ui/lib/utils";

type IllustrationMedia = Extract<FeatureGuideMedia, { type: "illustration" }>;
type Scene = IllustrationMedia["scene"];

const titleClassName =
  "text-[14px] leading-[1.3] font-semibold tracking-[-0.01em] @max-[600px]:text-[13px] @max-[260px]:text-[12px]";
const bodyClassName =
  "text-[13px] leading-[1.5] font-normal tracking-normal @max-[600px]:text-[11px] @max-[260px]:text-[10px]";
const metaClassName =
  "text-[11px] leading-[1.4] font-normal tracking-normal text-[#665D5D] @max-[600px]:text-[9px] @max-[260px]:text-[8px]";

function IllustrationCard({
  children,
  className,
  back = false,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly back?: boolean;
}) {
  return (
    <div
      className={cn(
        surfaceVariants(),
        "absolute bg-[#ffffff] p-0",
        back
          ? "border-[#252121]/7 shadow-[0_1px_2px_rgb(36_33_33/0.04),0_14px_28px_-22px_rgb(36_33_33/0.20)]"
          : "border-[#252121]/8 shadow-[0_1px_3px_rgb(36_33_33/0.05),0_20px_40px_-26px_rgb(36_33_33/0.26)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function IllustrationHeading({
  icon: Icon,
  title,
  subtitle,
  back = false,
  compact = false,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly back?: boolean;
  readonly compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-[9px] @max-[600px]:gap-2",
        compact && "gap-2",
      )}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center shadow-[inset_0_0_0_0.7px_rgb(36_33_33/0.09)]",
          back ? "bg-[#F5F5F5]" : "bg-[#FFDD9E]",
          compact
            ? "size-[29px] rounded-lg @max-[600px]:size-[27px]"
            : "size-8 rounded-[9px] @max-[600px]:size-[29px] @max-[600px]:rounded-lg",
        )}
      >
        <Icon
          className={cn(
            "size-[18px] stroke-[1.6] @max-[600px]:size-[17px]",
            compact && "size-[17px]",
          )}
        />
      </span>
      <div>
        <p className={titleClassName}>{title}</p>
        {subtitle && (
          <p className={cn(metaClassName, compact ? "mt-[3px]" : "mt-1")}>
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

function IllustrationLocation({
  icon: Icon,
  location,
}: {
  readonly icon: LucideIcon;
  readonly location: readonly string[];
}) {
  return (
    <div
      className={cn(
        metaClassName,
        "flex items-center gap-1.5 whitespace-nowrap px-5 pt-[13px] @max-[600px]:gap-[5px] @max-[600px]:px-4 @max-[600px]:pt-3 @max-[260px]:gap-1 @max-[260px]:px-3.5",
      )}
    >
      <Icon className="size-3 shrink-0 stroke-[1.5] @max-[600px]:size-2.5" />
      {location.map((part, index) => {
        return (
          <span key={part} className="contents">
            {index > 0 && (
              <ChevronRight className="h-3 w-[9px] shrink-0 stroke-[1.5] @max-[600px]:h-2.5 @max-[600px]:w-2" />
            )}
            <span>{part}</span>
          </span>
        );
      })}
    </div>
  );
}

function ProjectsIllustration({
  scene,
}: {
  readonly scene: Extract<Scene, { type: "projects" }>;
}) {
  return (
    <>
      <IllustrationCard
        back
        className="top-7 right-20 w-[290px] -rotate-5 @max-[600px]:top-[19px] @max-[600px]:right-auto @max-[600px]:left-[19px] @max-[600px]:w-[calc(100%-65px)] @max-[260px]:left-[15px] @max-[260px]:w-[calc(100%-52px)] [@media(max-width:639px)_and_(max-height:760px)]:top-[42px]"
      >
        <div className="px-5 py-[18px] @max-[600px]:px-[17px] @max-[600px]:py-[15px] @max-[260px]:p-3.5">
          <IllustrationHeading icon={Folder} title={scene.backTitle} back />
          <div className="mt-[18px] mb-2 flex flex-col gap-2.5 @max-[600px]:mt-3.5">
            <span className="h-[5px] w-[70%] rounded-[3px] bg-[#E5E5E5]" />
            <span className="h-[5px] w-[55%] rounded-[3px] bg-[#E5E5E5]" />
          </div>
        </div>
      </IllustrationCard>
      <IllustrationCard className="top-[94px] right-[27px] w-[306px] rotate-2 @max-[600px]:top-[73px] @max-[600px]:right-[17px] @max-[600px]:w-[calc(100%-42px)] @max-[260px]:right-3 @max-[260px]:w-[calc(100%-30px)] [@media(max-width:639px)_and_(max-height:760px)]:top-[100px]">
        <IllustrationLocation icon={MessageCircle} location={scene.location} />
        <div className="px-5 py-[18px] @max-[600px]:px-[17px] @max-[600px]:py-[15px] @max-[260px]:p-3.5">
          <IllustrationHeading
            icon={FolderOpen}
            title={scene.title}
            subtitle={scene.subtitle}
          />
          <div className="mt-4 flex flex-col gap-[5px] @max-[600px]:mt-[13px] @max-[600px]:gap-1">
            {scene.conversations.map((conversation) => {
              return (
                <div
                  key={conversation}
                  className={cn(
                    bodyClassName,
                    "grid min-h-[26px] grid-cols-[32px_minmax(0,1fr)] items-center gap-[9px] @max-[600px]:min-h-6 @max-[600px]:grid-cols-[29px_minmax(0,1fr)] @max-[600px]:gap-2",
                  )}
                >
                  <MessageCircle className="size-[13px] justify-self-center stroke-[1.5] text-[#665D5D] @max-[600px]:size-[11px]" />
                  <span>{conversation}</span>
                </div>
              );
            })}
          </div>
        </div>
      </IllustrationCard>
    </>
  );
}

function InstructionsIllustration({
  scene,
}: {
  readonly scene: Extract<Scene, { type: "instructions" }>;
}) {
  return (
    <IllustrationCard className="top-9 right-7 w-[346px] -rotate-2 @max-[600px]:top-5 @max-[600px]:right-auto @max-[600px]:left-[18px] @max-[600px]:w-[calc(100%-36px)] @max-[260px]:left-[13px] @max-[260px]:w-[calc(100%-26px)] [@media(max-width:639px)_and_(max-height:760px)]:top-12">
      <IllustrationLocation icon={Settings2} location={scene.location} />
      <div className="px-5 pt-[19px] pb-[22px] @max-[600px]:px-[17px] @max-[600px]:pt-[17px] @max-[600px]:pb-[19px] @max-[260px]:px-[13px] @max-[260px]:py-4">
        <IllustrationHeading
          icon={UserRound}
          title={scene.title}
          subtitle={scene.subtitle}
        />
        <div className={cn(bodyClassName, "mt-[18px] @max-[600px]:mt-[17px]")}>
          {scene.lines.map((line, index) => {
            return (
              <p key={line}>
                {index === 1 ? (
                  <>
                    <span className="-ml-[3px] rounded-[2px] bg-[#FFDD9E] px-[3px] py-0.5">
                      {line}
                    </span>
                    <span className="ml-px inline-block h-5 border-r-[1.5px] border-[#FFA500] align-[-3px] @max-[600px]:h-[18px]" />
                  </>
                ) : (
                  line
                )}
              </p>
            );
          })}
        </div>
      </div>
      <div
        className={cn(
          surfaceVariants({ radius: "compact" }),
          "absolute top-12 right-[13px] flex rotate-3 items-center gap-[3px] border-[#252121]/8 bg-[#ffffff] p-1 shadow-[0_1px_3px_rgb(36_33_33/0.05),0_20px_40px_-26px_rgb(36_33_33/0.26)] @max-[600px]:top-[43px] @max-[600px]:right-2.5 @max-[600px]:gap-0.5 @max-[600px]:p-[3px] @max-[260px]:hidden",
        )}
      >
        {[
          { id: "bold", icon: Bold },
          { id: "italic", icon: Italic },
          { id: "list", icon: List },
        ].map(({ id, icon: Icon }) => {
          return (
            <span
              key={id}
              className={cn(
                "grid size-[23px] place-items-center rounded-[5px] @max-[600px]:h-[21px] @max-[600px]:w-[19px]",
                id === "bold" && "bg-[#F5F5F5]",
              )}
            >
              <Icon className="size-[13px] stroke-[1.8] @max-[600px]:size-[11px]" />
            </span>
          );
        })}
      </div>
    </IllustrationCard>
  );
}

function WorkflowIllustrationCard({
  scene,
  back = false,
}: {
  readonly scene: Extract<Scene, { type: "workflows" }>;
  readonly back?: boolean;
}) {
  return (
    <IllustrationCard
      back={back}
      className={cn(
        "w-[280px] @max-[600px]:w-[230px] @max-[260px]:w-[190px]",
        back
          ? "top-[27px] right-[165px] w-[260px] -rotate-6 @max-[600px]:top-5 @max-[600px]:right-auto @max-[600px]:left-[17px] @max-[600px]:w-[224px] @max-[260px]:left-2.5 @max-[260px]:w-[186px]"
          : "top-[62px] right-9 rotate-3 @max-[600px]:top-[72px] @max-[600px]:right-[17px] @max-[260px]:right-2.5",
      )}
    >
      {!back && <IllustrationLocation icon={Route} location={scene.location} />}
      <div className="px-4 pt-3.5 pb-3 @max-[600px]:px-3.5 @max-[600px]:pt-[13px] @max-[600px]:pb-[11px] @max-[260px]:p-3">
        <IllustrationHeading
          icon={Route}
          title={back ? scene.backTitle : scene.title}
          subtitle={
            back ? (
              <span className="flex items-center gap-1">
                <Globe className="size-[11px] stroke-[1.5]" />
                {scene.sharedLabel}
              </span>
            ) : (
              scene.subtitle
            )
          }
          compact
          back={back}
        />
        {back ? (
          <div className="mt-3 mb-2.5 flex flex-col gap-3 py-1.5 @max-[600px]:mb-[11px] @max-[600px]:gap-2.5">
            <span className="h-[5px] w-3/4 rounded-[2px] bg-[#E5E5E5]" />
            <span className="h-[5px] w-3/5 rounded-[2px] bg-[#E5E5E5]" />
            <span className="h-[5px] w-[68%] rounded-[2px] bg-[#E5E5E5]" />
          </div>
        ) : (
          <ol
            className={cn(
              bodyClassName,
              "mt-3 mb-2.5 flex list-none flex-col gap-[5px] p-0 @max-[600px]:mt-[11px]",
            )}
          >
            {scene.steps.map((step, index) => {
              return (
                <li key={step} className="flex gap-2">
                  <span className="min-w-2.5">{index + 1}.</span>
                  {step}
                </li>
              );
            })}
          </ol>
        )}
        <div
          className={cn(
            metaClassName,
            "flex items-center justify-between gap-1.5 pt-[9px] @max-[600px]:pt-2",
            back && "@max-[600px]:invisible",
          )}
        >
          <span>{back ? scene.backCommand : scene.command}</span>
          {!back && (
            <span className="flex items-center gap-1">
              <Lock className="size-[11px] stroke-[1.5]" />
              {scene.privateLabel}
            </span>
          )}
        </div>
      </div>
    </IllustrationCard>
  );
}

// Decorative product examples, not live editors. Their copy belongs to the
// edition, and the accessible summary makes their illustrative nature explicit.
export function FeatureGuideIllustration({
  media,
}: {
  readonly media: IllustrationMedia;
}) {
  const { scene } = media;
  return (
    <figure
      role="img"
      aria-label={media.alt}
      className={cn(
        "@container w-full overflow-hidden rounded-[20px] text-[#252121]",
        scene.type === "projects"
          ? "bg-[#FFF271]"
          : scene.type === "instructions"
            ? "bg-[#FFC6E2]"
            : "bg-[#B4DEF5]",
      )}
    >
      <div
        aria-hidden="true"
        className="relative h-[296px] @max-[600px]:h-[400px] [@media(max-width:639px)_and_(max-height:760px)]:h-[296px]"
      >
        {scene.type === "projects" ? (
          <ProjectsIllustration scene={scene} />
        ) : scene.type === "instructions" ? (
          <InstructionsIllustration scene={scene} />
        ) : (
          <>
            <WorkflowIllustrationCard scene={scene} back />
            <WorkflowIllustrationCard scene={scene} />
          </>
        )}
        <img
          src={media.characterUrl}
          alt=""
          className={cn(
            "absolute block object-contain [@media(max-width:639px)_and_(max-height:760px)]:hidden",
            scene.type === "projects"
              ? "bottom-7 left-9 h-60 w-auto @max-[600px]:bottom-5 @max-[600px]:left-[27px] @max-[600px]:h-[130px]"
              : scene.type === "instructions"
                ? "bottom-[42px] left-[22px] h-auto w-[246px] @max-[600px]:bottom-[25px] @max-[600px]:left-6 @max-[600px]:w-[200px] @max-[260px]:left-3.5 @max-[260px]:w-[180px]"
                : "bottom-[30px] left-12 h-[228px] w-auto @max-[600px]:bottom-[18px] @max-[600px]:left-[27px] @max-[600px]:h-[105px]",
          )}
        />
      </div>
    </figure>
  );
}
