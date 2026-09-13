// Workflow detail hosts the instruction editor, supplementary file manager
// (SKILL.md is never shown), automations, visibility controls, metadata
// editing, slash use, copy, and delete.
import type { FormEvent, ReactNode } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { OfficialWorkflowInstallationDefinition } from "@okouai/api-contracts/contracts/official-workflows";
import type {
  ChatRunFinishedEventConfig,
  ChatRunFinishedRunStatus,
  GmailNewMessageEventConfig,
  GoogleCalendarAutomationEventConfig,
  GithubDeploymentState,
  GithubDeploymentStatusCreatedEventConfig,
  GithubIssueCommentCreatedEventConfig,
  GithubIssueCommentSubjectFilter,
  GithubPullRequestAction,
  GithubPullRequestEventConfig,
  GithubPullRequestReviewState,
  GithubPullRequestReviewSubmittedEventConfig,
  GithubWorkflowJobCompletedEventConfig,
  GithubWorkflowRunCompletedEventConfig,
  GithubWorkflowRunConclusion,
  NotionPageContentUpdatedEventCreateConfig,
  StripeInvoiceBillingReason,
  WorkflowFileEntry,
  WorkflowFileMetadata,
  WorkflowDetailResponse,
  WorkflowSchedule,
  WorkflowScheduleType,
  WorkflowAutomationSummary,
  WorkflowUpdateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CircleCheck,
  ChevronDown,
  Clock,
  Copy,
  DatabasePlus,
  FilePen,
  FilePlus,
  FileText,
  History,
  Info,
  Link as LinkIcon,
  Loader2,
  Mail,
  MessageCircle,
  Play,
  Plus,
  Pencil,
  Repeat,
  Route,
  Trash,
  Upload,
  EllipsisVertical,
  Eye,
  Video,
  X,
} from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  surfaceVariants,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  BrandGithub,
  BrandNotion,
  BrandStripe,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";

import { currentLocale, i18n } from "../../i18n/index.ts";
import { agents$ } from "../../signals/agent.ts";
import { user$ } from "../../signals/auth.ts";
import { brandName$ } from "../../signals/branding.ts";
import {
  changeWorkflowVisibility$,
  createNotionPageContentUpdatedScope$,
  createWorkflowChatRunFinishedAutomation$,
  createWorkflowGithubWebhookAutomation$,
  createWorkflowGithubWorkflowRunCompletedAutomation$,
  createWorkflowGoogleCalendarEventAutomation$,
  createWorkflowGoogleFormsResponseSubmittedAutomation$,
  createWorkflowGoogleMeetTranscriptGeneratedAutomation$,
  createWorkflowGmailLabelAppliedAutomation$,
  createWorkflowGmailNewMessageAutomation$,
  createGmailMatchConditions$,
  createWorkflowNotionChildPageAutomation$,
  createWorkflowNotionDatabaseItemAutomation$,
  createWorkflowNotionPageContentUpdatedAutomation$,
  createWorkflowWebhookAutomation$,
  createGithubPullRequestAction$,
  createScheduleCronFields$,
  createWorkflowScheduleAutomation$,
  createWorkflowStripeInvoicePaidAutomation$,
  createdWorkflowWebhookAutomation$,
  currentWorkflowId$,
  copyWorkflow$,
  defaultWorkflowCronFields,
  deleteWorkflow$,
  deleteWorkflowAutomation$,
  editingScheduleCronFields$,
  editingGithubPullRequestAction$,
  editingGmailMatchConditions$,
  editingGoogleCalendarId$,
  editingWorkflowAutomationId$,
  isGoogleCalendarWorkflowAutomation,
  patchWorkflowMetadataForm$,
  openWorkflowChat$,
  pauseWorkflowAutomations$,
  reloadWorkflows$,
  revealWebhookSecretAutomationId$,
  revealWorkflowWebhookSecret$,
  resetWorkflowMetadataForm$,
  runWorkflowAutomationNow$,
  selectedWorkflowFilePath$,
  setCreateGithubPullRequestAction$,
  setCreateGmailMatchConditions$,
  setCreateNotionPageContentUpdatedScope$,
  setCreateScheduleCronFields$,
  setCreatedWorkflowWebhookAutomation$,
  setEditingGithubPullRequestAction$,
  setEditingGmailMatchConditions$,
  setEditingGoogleCalendarId$,
  setEditingScheduleCronFields$,
  setEditingWorkflowAutomationId$,
  setRevealWebhookSecretAutomationId$,
  setSelectedWorkflowFilePath$,
  setWorkflowActionDialog$,
  setWorkflowDetailActiveTab$,
  setWorkflowFileDraft$,
  setWorkflowCopyForm$,
  setWorkflowAutomationCreateDialog$,
  setWorkflowAutomationEnabled$,
  scrollTargetedWorkflowAutomationIntoViewRef$,
  updateWorkflowAutomationEventConfig$,
  updateWorkflowGoogleCalendarAutomationEventConfig$,
  updateWorkflowScheduleAutomation$,
  updateWorkflow$,
  workflowActionDialog$,
  workflowDemoteConfirmOpen$,
  setWorkflowDemoteConfirmOpen$,
  setWorkflowAutomationPickerCategory$,
  setWorkflowAutomationPickerOpen$,
  setWorkflowWebhookUpgradeDialogOpen$,
  workflowWebhookUpgradeDialogSource$,
  workflowCopyForm$,
  workflowDetailActiveTab$,
  workflowAutomationCreateDialog$,
  workflowAutomationPickerCategory$,
  workflowAutomationPickerOpen$,
  workflowFileDraft$,
  currentWorkflowDetail$,
  type WorkflowCopyFormState,
  type WorkflowCronFields,
  type WorkflowCronFrequency,
  type WorkflowDetailTab,
  type WorkflowAutomationCreateDialog,
  type NotionPageContentUpdatedScopeMode,
  type GmailMatchField,
  type GmailMatchCondition,
  type GmailMatchOperator,
  type GmailTextOperator,
  type GoogleCalendarWorkflowAutomationSummary,
  workflowMetadataPatch$,
  targetedWorkflowAutomationId$,
} from "../../signals/workflows-page/workflows-signals.ts";
import {
  currentOfficialWorkflowInstallation$,
  officialWorkflowConfigurationForm$,
  reconfigureOfficialWorkflow$,
  setOfficialWorkflowConfigurationForm$,
  uninstallOfficialWorkflow$,
} from "../../signals/workflows-page/official-workflows-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason, settle } from "../../signals/utils.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { orgPlanCapabilities$ } from "../../signals/okou-page/org-plan-capabilities.ts";
import {
  githubIntegrationData$,
  type GithubIntegrationData,
} from "../../signals/okou-page/github.ts";
import {
  atTimeInTimezone,
  buildCronExpression,
  cronWallTimeInTimezone,
  type CronTimeOption,
} from "../../signals/okou-page/cron.ts";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { Link } from "../router/link.tsx";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { TiptapInstructionsEditor } from "../okou-page/tiptap-instructions-editor.tsx";
import { UnsavedBar } from "../okou-page/unsaved-bar.tsx";
import { InlineSettingsRow } from "../okou-page/components/inline-settings-row.tsx";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@okouai/ui/components/ui/alert";
import {
  agentLabel,
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  chatRunFinishedStatusLabel,
  formTextValue,
  formatWorkflowIntervalSeconds,
  GMAIL_TEXT_FIELDS,
  gmailAutomationSummary as sharedAutomationSummary,
  gmailAutomationTitle as sharedAutomationTitle,
  githubAutomationFilterValueLabel,
  getWorkflowIntervalSecondOptions,
  isMarkdownPath,
  automationKindLabel,
  workflowTitle,
} from "./workflow-shared.tsx";
import { WorkflowHoverContent } from "./workflows-page.tsx";
import { AutomationListIcon } from "../okou-page/workflow-automations-page.tsx";
import { emptyAutomationsImg } from "../okou-page/platform-assets.ts";
import { WorkflowWebhookUpgradeDialog } from "./workflow-webhook-upgrade-dialog.tsx";
import {
  GoogleCalendarRecoveryDialogs,
  GoogleCalendarReconnectAction,
} from "./google-calendar-recovery.tsx";
import {
  createOfficialWorkflowConfigurationForm,
  OfficialWorkflowConfigurationFields,
  officialWorkflowConfigurationComplete,
  officialWorkflowHasConfigurableParameters,
} from "./official-workflow-configuration.tsx";

const AUTOMATION_FIELD_CLASS = "h-8 px-2 text-xs";
const WORKFLOW_EDIT_TEXTAREA_CLASS = "min-h-24 resize-y";
const AUTOMATION_TIMEZONE = "UTC";

const STRIPE_INVOICE_BILLING_REASONS = [
  "automatic_pending_invoice_item_invoice",
  "manual",
  "quote_accept",
  "subscription",
  "subscription_create",
  "subscription_cycle",
  "subscription_threshold",
  "subscription_update",
  "upcoming",
] as const satisfies readonly StripeInvoiceBillingReason[];

type WorkflowStripeInvoicePaidAutomation = Extract<
  WorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "stripe-invoice-paid" }
>;
type StripeDeliveryStatus = NonNullable<
  WorkflowStripeInvoicePaidAutomation["health"]["lastDeliveryStatus"]
>;

function automationActionCopy() {
  return {
    addAutomation: i18n.t(($) => {
      return $.workflows.automations.common.addAutomation;
    }),
    cancel: i18n.t(($) => {
      return $.workflows.automations.common.cancel;
    }),
    deleteAutomation: i18n.t(($) => {
      return $.workflows.automations.common.deleteAutomation;
    }),
    done: i18n.t(($) => {
      return $.workflows.automations.common.done;
    }),
    editAutomation: i18n.t(($) => {
      return $.workflows.automations.common.editAutomation;
    }),
    moreActions: i18n.t(($) => {
      return $.workflows.automations.common.moreActions;
    }),
    runNow: i18n.t(($) => {
      return $.workflows.automations.common.runNow;
    }),
  };
}

function WorkflowDialogFooter({
  busy,
  disabled = busy,
  icon = null,
  size = 14,
  label,
  cancelLabel,
  variant,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly size?: 13 | 14;
  readonly label: ReactNode;
  readonly cancelLabel?: string;
  readonly variant?: "destructive";
  readonly onCancel: () => void;
  readonly onConfirm?: () => void;
}) {
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={onCancel}
      >
        {cancelLabel ??
          i18n.t(($) => {
            return $.workflows.automations.common.cancel;
          })}
      </Button>
      <Button
        type={onConfirm ? "button" : "submit"}
        variant={variant}
        disabled={disabled}
        onClick={onConfirm}
      >
        {busy ? <Loader2 size={size} className="animate-spin" /> : icon}
        {label}
      </Button>
    </DialogFooter>
  );
}

function workflowMetadataCopy() {
  return {
    agent: i18n.t(($) => {
      return $.workflows.detail.metadata.agent;
    }),
    agentDescription: i18n.t(($) => {
      return $.workflows.detail.metadata.agentDescription;
    }),
    aria: i18n.t(($) => {
      return $.workflows.detail.metadata.aria;
    }),
    description: i18n.t(($) => {
      return $.workflows.detail.metadata.description;
    }),
    descriptionHelp: i18n.t(($) => {
      return $.workflows.detail.metadata.descriptionHelp;
    }),
    name: i18n.t(($) => {
      return $.workflows.detail.metadata.name;
    }),
    nameHelp: i18n.t(($) => {
      return $.workflows.detail.metadata.nameHelp;
    }),
    namePlaceholder: i18n.t(($) => {
      return $.workflows.detail.metadata.namePlaceholder;
    }),
    saved: i18n.t(($) => {
      return $.workflows.detail.metadata.saved;
    }),
    slug: i18n.t(($) => {
      return $.workflows.detail.metadata.slug;
    }),
    slugTitle: i18n.t(($) => {
      return $.workflows.detail.metadata.slugTitle;
    }),
    visibility: i18n.t(($) => {
      return $.workflows.detail.metadata.visibility;
    }),
    visibilityHelp: i18n.t(($) => {
      return $.workflows.detail.metadata.visibilityHelp;
    }),
  };
}

function workflowVisibilityCopy() {
  return {
    adminRequired: i18n.t(($) => {
      return $.workflows.detail.visibility.adminRequired;
    }),
    automationWarning: i18n.t(($) => {
      return $.workflows.detail.visibility.automationWarning;
    }),
    cancel: i18n.t(($) => {
      return $.workflows.common.cancel;
    }),
    confirmDescription: i18n.t(($) => {
      return $.workflows.detail.visibility.confirmDescription;
    }),
    confirmTitle: i18n.t(($) => {
      return $.workflows.detail.visibility.confirmTitle;
    }),
    makePrivate: i18n.t(($) => {
      return $.workflows.detail.visibility.makePrivate;
    }),
    private: i18n.t(($) => {
      return $.workflows.common.private;
    }),
    public: i18n.t(($) => {
      return $.workflows.common.public;
    }),
    publishAria: i18n.t(($) => {
      return $.workflows.detail.visibility.publishAria;
    }),
  };
}

function workflowWebhookCopy() {
  return {
    cancel: i18n.t(($) => {
      return $.workflows.automations.common.cancel;
    }),
    copy: i18n.t(($) => {
      return $.workflows.automations.webhook.copy;
    }),
    done: i18n.t(($) => {
      return $.workflows.automations.common.done;
    }),
    reveal: i18n.t(($) => {
      return $.workflows.automations.webhook.reveal;
    }),
    secret: i18n.t(($) => {
      return $.workflows.automations.webhook.secret;
    }),
    signedCurl: i18n.t(($) => {
      return $.workflows.automations.webhook.signedCurl;
    }),
    url: i18n.t(($) => {
      return $.workflows.automations.webhook.url;
    }),
  };
}

type GmailWorkflowAutomationSummary = Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "gmail-new-message" | "gmail-label-applied";
  }
>;
type GithubWorkflowAutomationSummary = Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType:
      | "github-deployment-status-created"
      | "github-issue-comment-created"
      | "github-pull-request"
      | "github-pull-request-review-submitted"
      | "github-workflow-job-completed"
      | "github-workflow-run-completed";
  }
>;
type GithubWebhookWorkflowAutomationSummary = Extract<
  GithubWorkflowAutomationSummary,
  {
    readonly eventType:
      | "github-deployment-status-created"
      | "github-issue-comment-created"
      | "github-pull-request"
      | "github-pull-request-review-submitted"
      | "github-workflow-job-completed";
  }
>;
type WebhookWorkflowAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;

const GMAIL_MATCH_FIELDS: readonly {
  readonly field: GmailMatchField;
  readonly label: string;
}[] = [
  {
    field: "threadId",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.field.threadId;
      });
    },
  },
  ...GMAIL_TEXT_FIELDS,
];

interface GmailMatchOperatorOption {
  readonly operator: GmailMatchOperator;
  readonly label: string;
  readonly formSuffix: string;
}

const GMAIL_TEXT_OPERATORS: readonly (GmailMatchOperatorOption & {
  readonly operator: GmailTextOperator;
})[] = [
  {
    operator: "contains",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.operator.contains;
      });
    },
    formSuffix: "Contains",
  },
  {
    operator: "containsAny",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.operator.containsAny;
      });
    },
    formSuffix: "ContainsAny",
  },
  {
    operator: "doesNotContain",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.operator.doesNotContain;
      });
    },
    formSuffix: "DoesNotContain",
  },
];
const GITHUB_SUBJECT_OPTIONS: readonly {
  readonly value: GithubIssueCommentSubjectFilter;
  readonly label: string;
}[] = [
  {
    value: "both",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.issuesAndPullRequests;
      });
    },
  },
  {
    value: "issues",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.issuesOnly;
      });
    },
  },
  {
    value: "pull_requests",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestsOnly;
      });
    },
  },
];

const GITHUB_PULL_REQUEST_ACTION_OPTIONS: readonly {
  readonly value: GithubPullRequestAction;
  readonly label: string;
}[] = [
  {
    value: "opened",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionOpened;
      });
    },
  },
  {
    value: "reopened",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionReopened;
      });
    },
  },
  {
    value: "closed",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionClosed;
      });
    },
  },
  {
    value: "ready_for_review",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionReadyForReview;
      });
    },
  },
  {
    value: "converted_to_draft",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionConvertedToDraft;
      });
    },
  },
  {
    value: "synchronize",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionSynchronize;
      });
    },
  },
  {
    value: "enqueued",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionEnqueued;
      });
    },
  },
  {
    value: "dequeued",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionDequeued;
      });
    },
  },
  {
    value: "labeled",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionLabeled;
      });
    },
  },
  {
    value: "unlabeled",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestActionUnlabeled;
      });
    },
  },
];

const GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS: readonly {
  readonly value: GithubWorkflowRunConclusion;
  readonly label: string;
}[] = [
  {
    value: "success",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.success;
      });
    },
  },
  {
    value: "failure",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.failure;
      });
    },
  },
  {
    value: "cancelled",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.cancelled;
      });
    },
  },
  {
    value: "timed_out",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.timedOut;
      });
    },
  },
  {
    value: "action_required",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.actionRequired;
      });
    },
  },
  {
    value: "neutral",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.neutral;
      });
    },
  },
  {
    value: "skipped",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.skipped;
      });
    },
  },
  {
    value: "stale",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.stale;
      });
    },
  },
  {
    value: "startup_failure",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.startupFailure;
      });
    },
  },
];

const GITHUB_REVIEW_STATE_OPTIONS: readonly {
  readonly value: GithubPullRequestReviewState;
  readonly label: string;
}[] = [
  {
    value: "approved",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.approved;
      });
    },
  },
  {
    value: "changes_requested",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.changesRequested;
      });
    },
  },
  {
    value: "commented",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.commented;
      });
    },
  },
];

const GITHUB_DEPLOYMENT_STATE_OPTIONS: readonly {
  readonly value: GithubDeploymentState;
  readonly label: string;
}[] = [
  {
    value: "success",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.success;
      });
    },
  },
  {
    value: "failure",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.failure;
      });
    },
  },
  {
    value: "error",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.error;
      });
    },
  },
  {
    value: "pending",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.pending;
      });
    },
  },
  {
    value: "in_progress",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.inProgress;
      });
    },
  },
  {
    value: "queued",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.queued;
      });
    },
  },
  {
    value: "waiting",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.waiting;
      });
    },
  },
  {
    value: "inactive",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.inactive;
      });
    },
  },
];

const WORKFLOW_CRON_FREQUENCY_OPTIONS: readonly {
  readonly value: WorkflowCronFrequency;
  readonly label: string;
}[] = [
  {
    value: "every_day",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.schedule.everyDay;
      });
    },
  },
  {
    value: "every_weekday",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.schedule.everyWeekday;
      });
    },
  },
  {
    value: "every_week",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.schedule.everyWeek;
      });
    },
  },
  {
    value: "every_month",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.schedule.everyMonth;
      });
    },
  },
  {
    value: "custom",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.schedule.customCron;
      });
    },
  },
];

const WORKFLOW_CRON_HOUR_OPTIONS: readonly number[] = Array.from(
  { length: 24 },
  (_, index) => {
    return index;
  },
);

const WORKFLOW_CRON_MINUTE_OPTIONS: readonly number[] = Array.from(
  { length: 12 },
  (_, index) => {
    return index * 5;
  },
);

function workflowDayOfWeekOptions(): readonly (readonly [string, string])[] {
  return ["1", "2", "3", "4", "5", "6", "0"].map((value) => {
    return [
      value,
      new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        weekday: "short",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2024, 0, 7 + Number(value)))),
    ] as const;
  });
}

const WORKFLOW_CRON_FREQUENCY_TO_TIME_OPTION: Readonly<
  Record<Exclude<WorkflowCronFrequency, "custom">, CronTimeOption>
> = Object.freeze({
  every_day: "every-day",
  every_weekday: "every-weekday",
  every_week: "every-week",
  every_month: "every-month",
});

function isGmailWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): automation is GmailWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "gmail-new-message" ||
      automation.eventType === "gmail-label-applied")
  );
}

function isGithubWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): automation is GithubWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "github-deployment-status-created" ||
      automation.eventType === "github-issue-comment-created" ||
      automation.eventType === "github-pull-request" ||
      automation.eventType === "github-pull-request-review-submitted" ||
      automation.eventType === "github-workflow-job-completed" ||
      automation.eventType === "github-workflow-run-completed")
  );
}

function isGithubWebhookWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): automation is GithubWebhookWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "github-deployment-status-created" ||
      automation.eventType === "github-issue-comment-created" ||
      automation.eventType === "github-pull-request" ||
      automation.eventType === "github-pull-request-review-submitted" ||
      automation.eventType === "github-workflow-job-completed")
  );
}

function isWebhookWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): automation is WebhookWorkflowAutomationSummary {
  return (
    automation.kind === "event" && automation.eventType === "webhook-received"
  );
}

function copyText(value: string): void {
  detach(writeToClipboard(value), Reason.DomCallback);
}

export function WorkflowDetailPage() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const workflowId = useGet(currentWorkflowId$);

  if (!workflowId) {
    return null;
  }

  return (
    <>
      <title>{`${t(($) => {
        return $.workflows.common.workflow;
      })} | ${brandName}`}</title>
      <GoogleCalendarRecoveryDialogs />
      <WorkflowDetailContent />
    </>
  );
}

function WorkflowDetailContent() {
  useTranslation();
  const detail$ = currentWorkflowDetail$;
  const detailLoadable = useLoadable(detail$);
  const lastResolvedDetail = useLastResolved(detail$);
  const detail =
    detailLoadable.state === "hasData"
      ? detailLoadable.data
      : (lastResolvedDetail ?? null);
  const activeTab = useGet(workflowDetailActiveTab$);
  const setActiveTab = useSet(setWorkflowDetailActiveTab$);

  if (!detail && detailLoadable.state !== "hasData") {
    return <DetailSkeleton />;
  }

  return (
    <DetailPageShell>
      <WorkflowBreadcrumb detail={detail} />
      <DetailHeader
        detail={detail}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <DetailPageMain>
        {detail ? (
          <WorkflowTabContent activeTab={activeTab} detail={detail} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.detail.notFound;
            })}
          </p>
        )}
      </DetailPageMain>
    </DetailPageShell>
  );
}

function WorkflowBreadcrumb({
  detail,
}: {
  readonly detail: WorkflowDetailResponse | null;
}) {
  if (!detail) {
    return (
      <DetailPageBreadcrumbBar>
        <div className="h-7 w-56 rounded-md bg-muted/50" aria-hidden="true" />
      </DetailPageBreadcrumbBar>
    );
  }

  return (
    <DetailPageBreadcrumbBar>
      <BreadcrumbLink
        pathname={ROUTES.workflows}
        icon={<Route size={14} className="shrink-0" />}
      >
        {i18n.t(($) => {
          return $.workflows.common.workflows;
        })}
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <span className="min-w-0 truncate rounded-md px-1.5 py-0.5 font-medium text-foreground">
        {workflowTitle(detail)}
      </span>
    </DetailPageBreadcrumbBar>
  );
}

function BreadcrumbLink({
  pathname,
  options,
  icon,
  children,
}: {
  readonly pathname: (typeof ROUTES)[keyof typeof ROUTES];
  readonly options?: Parameters<typeof Link>[0]["options"];
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Link
      pathname={pathname}
      options={options}
      className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-state-hover hover:text-foreground"
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

function WorkflowHeaderIcon({
  automation,
}: {
  readonly automation: WorkflowAutomationSummary | undefined;
}) {
  if (automation) {
    return <AutomationListIcon automation={automation} size="md" />;
  }
  return (
    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gray-100 text-muted-foreground sm:h-16 sm:w-16">
      <Route size={28} />
    </span>
  );
}

function DetailHeader({
  detail,
  activeTab,
  onTabChange,
}: {
  readonly detail: WorkflowDetailResponse | null;
  readonly activeTab: WorkflowDetailTab;
  readonly onTabChange: (tab: WorkflowDetailTab) => void;
}) {
  return (
    <DetailPageHeader>
      {detail ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <WorkflowHeaderIcon automation={detail.automations[0]} />
              <div className="flex min-w-0 flex-col justify-center">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <h1 className="w-fit max-w-full cursor-help truncate text-lg font-semibold tracking-tight text-foreground underline decoration-foreground/40 decoration-dotted decoration-[1px] underline-offset-2 sm:text-xl">
                        {workflowTitle(detail)}
                      </h1>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      className="rounded-lg border border-[hsl(var(--gray-400))] p-3"
                      style={{
                        backgroundColor: "hsl(var(--card))",
                        color: "hsl(var(--card-foreground))",
                        boxShadow:
                          "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                      }}
                    >
                      <WorkflowHoverContent workflow={detail} />
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <p className="mt-1.5 max-w-full truncate text-sm text-muted-foreground">
                  /{detail.name}
                </p>
              </div>
            </div>
            {detail.official ? null : <WorkflowChatButton detail={detail} />}
          </div>
          <div className="mt-4 flex items-center gap-2 sm:mt-6">
            <WorkflowTabNav activeTab={activeTab} onTabChange={onTabChange} />
            {activeTab === "automations" && !detail.official ? (
              <AutomationCreateAction />
            ) : null}
            {activeTab === "instructions" ? (
              <WorkflowFilePicker detail={detail} />
            ) : null}
          </div>
        </>
      ) : (
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="mt-4 h-9 w-80 rounded bg-muted" />
        </div>
      )}
    </DetailPageHeader>
  );
}

function WorkflowTabNav({
  activeTab,
  onTabChange,
}: {
  readonly activeTab: WorkflowDetailTab;
  readonly onTabChange: (tab: WorkflowDetailTab) => void;
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(tab) => {
        onTabChange(tab as WorkflowDetailTab);
      }}
      className="min-w-0 flex-1"
    >
      <div className="sm:hidden">
        <Select
          value={activeTab}
          onValueChange={(tab) => {
            onTabChange(tab as WorkflowDetailTab);
          }}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="automations">
              {i18n.t(($) => {
                return $.workflows.list.automations;
              })}
            </SelectItem>
            <SelectItem value="instructions">
              {i18n.t(($) => {
                return $.workflows.common.instructions;
              })}
            </SelectItem>
            <SelectItem value="info">
              {i18n.t(($) => {
                return $.workflows.common.settings;
              })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <TabsList className="hidden sm:inline-flex">
        <TabsTrigger value="automations">
          <Clock size={14} />
          {i18n.t(($) => {
            return $.workflows.list.automations;
          })}
        </TabsTrigger>
        <TabsTrigger value="instructions">
          <FileText size={14} />
          {i18n.t(($) => {
            return $.workflows.common.instructions;
          })}
        </TabsTrigger>
        <TabsTrigger value="info">
          <Info size={14} />
          {i18n.t(($) => {
            return $.workflows.common.settings;
          })}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function AutomationCreateAction() {
  const setCreateDialog = useSet(setWorkflowAutomationCreateDialog$);
  const setWebhookUpgradeDialogOpen = useSet(
    setWorkflowWebhookUpgradeDialogOpen$,
  );
  const features = useGet(featureSwitch$);
  const capabilities = useLastResolved(orgPlanCapabilities$);
  const webhookTierEligible =
    capabilities?.workflowWebhookAutomationAllowed ?? true;
  const stripeInvoicePaidAutomationsEnabled =
    features[FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations] ?? false;

  return (
    <AutomationCreateMenu
      onSelect={(kind) => {
        if (kind === "webhook" && !webhookTierEligible) {
          setWebhookUpgradeDialogOpen(true);
          return;
        }
        setCreateDialog(kind);
      }}
      stripeInvoicePaidAutomationsEnabled={stripeInvoicePaidAutomationsEnabled}
      webhookTierEligible={webhookTierEligible}
    />
  );
}

function WorkflowChatButton({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [openLoadable, openWorkflowChat] = useLoadableSet(openWorkflowChat$);
  const opening = openLoadable.state === "loading";
  const chatLabel = i18n.t(
    ($) => {
      return $.workflows.detail.refineWith;
    },
    { agent: agentLabel(detail) },
  );

  return (
    <Button
      variant="neutral"
      size="sm"
      type="button"
      aria-label={chatLabel}
      className="max-w-[220px] shrink-0 gap-1.5"
      disabled={opening}
      onClick={() => {
        detach(
          openWorkflowChat(detail.id, pageSignal),
          Reason.DomCallback,
          "open workflow chat",
        );
      }}
    >
      {opening ? (
        <Loader2 size={14} className="shrink-0 animate-spin" />
      ) : (
        <MessageCircle size={14} className="shrink-0" />
      )}
      <span className="truncate">{chatLabel}</span>
    </Button>
  );
}

function WorkflowTabContent({
  activeTab,
  detail,
}: {
  readonly activeTab: WorkflowDetailTab;
  readonly detail: WorkflowDetailResponse;
}) {
  const content = (() => {
    switch (activeTab) {
      case "automations": {
        return <AutomationsSection detail={detail} />;
      }
      case "instructions": {
        return <WorkflowInstructionsTab detail={detail} />;
      }
      case "info": {
        return <WorkflowInfoTab detail={detail} />;
      }
    }
  })();

  return (
    <>
      <ShadowWarning detail={detail} />
      <OfficialWorkflowLifecycleBanner detail={detail} />
      {content}
    </>
  );
}

function OfficialWorkflowLifecycleBanner({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  if (!detail.official) {
    return null;
  }
  const lifecycle = detail.official.definitionLifecycle;
  const copy = (() => {
    if (lifecycle === "retired") {
      return {
        title: i18n.t(($) => {
          return $.workflows.official.retiredInstallationTitle;
        }),
        description: i18n.t(($) => {
          return $.workflows.official.retiredInstallationDescription;
        }),
      };
    }
    if (lifecycle === "unavailable") {
      return {
        title: i18n.t(($) => {
          return $.workflows.official.unavailableInstallationTitle;
        }),
        description: i18n.t(($) => {
          return $.workflows.official.unavailableInstallationDescription;
        }),
      };
    }
    return {
      title: i18n.t(($) => {
        return $.workflows.official.activeInstallationTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.official.activeInstallationDescription;
      }),
    };
  })();
  return (
    <Alert
      className={cn(
        "mx-auto mb-4 max-w-[900px]",
        lifecycle === "retired" && "border-amber-300 bg-amber-50",
      )}
    >
      <BadgeCheck size={16} />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
  );
}

function WorkflowInfoTab({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const actionDialog = useGet(workflowActionDialog$);
  const setActionDialog = useSet(setWorkflowActionDialog$);
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <WorkflowMetadataForm detail={detail} />
      <div className={surfaceVariants({ className: "overflow-hidden" })}>
        <div className="p-4 sm:p-5">
          <InlineSettingsRow
            label={i18n.t(($) => {
              return $.workflows.detail.info.copyTitle;
            })}
            description={i18n.t(($) => {
              return $.workflows.detail.info.copyDescription;
            })}
            alignControls="center"
          >
            <Button
              type="button"
              variant="neutral"
              size="sm"
              className="h-9 gap-2 rounded-lg"
              onClick={() => {
                setActionDialog("copy");
              }}
            >
              <Copy size={14} />
              {i18n.t(($) => {
                return $.workflows.common.copyWorkflow;
              })}
            </Button>
          </InlineSettingsRow>
        </div>
      </div>
      {detail.official ? (
        <OfficialWorkflowInstallationSettings detail={detail} />
      ) : null}
      {detail.canManage && !detail.official ? (
        <div className={surfaceVariants({ className: "overflow-hidden" })}>
          <div className="p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="min-w-0 sm:max-w-[46%]">
                <h3 className="text-sm font-medium text-foreground">
                  {i18n.t(($) => {
                    return $.workflows.detail.delete.dangerTitle;
                  })}
                </h3>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  {i18n.t(($) => {
                    return $.workflows.detail.delete.dangerDescription;
                  })}
                </p>
              </div>
              <div className="flex w-full shrink-0 justify-end sm:w-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    setActionDialog("delete");
                  }}
                >
                  <Trash size={14} />
                  {i18n.t(($) => {
                    return $.workflows.common.deleteWorkflow;
                  })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <WorkflowCopyDialog
        detail={detail}
        open={actionDialog === "copy"}
        onOpenChange={(open) => {
          setActionDialog(open ? "copy" : null);
        }}
      />
      {!detail.official ? (
        <WorkflowDeleteDialog
          detail={detail}
          open={actionDialog === "delete"}
          onOpenChange={(open) => {
            setActionDialog(open ? "delete" : null);
          }}
        />
      ) : null}
      {detail.official ? (
        <OfficialWorkflowUninstallDialog
          detail={detail}
          open={actionDialog === "delete"}
          onOpenChange={(open) => {
            setActionDialog(open ? "delete" : null);
          }}
        />
      ) : null}
    </div>
  );
}

function OfficialWorkflowInstallationSettings({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const installationLoadable = useLoadable(
    currentOfficialWorkflowInstallation$,
  );
  const installation =
    installationLoadable.state === "hasData" ? installationLoadable.data : null;
  const definition = installation?.definition;
  const canReconfigure =
    definition === undefined ||
    officialWorkflowHasConfigurableParameters(definition.blueprints);
  return (
    <>
      {canReconfigure ? (
        <OfficialWorkflowReconfigureCard
          detail={detail}
          definition={definition}
          loading={installationLoadable.state === "loading"}
        />
      ) : null}
      <OfficialWorkflowUninstallCard />
      {definition && canReconfigure ? (
        <OfficialWorkflowReconfigureDialog
          detail={detail}
          definition={definition}
        />
      ) : null}
    </>
  );
}

function OfficialWorkflowReconfigureCard({
  detail,
  definition,
  loading,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly definition: OfficialWorkflowInstallationDefinition | undefined;
  readonly loading: boolean;
}) {
  const setForm = useSet(setOfficialWorkflowConfigurationForm$);
  const description = definition
    ? i18n.t(($) => {
        return $.workflows.official.reconfigureDescription;
      })
    : i18n.t(($) => {
        return $.workflows.official.reconfigureUnavailable;
      });
  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      <div className="p-4 sm:p-5">
        <InlineSettingsRow
          label={i18n.t(($) => {
            return $.workflows.official.reconfigureTitle;
          })}
          description={description}
          alignControls="center"
        >
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="h-9 rounded-lg"
            disabled={!definition || loading}
            onClick={() => {
              if (!definition) {
                return;
              }
              setForm(
                createOfficialWorkflowConfigurationForm({
                  target: {
                    operation: "reconfigure",
                    workflowId: detail.id,
                  },
                  definitionName: definition.name,
                  agentId: detail.agentId,
                  blueprints: definition.blueprints,
                  automations: detail.automations,
                }),
              );
            }}
          >
            {i18n.t(($) => {
              return $.workflows.official.reconfigure;
            })}
          </Button>
        </InlineSettingsRow>
      </div>
    </div>
  );
}

function OfficialWorkflowUninstallCard() {
  const setActionDialog = useSet(setWorkflowActionDialog$);
  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      <div className="p-4 sm:p-5">
        <InlineSettingsRow
          label={i18n.t(($) => {
            return $.workflows.official.uninstallTitle;
          })}
          description={i18n.t(($) => {
            return $.workflows.official.uninstallDescription;
          })}
          alignControls="center"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setActionDialog("delete");
            }}
          >
            <Trash size={14} />
            {i18n.t(($) => {
              return $.workflows.official.uninstall;
            })}
          </Button>
        </InlineSettingsRow>
      </div>
    </div>
  );
}

function OfficialWorkflowReconfigureDialog({
  detail,
  definition,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly definition: OfficialWorkflowInstallationDefinition;
}) {
  const form = useGet(officialWorkflowConfigurationForm$);
  const setForm = useSet(setOfficialWorkflowConfigurationForm$);
  const pageSignal = useGet(pageSignal$);
  const [reconfigureLoadable, reconfigure] = useLoadableSet(
    reconfigureOfficialWorkflow$,
  );
  const reconfiguring = reconfigureLoadable.state === "loading";
  const activeForm =
    form?.target.operation === "reconfigure" &&
    form.target.workflowId === detail.id &&
    form.definitionName === definition.name
      ? form
      : null;
  const complete = activeForm
    ? officialWorkflowConfigurationComplete(activeForm, definition.blueprints)
    : false;
  const submit = () => {
    if (!activeForm) {
      return;
    }
    detach(
      (async () => {
        await reconfigure(
          { workflowId: detail.id, blueprints: activeForm.blueprints },
          pageSignal,
        );
        setForm(null);
        toast.success(
          i18n.t(($) => {
            return $.workflows.official.reconfigured;
          }),
        );
      })(),
      Reason.DomCallback,
      "reconfigure Official Workflow",
    );
  };
  return (
    <Dialog
      open={activeForm !== null}
      onOpenChange={(open) => {
        if (!open) {
          setForm(null);
        }
      }}
    >
      <DialogContent smMaxWidth={680} contentClassName="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.official.reconfigureTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.official.reconfigureDialogDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {activeForm ? (
          <OfficialWorkflowConfigurationFields
            form={activeForm}
            blueprints={definition.blueprints}
            agents={[]}
            agentsLoaded
            showAgent={false}
            disabled={reconfiguring}
          />
        ) : null}
        {activeForm?.submitted && reconfigureLoadable.state === "hasError" ? (
          <Alert variant="destructive">
            <AlertTitle>
              {i18n.t(($) => {
                return $.workflows.official.reconfigureErrorTitle;
              })}
            </AlertTitle>
            <AlertDescription>
              {i18n.t(($) => {
                return $.workflows.official.reconfigureErrorDescription;
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        <WorkflowDialogFooter
          busy={reconfiguring}
          disabled={!activeForm || !complete || reconfiguring}
          cancelLabel={i18n.t(($) => {
            return $.workflows.common.cancel;
          })}
          label={i18n.t(($) => {
            return $.workflows.official.reconfigure;
          })}
          onCancel={() => {
            setForm(null);
          }}
          onConfirm={submit}
        />
      </DialogContent>
    </Dialog>
  );
}

function OfficialWorkflowUninstallDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [uninstallLoadable, uninstall] = useLoadableSet(
    uninstallOfficialWorkflow$,
  );
  const uninstalling = uninstallLoadable.state === "loading";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.official.uninstallTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.official.uninstallConfirm;
            })}
          </DialogDescription>
        </DialogHeader>
        <WorkflowDialogFooter
          busy={uninstalling}
          variant="destructive"
          cancelLabel={i18n.t(($) => {
            return $.workflows.common.cancel;
          })}
          label={i18n.t(($) => {
            return $.workflows.official.uninstall;
          })}
          onCancel={() => {
            onOpenChange(false);
          }}
          onConfirm={() => {
            detach(
              (async () => {
                await uninstall(detail.id, pageSignal);
                onOpenChange(false);
                navigate(ROUTES.workflows);
              })(),
              Reason.DomCallback,
              "uninstall Official Workflow",
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface WorkflowMetadataValues {
  readonly displayName: string;
  readonly name: string;
  readonly description: string;
}

function workflowMetadataDefaults(
  detail: WorkflowDetailResponse,
): WorkflowMetadataValues {
  return {
    displayName: detail.displayName ?? "",
    name: detail.name,
    description: detail.description ?? "",
  };
}

function isValidWorkflowSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value);
}

function WorkflowMetadataFields({
  detail,
  disabled,
  onPatch,
  values,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly disabled: boolean;
  readonly onPatch: (patch: Partial<WorkflowMetadataValues>) => void;
  readonly values: WorkflowMetadataValues;
}) {
  const copy = workflowMetadataCopy();
  const slugCommand = `/${values.name.trim() || "slug"}`;
  const ownerAgentLabel = agentLabel(detail);

  return (
    <div className="p-4 sm:p-5">
      <InlineSettingsRow
        label={copy.agent}
        description={copy.agentDescription}
        wideControls
      >
        <div className="flex h-9 w-full items-center rounded-lg border border-[hsl(var(--gray-400))] bg-gray-50 px-3 text-sm text-muted-foreground">
          <span className="truncate" title={ownerAgentLabel}>
            {ownerAgentLabel}
          </span>
        </div>
      </InlineSettingsRow>
      <InlineSettingsRow
        label={copy.name}
        description={copy.nameHelp}
        wideControls
      >
        <Input
          id="workflow-edit-display-name"
          name="displayName"
          aria-label={copy.name}
          value={values.displayName}
          onChange={(event) => {
            onPatch({ displayName: event.currentTarget.value });
          }}
          disabled={disabled}
          placeholder={copy.namePlaceholder}
          maxLength={256}
          className="h-9 w-full"
        />
      </InlineSettingsRow>
      <InlineSettingsRow
        label={copy.slug}
        description={i18n.t(
          ($) => {
            return $.workflows.detail.metadata.slugHelp;
          },
          { command: slugCommand },
        )}
        wideControls
      >
        <Input
          id="workflow-edit-slug"
          name="name"
          aria-label={copy.slug}
          value={values.name}
          onChange={(event) => {
            onPatch({ name: event.currentTarget.value });
          }}
          disabled={disabled}
          placeholder={i18n.t(($) => {
            return $.workflows.detail.metadata.slugPlaceholder;
          })}
          maxLength={64}
          required
          minLength={2}
          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          title={copy.slugTitle}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full"
        />
      </InlineSettingsRow>
      <InlineSettingsRow
        label={copy.description}
        description={copy.descriptionHelp}
        wideControls
      >
        <Textarea
          id="workflow-edit-description"
          name="description"
          aria-label={copy.description}
          value={values.description}
          onChange={(event) => {
            onPatch({ description: event.currentTarget.value });
          }}
          disabled={disabled}
          rows={3}
          maxLength={1024}
          className={WORKFLOW_EDIT_TEXTAREA_CLASS}
        />
      </InlineSettingsRow>
      <InlineSettingsRow
        label={copy.visibility}
        description={copy.visibilityHelp}
        alignControls="center"
      >
        <div className="w-full max-w-72">
          <WorkflowPublicToggle detail={detail} />
        </div>
      </InlineSettingsRow>
    </div>
  );
}

function WorkflowMetadataForm({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const copy = workflowMetadataCopy();
  const pageSignal = useGet(pageSignal$);
  const patch = useGet(workflowMetadataPatch$);
  const patchForm = useSet(patchWorkflowMetadataForm$);
  const resetForm = useSet(resetWorkflowMetadataForm$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const canEdit = detail.canManage && !detail.official;
  const disabled = !canEdit || saving;
  const defaults = workflowMetadataDefaults(detail);
  const values =
    canEdit && patch?.workflowId === detail.id
      ? { ...defaults, ...patch }
      : defaults;
  const dirty =
    values.displayName !== defaults.displayName ||
    values.name !== defaults.name ||
    values.description !== defaults.description;
  const patchValues = (patch: Partial<WorkflowMetadataValues>) => {
    if (!canEdit || saving) {
      return;
    }
    patchForm({ workflowId: detail.id, patch });
  };
  const save = () => {
    if (!canEdit) {
      return;
    }
    const nextDisplayName = values.displayName.trim();
    const nextName = values.name.trim();
    const nextDescription = values.description.trim();
    if (!isValidWorkflowSlug(nextName)) {
      return;
    }
    detach(
      (async () => {
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: {
              name: nextName,
              displayName: nextDisplayName || null,
              description: nextDescription || null,
            },
          },
          pageSignal,
        );
        toast.success(copy.saved);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <form
        aria-label={copy.aria}
        className={surfaceVariants({ className: "overflow-hidden" })}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!event.currentTarget.checkValidity()) {
            return;
          }
          save();
        }}
      >
        <WorkflowMetadataFields
          detail={detail}
          disabled={disabled}
          onPatch={patchValues}
          values={values}
        />
      </form>
      {canEdit && dirty ? (
        <UnsavedBar onDiscard={resetForm} onSave={save} saving={saving} />
      ) : null}
    </>
  );
}

function WorkflowInstructionsTab({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3">
      <div
        className={surfaceVariants({ className: "overflow-hidden px-5 pb-5" })}
      >
        <WorkflowFilePreview detail={detail} />
      </div>
    </div>
  );
}

function ShadowWarning({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  if (!detail.shadowedBy) {
    return null;
  }

  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <p className="min-w-0">
        <span className="font-medium">/{detail.name}</span>{" "}
        {i18n.t(($) => {
          return $.workflows.detail.shadow.resolvesTo;
        })}{" "}
        <span className="font-medium">{workflowTitle(detail.shadowedBy)}</span>{" "}
        {i18n.t(($) => {
          return $.workflows.detail.shadow.end;
        })}
      </p>
    </div>
  );
}

function WorkflowPublicToggle({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const copy = workflowVisibilityCopy();
  const pageSignal = useGet(pageSignal$);
  const [changeLoadable, changeVisibility] = useLoadableSet(
    changeWorkflowVisibility$,
  );
  const demoteConfirmOpen = useGet(workflowDemoteConfirmOpen$);
  const setDemoteConfirmOpen = useSet(setWorkflowDemoteConfirmOpen$);
  const busy = changeLoadable.state === "loading";
  const isPublic = detail.visibility === "public";
  const statusLabel = isPublic ? copy.public : copy.private;
  const publishBlocked =
    !detail.official &&
    detail.visibility === "private" &&
    detail.canManage &&
    !detail.canPublish;
  const toggleAction: Parameters<typeof changeVisibility>[0]["action"] | null =
    detail.official
      ? null
      : isPublic
        ? detail.canManage
          ? "demote"
          : null
        : detail.canPublish
          ? "publish"
          : null;
  const submitVisibilityAction = (
    action: Parameters<typeof changeVisibility>[0]["action"],
  ) => {
    detach(
      changeVisibility({ workflowId: detail.id, action }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">{statusLabel}</span>
        <Switch
          size="compact"
          aria-label={copy.publishAria}
          checked={isPublic}
          disabled={busy || !toggleAction}
          onCheckedChange={() => {
            if (!toggleAction) {
              return;
            }
            if (toggleAction === "demote") {
              setDemoteConfirmOpen(true);
              return;
            }
            submitVisibilityAction(toggleAction);
          }}
        />
      </div>
      {publishBlocked ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {copy.adminRequired}
        </p>
      ) : null}
      <Dialog open={demoteConfirmOpen} onOpenChange={setDemoteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.confirmTitle}</DialogTitle>
            <DialogDescription>{copy.confirmDescription}</DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle size={16} />
            <AlertTitle>{copy.automationWarning}</AlertTitle>
            <AlertDescription>
              {i18n.t(
                ($) => {
                  return $.workflows.detail.visibility.workflowHidden;
                },
                { title: workflowTitle(detail) },
              )}
            </AlertDescription>
          </Alert>
          <WorkflowDialogFooter
            busy={busy}
            variant="destructive"
            cancelLabel={copy.cancel}
            label={copy.makePrivate}
            onCancel={() => {
              setDemoteConfirmOpen(false);
            }}
            onConfirm={() => {
              setDemoteConfirmOpen(false);
              submitVisibilityAction("demote");
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface WorkflowCopyAgent {
  readonly agentId: string;
  readonly displayName: string | null;
}

function workflowCopyRemovalDescription({
  enabledSourceAutomationCount,
  sourceAgentName,
}: {
  readonly enabledSourceAutomationCount: number;
  readonly sourceAgentName: string;
}): string {
  if (enabledSourceAutomationCount === 0) {
    return i18n.t(
      ($) => {
        return $.workflows.detail.copy.removalNoAutomations;
      },
      { agent: sourceAgentName },
    );
  }
  return i18n.t(
    ($) => {
      return $.workflows.detail.copy.removalWithAutomations;
    },
    {
      count: enabledSourceAutomationCount,
      agent: sourceAgentName,
    },
  );
}

function notifyWorkflowCopySuccess({
  agentName,
  sourceAgentName,
  removedOriginal,
  onView,
}: {
  readonly agentName: string;
  readonly sourceAgentName: string;
  readonly removedOriginal: boolean;
  readonly onView: () => void;
}): void {
  if (removedOriginal) {
    toast.success(
      i18n.t(
        ($) => {
          return $.workflows.detail.copy.moved;
        },
        { agent: agentName },
      ),
      {
        description: i18n.t(
          ($) => {
            return $.workflows.detail.copy.moveDescription;
          },
          { agent: sourceAgentName },
        ),
      },
    );
    return;
  }
  toast.success(
    i18n.t(
      ($) => {
        return $.workflows.detail.copy.copied;
      },
      { agent: agentName },
    ),
    {
      description: i18n.t(($) => {
        return $.workflows.detail.copy.privateReady;
      }),
      action: {
        label: i18n.t(($) => {
          return $.workflows.common.view;
        }),
        onClick: onView,
      },
    },
  );
}

function WorkflowCopyForm({
  agents,
  agentsLoaded,
  form,
  onChange,
  sourceAgentName,
  enabledSourceAutomationCount,
}: {
  readonly agents: readonly WorkflowCopyAgent[];
  readonly agentsLoaded: boolean;
  readonly form: WorkflowCopyFormState;
  readonly onChange: (form: WorkflowCopyFormState) => void;
  readonly sourceAgentName: string;
  readonly enabledSourceAutomationCount: number;
}) {
  const noAgents = agentsLoaded && agents.length === 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.workflows.detail.copy.to;
          })}
        </span>
        {noAgents ? (
          <p className="text-sm text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.detail.copy.noAgents;
            })}
          </p>
        ) : (
          <Select
            value={form.selectedAgentId}
            disabled={!agentsLoaded}
            onValueChange={(value) => {
              onChange({ ...form, selectedAgentId: value });
            }}
          >
            <SelectTrigger
              className="h-9 w-full"
              aria-label={i18n.t(($) => {
                return $.workflows.detail.copy.to;
              })}
            >
              <SelectValue
                placeholder={i18n.t(($) => {
                  return $.workflows.detail.copy.selectAgent;
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => {
                return (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    {agent.displayName ?? agent.agentId}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={form.removeOriginal}
          className="mt-0.5"
          onCheckedChange={(checked) => {
            onChange({ ...form, removeOriginal: checked === true });
          }}
        />
        <span className="text-sm text-foreground">
          {i18n.t(
            ($) => {
              return $.workflows.detail.copy.removeOriginal;
            },
            { agent: sourceAgentName },
          )}
        </span>
      </label>
      {form.removeOriginal ? (
        <Alert variant="destructive">
          <AlertTriangle size={16} />
          <AlertTitle>
            {i18n.t(($) => {
              return $.workflows.detail.copy.removalAlert;
            })}
          </AlertTitle>
          <AlertDescription>
            {workflowCopyRemovalDescription({
              enabledSourceAutomationCount,
              sourceAgentName,
            })}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function WorkflowCopyDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const form = useGet(workflowCopyForm$);
  const setForm = useSet(setWorkflowCopyForm$);
  const agentsLoadable = useLoadable(agents$);
  const agentsLoaded = agentsLoadable.state === "hasData";
  const agents = agentsLoaded
    ? agentsLoadable.data.filter((agent) => {
        return agent.agentId !== detail.agentId;
      })
    : [];
  const sourceAgentName = agentLabel(detail);
  const enabledSourceAutomationIds = detail.automations
    .filter((automation) => {
      return automation.enabled;
    })
    .map((automation) => {
      return automation.id;
    });
  const selectedAgent = agents.find((agent) => {
    return agent.agentId === form.selectedAgentId;
  });
  const agentName =
    selectedAgent?.displayName ??
    form.selectedAgentId ??
    i18n.t(($) => {
      return $.workflows.detail.copy.agentFallback;
    });
  const { submit, submitting } = useWorkflowCopySubmission({
    agentName,
    detail,
    enabledSourceAutomationIds,
    form,
    onOpenChange,
    sourceAgentName,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent smMaxWidth={560}>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.detail.copy.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.detail.copy.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <WorkflowCopyForm
          agents={agents}
          agentsLoaded={agentsLoaded}
          form={form}
          onChange={setForm}
          sourceAgentName={sourceAgentName}
          enabledSourceAutomationCount={enabledSourceAutomationIds.length}
        />
        <WorkflowDialogFooter
          busy={submitting}
          disabled={!form.selectedAgentId || submitting || agents.length === 0}
          cancelLabel={i18n.t(($) => {
            return $.workflows.common.cancel;
          })}
          label={
            form.removeOriginal
              ? i18n.t(($) => {
                  return $.workflows.detail.copy.copyAndRemove;
                })
              : i18n.t(($) => {
                  return $.workflows.common.copyWorkflow;
                })
          }
          onCancel={() => {
            onOpenChange(false);
          }}
          onConfirm={submit}
        />
      </DialogContent>
    </Dialog>
  );
}

function useWorkflowCopySubmission({
  agentName,
  detail,
  enabledSourceAutomationIds,
  form,
  onOpenChange,
  sourceAgentName,
}: {
  readonly agentName: string;
  readonly detail: WorkflowDetailResponse;
  readonly enabledSourceAutomationIds: readonly string[];
  readonly form: WorkflowCopyFormState;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceAgentName: string;
}): { readonly submit: () => void; readonly submitting: boolean } {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [copyLoadable, copyWorkflow] = useLoadableSet(copyWorkflow$);
  const [pauseLoadable, pauseWorkflowAutomations] = useLoadableSet(
    pauseWorkflowAutomations$,
  );
  const [deleteLoadable, deleteWorkflow] = useLoadableSet(deleteWorkflow$);
  const [uninstallLoadable, uninstallOfficialWorkflow] = useLoadableSet(
    uninstallOfficialWorkflow$,
  );
  const submitting =
    copyLoadable.state === "loading" ||
    pauseLoadable.state === "loading" ||
    deleteLoadable.state === "loading" ||
    uninstallLoadable.state === "loading";
  const navigateToCopy = (workflowId: string) => {
    navigate(ROUTES.workflowDetailAutomations, {
      pathParams: { workflowId },
    });
  };
  const submit = () => {
    const toAgentId = form.selectedAgentId;
    if (!toAgentId) {
      return;
    }
    detach(
      (async () => {
        const copied = await copyWorkflow(
          { workflowId: detail.id, toAgentId },
          pageSignal,
        );
        let removedOriginal = false;
        let officialUninstallFailed = false;
        if (form.removeOriginal && detail.official) {
          const removal = await settle(
            uninstallOfficialWorkflow(detail.id, pageSignal),
            pageSignal,
          );
          removedOriginal = removal.ok;
          officialUninstallFailed = !removal.ok;
        } else if (form.removeOriginal) {
          if (enabledSourceAutomationIds.length > 0) {
            await pauseWorkflowAutomations(
              [...enabledSourceAutomationIds],
              pageSignal,
            );
          }
          await deleteWorkflow(detail.id, pageSignal);
          removedOriginal = true;
        }
        onOpenChange(false);
        if (form.removeOriginal) {
          navigateToCopy(copied.id);
        }
        notifyWorkflowCopySuccess({
          agentName,
          sourceAgentName,
          removedOriginal,
          onView: () => {
            navigateToCopy(copied.id);
          },
        });
        if (officialUninstallFailed) {
          toast.error(
            i18n.t(($) => {
              return $.workflows.official.copySucceededUninstallFailed;
            }),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };
  return { submit, submitting };
}

function WorkflowDeleteDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [deleteLoadable, deleteWorkflow] = useLoadableSet(deleteWorkflow$);
  const deleting = deleteLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.detail.delete.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.detail.delete.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {i18n.t(
            ($) => {
              return $.workflows.detail.delete.confirm;
            },
            { title: workflowTitle(detail) },
          )}
        </div>
        <WorkflowDialogFooter
          busy={deleting}
          variant="destructive"
          cancelLabel={i18n.t(($) => {
            return $.workflows.common.cancel;
          })}
          label={i18n.t(($) => {
            return $.workflows.common.delete;
          })}
          onCancel={() => {
            onOpenChange(false);
          }}
          onConfirm={() => {
            detach(
              (async () => {
                await deleteWorkflow(detail.id, pageSignal);
                onOpenChange(false);
                navigate(ROUTES.workflows);
              })(),
              Reason.DomCallback,
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function WorkflowFilePicker({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);
  const files: readonly WorkflowFileMetadata[] = detail.files ?? [];
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const selectedLabel =
    selectedFilePath ??
    i18n.t(($) => {
      return $.workflows.detail.files.instructions;
    });
  const uploadFiles = (selected: FileList) => {
    detach(
      (async () => {
        const uploaded = await readUploadedWorkflowFiles(selected);
        const byPath = new Map(
          fileContents.map((file) => {
            return [file.path, file];
          }),
        );
        for (const file of uploaded) {
          byPath.set(file.path, file);
        }
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: { files: [...byPath.values()] },
          },
          pageSignal,
        );
        setSelectedFilePath(uploaded[0]?.path ?? null);
      })(),
      Reason.DomCallback,
    );
  };
  const deleteSelectedFile = () => {
    if (!selectedFilePath) {
      return;
    }
    detach(
      (async () => {
        const nextFiles = fileContents.filter((file) => {
          return file.path !== selectedFilePath;
        });
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: { files: nextFiles },
          },
          pageSignal,
        );
        setSelectedFilePath(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={i18n.t(($) => {
            return $.workflows.detail.files.aria;
          })}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm px-0.5 py-0.5 text-sm font-medium text-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">{selectedLabel}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <WorkflowFileNavigationItems
          files={files}
          selectedFilePath={selectedFilePath}
          onSelectFile={setSelectedFilePath}
        />
        {detail.canManage && !detail.official ? (
          <WorkflowFileManagementItems
            saving={saving}
            selectedFilePath={selectedFilePath}
            onUpload={uploadFiles}
            onDeleteSelectedFile={deleteSelectedFile}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkflowFileNavigationItems({
  files,
  selectedFilePath,
  onSelectFile,
}: {
  readonly files: readonly WorkflowFileMetadata[];
  readonly selectedFilePath: string | null;
  readonly onSelectFile: (filePath: string | null) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        className={cn(!selectedFilePath ? "bg-muted" : "")}
        onSelect={() => {
          onSelectFile(null);
        }}
      >
        {i18n.t(($) => {
          return $.workflows.detail.files.instructions;
        })}
      </DropdownMenuItem>
      {files.map((file) => {
        return (
          <DropdownMenuItem
            key={file.path}
            className={cn(selectedFilePath === file.path ? "bg-muted" : "")}
            onSelect={() => {
              onSelectFile(file.path);
            }}
          >
            <span className="min-w-0 truncate">{file.path}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {i18n.t(
                ($) => {
                  return $.workflows.detail.files.sizeBytes;
                },
                { size: file.size },
              )}
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function WorkflowFileManagementItems({
  saving,
  selectedFilePath,
  onUpload,
  onDeleteSelectedFile,
}: {
  readonly saving: boolean;
  readonly selectedFilePath: string | null;
  readonly onUpload: (files: FileList) => void;
  readonly onDeleteSelectedFile: () => void;
}) {
  return (
    <>
      <div className="my-1 h-px bg-divider/60" />
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground",
          saving ? "pointer-events-none opacity-60" : "",
        )}
      >
        {saving ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Upload size={15} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.detail.files.upload;
          })}
        </span>
        <input
          aria-label={i18n.t(($) => {
            return $.workflows.detail.files.uploadAria;
          })}
          type="file"
          multiple
          disabled={saving}
          className="sr-only"
          onChange={(event) => {
            const selected = event.currentTarget.files;
            if (!selected || selected.length === 0) {
              return;
            }
            onUpload(selected);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {selectedFilePath ? (
        <button
          type="button"
          aria-label={i18n.t(
            ($) => {
              return $.workflows.detail.files.deleteAria;
            },
            { path: selectedFilePath },
          )}
          disabled={saving}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-state-hover disabled:opacity-60"
          onClick={onDeleteSelectedFile}
        >
          <Trash size={15} />
          <span>
            {i18n.t(($) => {
              return $.workflows.detail.files.deleteSelected;
            })}
          </span>
        </button>
      ) : null}
    </>
  );
}

function workflowDraftUpdateBody(
  selectedFilePath: string | null,
  draft: string,
  fileContents: readonly WorkflowFileEntry[],
): WorkflowUpdateRequest {
  if (!selectedFilePath) {
    return { instruction: draft || null };
  }

  return {
    files: fileContents.map((file) => {
      return file.path === selectedFilePath
        ? { path: file.path, content: draft }
        : file;
    }),
  };
}

function selectedWorkflowFile(
  fileContents: readonly WorkflowFileEntry[],
  selectedFilePath: string | null,
): WorkflowFileEntry | null {
  if (!selectedFilePath) {
    return null;
  }

  return (
    fileContents.find((file) => {
      return file.path === selectedFilePath;
    }) ?? null
  );
}

function workflowSelectedSourceContent(
  detail: WorkflowDetailResponse,
  selectedFilePath: string | null,
  selectedFile: WorkflowFileEntry | null,
): string {
  if (!selectedFilePath) {
    return detail.instruction ?? "";
  }

  return selectedFile?.content ?? "";
}

function WorkflowFilePreview({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const selectedFile = selectedWorkflowFile(fileContents, selectedFilePath);
  const sourceContent = workflowSelectedSourceContent(
    detail,
    selectedFilePath,
    selectedFile,
  );

  if (selectedFilePath && !selectedFile) {
    return (
      <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.detail.files.noContent;
        })}
      </div>
    );
  }

  return (
    <WorkflowSelectedFileEditor
      detail={detail}
      fileContents={fileContents}
      selectedFilePath={selectedFilePath}
      sourceContent={sourceContent}
    />
  );
}

function WorkflowSelectedFileEditor({
  detail,
  fileContents,
  selectedFilePath,
  sourceContent,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly fileContents: readonly WorkflowFileEntry[];
  readonly selectedFilePath: string | null;
  readonly sourceContent: string;
}) {
  const draftState = useGet(workflowFileDraft$);
  const setDraftState = useSet(setWorkflowFileDraft$);
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const canEdit = detail.canManage && !detail.official;
  const draftMatches =
    draftState?.workflowId === detail.id &&
    draftState.filePath === selectedFilePath &&
    draftState.sourceContent === sourceContent;
  const draft = canEdit && draftMatches ? draftState.content : null;
  const content = draft ?? sourceContent;
  const dirty = draft !== null && draft !== sourceContent;
  const markdown =
    selectedFilePath === null || isMarkdownPath(selectedFilePath);
  const setDraft = (nextContent: string) => {
    if (!canEdit || saving) {
      return;
    }
    setDraftState({
      workflowId: detail.id,
      filePath: selectedFilePath,
      sourceContent,
      content: nextContent,
    });
  };

  const saveDraft = () => {
    if (!canEdit || draft === null) {
      return;
    }
    const body = workflowDraftUpdateBody(selectedFilePath, draft, fileContents);
    detach(
      (async () => {
        await updateWorkflow(
          {
            workflowId: detail.id,
            body,
          },
          pageSignal,
        );
        setDraftState(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 flex-col">
      {markdown ? (
        <TiptapInstructionsEditor
          key={`${detail.id}:${selectedFilePath ?? "instructions"}:${sourceContent}`}
          initialContent={content}
          onChange={setDraft}
          disabled={!canEdit || saving}
          footerHint={null}
          surface="canvas"
          ariaLabel={
            selectedFilePath
              ? i18n.t(($) => {
                  return $.workflows.detail.files.fileContent;
                })
              : i18n.t(($) => {
                  return $.workflows.detail.files.instruction;
                })
          }
          placeholder={
            selectedFilePath
              ? i18n.t(($) => {
                  return $.workflows.detail.files.filePlaceholder;
                })
              : i18n.t(($) => {
                  return $.workflows.detail.files.instructionPlaceholder;
                })
          }
        />
      ) : (
        <textarea
          aria-label={i18n.t(($) => {
            return $.workflows.detail.files.fileContent;
          })}
          value={content}
          disabled={!canEdit || saving}
          spellCheck={false}
          className="min-h-[calc(100vh-10rem)] w-full resize-none bg-transparent px-0 py-3 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
      )}
      {canEdit && dirty ? (
        <UnsavedBar
          saving={saving}
          onDiscard={() => {
            setDraftState(null);
          }}
          onSave={saveDraft}
        />
      ) : null}
    </div>
  );
}

async function readUploadedWorkflowFiles(
  files: FileList,
): Promise<WorkflowFileEntry[]> {
  return await Promise.all(
    Array.from(files).map(async (file) => {
      const uploadFile = file as File & {
        readonly webkitRelativePath?: string;
      };
      const path = (uploadFile.webkitRelativePath || file.name).replace(
        /^\.\//,
        "",
      );
      return { path, content: await file.text() };
    }),
  );
}

function browserTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timezoneDisplayName(timezone: string): string {
  return timezone.replace(/_/g, " ");
}

function formatClockTime(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 1, hour, minute)));
}

function formatDateInTimezone(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "medium",
    timeZone: timezone,
  }).format(new Date(value));
}

function getWorkflowMinuteOptions(currentMinute: number): readonly number[] {
  if (WORKFLOW_CRON_MINUTE_OPTIONS.includes(currentMinute)) {
    return WORKFLOW_CRON_MINUTE_OPTIONS;
  }
  return [...WORKFLOW_CRON_MINUTE_OPTIONS, currentMinute].sort((a, b) => {
    return a - b;
  });
}

function parseCronNumber(
  value: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function normalizeCronDayOfWeek(day: number): number {
  return day === 7 ? 0 : day;
}

function parseCronDayOfWeekList(value: string): readonly number[] | null {
  const days: number[] = [];
  for (const part of value.split(",")) {
    const [startRaw, endRaw] = part.split("-");
    const start = parseCronNumber(startRaw, 0, 7);
    const end = parseCronNumber(endRaw ?? startRaw, 0, 7);
    if (start === null || end === null) {
      return null;
    }
    const normalizedStart = normalizeCronDayOfWeek(start);
    const normalizedEnd = normalizeCronDayOfWeek(end);
    if (normalizedStart <= normalizedEnd) {
      for (let day = normalizedStart; day <= normalizedEnd; day += 1) {
        days.push(day);
      }
    } else {
      for (let day = normalizedStart; day <= 6; day += 1) {
        days.push(day);
      }
      for (let day = 0; day <= normalizedEnd; day += 1) {
        days.push(day);
      }
    }
  }
  const unique = [...new Set(days)];
  return unique.length > 0
    ? unique.sort((a, b) => {
        return a - b;
      })
    : null;
}

function shiftCronDays(
  days: readonly number[],
  dayOffset: number,
): readonly number[] {
  return [
    ...new Set(
      days.map((day) => {
        return (day + dayOffset + 7) % 7;
      }),
    ),
  ].sort((a, b) => {
    return a - b;
  });
}

function formatCronDayOfWeekList(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => {
    return a - b;
  });
  const weekdays = [1, 2, 3, 4, 5];
  if (
    sorted.length === weekdays.length &&
    sorted.every((day, index) => {
      return day === weekdays[index];
    })
  ) {
    return "1-5";
  }
  return sorted.join(",");
}

function sameNumberList(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => {
      return value === b[index];
    })
  );
}

function shiftedDayOfMonth(
  dayOfMonth: string,
  dayOffset: number,
): string | null {
  const day = parseCronNumber(dayOfMonth, 1, 31);
  if (day === null) {
    return null;
  }
  const shifted = day + dayOffset;
  return shifted >= 1 && shifted <= 31 ? String(shifted) : String(day);
}

function parseWorkflowCronFields(
  schedule: Extract<WorkflowSchedule, { type: "cron" }>,
  displayTimezone: string,
): WorkflowCronFields {
  const parts = schedule.cronExpression.trim().split(/\s+/u);
  const minute = parseCronNumber(parts[0], 0, 59);
  const hour = parseCronNumber(parts[1], 0, 23);
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";
  if (parts.length !== 5 || minute === null || hour === null) {
    return {
      ...defaultWorkflowCronFields(),
      frequency: "custom",
      customCronExpression: schedule.cronExpression,
    };
  }

  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    schedule.timezone || AUTOMATION_TIMEZONE,
    displayTimezone,
  );
  const base = {
    ...defaultWorkflowCronFields(),
    hour: converted.hour,
    minute: converted.minute,
    customCronExpression: schedule.cronExpression,
  };

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return { ...base, frequency: "every_day" };
  }

  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    const displayDayOfMonth = shiftedDayOfMonth(
      dayOfMonth,
      converted.dayOffset,
    );
    return displayDayOfMonth
      ? { ...base, frequency: "every_month", dayOfMonth: displayDayOfMonth }
      : { ...base, frequency: "custom" };
  }

  if (dayOfMonth === "*" && dayOfWeek !== "*") {
    const utcDays = parseCronDayOfWeekList(dayOfWeek);
    if (!utcDays) {
      return { ...base, frequency: "custom" };
    }
    const displayDays = shiftCronDays(utcDays, converted.dayOffset);
    if (sameNumberList(displayDays, [1, 2, 3, 4, 5])) {
      return {
        ...base,
        frequency: "every_weekday",
        dayOfWeek: "1,2,3,4,5",
      };
    }
    return {
      ...base,
      frequency: "every_week",
      dayOfWeek: formatCronDayOfWeekList(displayDays),
    };
  }

  return { ...base, frequency: "custom" };
}

function buildUtcCronExpressionFromFields(
  fields: WorkflowCronFields,
  displayTimezone: string,
): string | null {
  if (fields.frequency === "custom") {
    const cronExpression = fields.customCronExpression.trim();
    return cronExpression.length > 0 ? cronExpression : null;
  }

  const converted = cronWallTimeInTimezone(
    fields.hour,
    fields.minute,
    displayTimezone,
    AUTOMATION_TIMEZONE,
  );
  const minute = String(converted.minute);
  const hour = String(converted.hour);

  if (fields.frequency === "every_weekday") {
    const days = shiftCronDays([1, 2, 3, 4, 5], converted.dayOffset);
    return `${minute} ${hour} * * ${formatCronDayOfWeekList(days)}`;
  }
  if (fields.frequency === "every_week") {
    const displayDays = parseCronDayOfWeekList(fields.dayOfWeek);
    if (!displayDays) {
      return null;
    }
    const days = shiftCronDays(displayDays, converted.dayOffset);
    return `${minute} ${hour} * * ${formatCronDayOfWeekList(days)}`;
  }
  if (fields.frequency === "every_month") {
    const dayOfMonth = shiftedDayOfMonth(
      fields.dayOfMonth,
      converted.dayOffset,
    );
    return dayOfMonth ? `${minute} ${hour} ${dayOfMonth} * *` : null;
  }

  return buildCronExpression({
    timeOption: WORKFLOW_CRON_FREQUENCY_TO_TIME_OPTION[fields.frequency],
    hour,
    minute,
  });
}

function workflowScheduleTitle(
  automation: WorkflowAutomationSummary,
  displayTimezone: string,
): string {
  if (automation.kind !== "schedule") {
    return workflowAutomationTitle(automation);
  }
  const schedule = automation.schedule;
  if (schedule.type === "loop") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.repeatEvery;
      },
      {
        interval: formatWorkflowIntervalSeconds(schedule.intervalSeconds),
      },
    );
  }
  if (schedule.type === "once") {
    const { hour, minute } = atTimeInTimezone(schedule.atTime, displayTimezone);
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.onceOn;
      },
      {
        date: formatDateInTimezone(schedule.atTime, displayTimezone),
        time: formatClockTime(hour, minute),
      },
    );
  }

  const fields = parseWorkflowCronFields(schedule, displayTimezone);
  if (fields.frequency === "custom") {
    return `${schedule.cronExpression} (${AUTOMATION_TIMEZONE})`;
  }
  const time = formatClockTime(fields.hour, fields.minute);
  if (fields.frequency === "every_day") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.everyDayAt;
      },
      { time },
    );
  }
  if (fields.frequency === "every_weekday") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.everyWeekdayAt;
      },
      { time },
    );
  }
  if (fields.frequency === "every_month") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.everyMonthAt;
      },
      { day: fields.dayOfMonth, time },
    );
  }
  const dayLabels = fields.dayOfWeek
    .split(",")
    .map((day) => {
      return workflowDayOfWeekOptions().find(([value]) => {
        return value === day;
      })?.[1];
    })
    .filter(Boolean)
    .join(", ");
  return dayLabels
    ? i18n.t(
        ($) => {
          return $.workflows.automations.schedule.everyWeekOn;
        },
        { days: dayLabels, time },
      )
    : i18n.t(
        ($) => {
          return $.workflows.automations.schedule.everyWeekAt;
        },
        { time },
      );
}

function buildAutomationSchedule(
  type: WorkflowScheduleType,
  fields: {
    readonly cronFields: WorkflowCronFields;
    readonly intervalSeconds: string;
    readonly atTime: string;
  },
  displayTimezone: string,
): WorkflowSchedule | null {
  if (type === "cron") {
    const cronExpression = buildUtcCronExpressionFromFields(
      fields.cronFields,
      displayTimezone,
    );
    return cronExpression
      ? { type: "cron", cronExpression, timezone: AUTOMATION_TIMEZONE }
      : null;
  }
  if (type === "loop") {
    const intervalSeconds = Number(fields.intervalSeconds);
    return Number.isInteger(intervalSeconds) && intervalSeconds > 0
      ? { type: "loop", intervalSeconds }
      : null;
  }
  if (!fields.atTime) {
    return null;
  }
  const atTime = new Date(fields.atTime);
  return Number.isNaN(atTime.getTime())
    ? null
    : {
        type: "once",
        atTime: atTime.toISOString(),
        timezone: AUTOMATION_TIMEZONE,
      };
}

function localDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function gmailMatchConditions(
  config?: GmailNewMessageEventConfig,
): GmailMatchCondition[] {
  const conditions: GmailMatchCondition[] = [];
  for (const { field } of GMAIL_TEXT_FIELDS) {
    for (const { operator } of GMAIL_TEXT_OPERATORS) {
      const value = config?.match?.[field]?.[operator];
      if (typeof value === "string" && value.length > 0) {
        conditions.push({ field, operator, value });
      } else if (Array.isArray(value) && value.length > 0) {
        conditions.push({ field, operator, value: value.join(", ") });
      }
    }
  }
  if (config?.threadId) {
    conditions.push({
      field: "threadId",
      operator: "is",
      value: config.threadId,
    });
  }
  return conditions.length > 0
    ? conditions
    : [{ field: "from", operator: "contains", value: "" }];
}

function nextGmailMatchCondition(
  conditions: readonly GmailMatchCondition[],
): GmailMatchCondition | null {
  for (const { operator } of GMAIL_TEXT_OPERATORS) {
    for (const { field } of GMAIL_TEXT_FIELDS) {
      const used = conditions.some((condition) => {
        return condition.field === field && condition.operator === operator;
      });
      if (!used) {
        return { field, operator, value: "" };
      }
    }
  }
  const threadIdUsed = conditions.some((condition) => {
    return condition.field === "threadId";
  });
  if (!threadIdUsed) {
    return { field: "threadId", operator: "is", value: "" };
  }
  return null;
}

function gmailMatchFieldOption(
  value: string,
): (typeof GMAIL_MATCH_FIELDS)[number] {
  const option = GMAIL_MATCH_FIELDS.find((candidate) => {
    return candidate.field === value;
  });
  if (!option) {
    throw new Error(`Unknown Gmail match field: ${value}`);
  }
  return option;
}

function gmailMatchOperatorOptions(
  field: GmailMatchField,
): readonly GmailMatchOperatorOption[] {
  return field === "threadId"
    ? [
        {
          operator: "is",
          label: i18n.t(($) => {
            return $.workflows.automations.gmail.operator.is;
          }),
          formSuffix: "",
        },
      ]
    : GMAIL_TEXT_OPERATORS;
}

function gmailMatchOperatorOption(
  field: GmailMatchField,
  value: string,
): GmailMatchOperatorOption {
  const option = gmailMatchOperatorOptions(field).find((candidate) => {
    return candidate.operator === value;
  });
  if (!option) {
    throw new Error(`Unknown Gmail match operator: ${value}`);
  }
  return option;
}

function gmailMatchOperatorForField(
  field: GmailMatchField,
  operator: GmailMatchOperator,
): GmailMatchOperator {
  if (field === "threadId") {
    return "is";
  }
  return operator === "is" ? "contains" : operator;
}

type GoogleCalendarAutomationEventType =
  | "google-calendar-event-created"
  | "google-calendar-event-updated"
  | "google-calendar-event-cancelled";

function googleCalendarIdFromForm(form: FormData): string {
  return formTextValue(form, "calendarId") ?? "primary";
}

function updatedGoogleCalendarEventConfig(
  automation: GoogleCalendarWorkflowAutomationSummary,
  calendarId: string,
): GoogleCalendarAutomationEventConfig {
  switch (automation.eventType) {
    case "google-calendar-event-created": {
      return { ...automation.eventConfig, calendarId };
    }
    case "google-calendar-event-updated": {
      return { ...automation.eventConfig, calendarId };
    }
    case "google-calendar-event-cancelled": {
      return { ...automation.eventConfig, calendarId };
    }
  }
}

function githubSubjectFilterValue(
  value: FormDataEntryValue | null,
  fallback: GithubIssueCommentSubjectFilter,
): GithubIssueCommentSubjectFilter {
  if (value === "both" || value === "issues" || value === "pull_requests") {
    return value;
  }
  return fallback;
}

function githubPullRequestActionValue(
  value: FormDataEntryValue | null,
  fallback: GithubPullRequestAction,
): GithubPullRequestAction {
  const option = GITHUB_PULL_REQUEST_ACTION_OPTIONS.find((candidate) => {
    return candidate.value === value;
  });
  return option?.value ?? fallback;
}

function githubWorkflowRunFilterValues(
  form: FormData,
  name: string,
): string[] | undefined {
  const value = formTextValue(form, name);
  if (!value) {
    return undefined;
  }
  const values = Array.from(
    new Set(
      value
        .split(/[,\n]/u)
        .map((part) => {
          return part.trim();
        })
        .filter(Boolean),
    ),
  );
  return values.length > 0 ? values : undefined;
}

function githubWorkflowRunConclusions(
  form: FormData,
): GithubWorkflowRunConclusion[] | undefined {
  const values = form
    .getAll("conclusions")
    .filter((value): value is GithubWorkflowRunConclusion => {
      return (
        typeof value === "string" &&
        GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS.some((option) => {
          return option.value === value;
        })
      );
    });
  return values.length > 0 ? values : undefined;
}

function buildGithubWorkflowRunCompletedEventConfig(
  form: FormData,
): GithubWorkflowRunCompletedEventConfig {
  return {
    provider: "github",
    event: "workflow_run_completed",
    filters: {
      repositories: githubWorkflowRunFilterValues(form, "repositories"),
      workflows: githubWorkflowRunFilterValues(form, "workflows"),
      conclusions: githubWorkflowRunConclusions(form),
      branches: githubWorkflowRunFilterValues(form, "branches"),
      events: githubWorkflowRunFilterValues(form, "events"),
      actors: githubWorkflowRunFilterValues(form, "actors"),
    },
  };
}

type GithubWebhookAutomationEventType =
  | "github-pull-request"
  | "github-workflow-job-completed"
  | "github-pull-request-review-submitted"
  | "github-deployment-status-created"
  | "github-issue-comment-created";

type GithubWebhookAutomationEventConfig =
  | GithubPullRequestEventConfig
  | GithubWorkflowJobCompletedEventConfig
  | GithubPullRequestReviewSubmittedEventConfig
  | GithubDeploymentStatusCreatedEventConfig
  | GithubIssueCommentCreatedEventConfig;

function checkedGithubValues<T extends string>(
  form: FormData,
  name: string,
  options: readonly { readonly value: T }[],
): T[] | undefined {
  const values = form.getAll(name).filter((value): value is T => {
    return (
      typeof value === "string" &&
      options.some((option) => {
        return option.value === value;
      })
    );
  });
  return values.length > 0 ? values : undefined;
}

function buildGithubWebhookEventConfig(
  eventType: GithubWebhookAutomationEventType,
  form: FormData,
): GithubWebhookAutomationEventConfig {
  if (eventType === "github-pull-request") {
    const action = githubPullRequestActionValue(form.get("action"), "closed");
    const merged = form.get("merged");
    return {
      provider: "github",
      event: "pull_request",
      repository: formTextValue(form, "repository") ?? "",
      action,
      ...(action === "closed" && (merged === "true" || merged === "false")
        ? { merged: merged === "true" }
        : {}),
      filters: {
        baseBranches: githubWorkflowRunFilterValues(form, "baseBranches"),
        authors: githubWorkflowRunFilterValues(form, "authors"),
        pullRequestNumbers: githubWorkflowRunFilterValues(
          form,
          "pullRequestNumbers",
        ),
        labels: githubWorkflowRunFilterValues(form, "labels"),
      },
    };
  }
  if (eventType === "github-workflow-job-completed") {
    return {
      provider: "github",
      event: "workflow_job_completed",
      filters: {
        repositories: githubWorkflowRunFilterValues(form, "repositories"),
        workflows: githubWorkflowRunFilterValues(form, "workflows"),
        jobs: githubWorkflowRunFilterValues(form, "jobs"),
        conclusions: githubWorkflowRunConclusions(form),
        branches: githubWorkflowRunFilterValues(form, "branches"),
        runnerLabels: githubWorkflowRunFilterValues(form, "runnerLabels"),
        runnerGroups: githubWorkflowRunFilterValues(form, "runnerGroups"),
      },
    };
  }
  if (eventType === "github-pull-request-review-submitted") {
    return {
      provider: "github",
      event: "pull_request_review_submitted",
      filters: {
        repositories: githubWorkflowRunFilterValues(form, "repositories"),
        reviewStates: checkedGithubValues(
          form,
          "reviewStates",
          GITHUB_REVIEW_STATE_OPTIONS,
        ),
        baseBranches: githubWorkflowRunFilterValues(form, "baseBranches"),
        headBranches: githubWorkflowRunFilterValues(form, "headBranches"),
        trustedAuthors: githubWorkflowRunFilterValues(form, "trustedAuthors"),
      },
    };
  }
  if (eventType === "github-deployment-status-created") {
    const productionEnvironment = form.get("productionEnvironment");
    return {
      provider: "github",
      event: "deployment_status_created",
      filters: {
        repositories: githubWorkflowRunFilterValues(form, "repositories"),
        environments: githubWorkflowRunFilterValues(form, "environments"),
        states: checkedGithubValues(
          form,
          "deploymentStates",
          GITHUB_DEPLOYMENT_STATE_OPTIONS,
        ),
        refs: githubWorkflowRunFilterValues(form, "refs"),
        productionEnvironment:
          productionEnvironment === "true"
            ? true
            : productionEnvironment === "false"
              ? false
              : undefined,
        creators: githubWorkflowRunFilterValues(form, "creators"),
        apps: githubWorkflowRunFilterValues(form, "apps"),
      },
    };
  }
  return {
    provider: "github",
    event: "issue_comment_created",
    filters: {
      repositories: githubWorkflowRunFilterValues(form, "repositories"),
      subject: githubSubjectFilterValue(form.get("subject"), "both"),
      trustedAuthors: githubWorkflowRunFilterValues(form, "trustedAuthors"),
      commentPrefixes: githubWorkflowRunFilterValues(form, "commentPrefixes"),
    },
  };
}

function workflowAutomationTitle(
  automation: WorkflowAutomationSummary,
): string {
  if (automation.kind === "event") {
    if (automation.eventType === "stripe-invoice-paid") {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.invoicePaidTitle;
      });
    }
    if (
      automation.eventType === "google-forms-response-submitted" ||
      automation.eventType === "webhook-received"
    ) {
      return i18n.t(($) => {
        return $.workflows.automations.webhook.createTitle;
      });
    }
  }
  return sharedAutomationTitle(automation);
}

function githubWorkflowRunAutomationSummary(
  config: GithubWorkflowRunCompletedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.repositoriesSummary;
          },
          { values: filters.repositories.join(", ") },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyRepository;
        }),
    filters.workflows
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.workflowsSummary;
          },
          { values: filters.workflows.join(", ") },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyWorkflow;
        }),
    filters.conclusions
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.conclusionsSummary;
          },
          {
            values: filters.conclusions
              .map(githubAutomationFilterValueLabel)
              .join(", "),
          },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyConclusion;
        }),
  ].join(" · ");
}

function githubWorkflowJobAutomationSummary(
  config: GithubWorkflowJobCompletedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories?.join(", ") ??
      i18n.t(($) => {
        return $.workflows.automations.github.anyRepository;
      }),
    filters.jobs
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.jobsSummary;
          },
          { values: filters.jobs.join(", ") },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyJob;
        }),
    filters.conclusions?.map(githubAutomationFilterValueLabel).join(", ") ??
      i18n.t(($) => {
        return $.workflows.automations.github.anyConclusion;
      }),
  ].join(" · ");
}

function githubReviewAutomationSummary(
  config: GithubPullRequestReviewSubmittedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories?.join(", ") ??
      i18n.t(($) => {
        return $.workflows.automations.github.anyRepository;
      }),
    filters.reviewStates?.map(githubAutomationFilterValueLabel).join(", ") ??
      i18n.t(($) => {
        return $.workflows.automations.github.anyReviewState;
      }),
    filters.trustedAuthors
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.authorsSummary;
          },
          { values: filters.trustedAuthors.join(", ") },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyAuthor;
        }),
  ].join(" · ");
}

function githubDeploymentAutomationSummary(
  config: GithubDeploymentStatusCreatedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories?.join(", ") ??
      i18n.t(($) => {
        return $.workflows.automations.github.anyRepository;
      }),
    filters.environments
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.environmentsSummary;
          },
          { values: filters.environments.join(", ") },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyEnvironment;
        }),
    filters.states
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.deploymentStatesSummary;
          },
          {
            values: filters.states
              .map(githubAutomationFilterValueLabel)
              .join(", "),
          },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyDeploymentState;
        }),
  ].join(" · ");
}

function githubCommentAutomationSummary(
  config: GithubIssueCommentCreatedEventConfig,
): string {
  const filters = config.filters;
  const subject =
    GITHUB_SUBJECT_OPTIONS.find((option) => {
      return option.value === filters.subject;
    })?.label ??
    i18n.t(($) => {
      return $.workflows.automations.github.issuesAndPullRequests;
    });
  return [
    filters.repositories?.join(", ") ??
      i18n.t(($) => {
        return $.workflows.automations.github.anyRepository;
      }),
    subject,
    filters.trustedAuthors
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.authorsSummary;
          },
          { values: filters.trustedAuthors.join(", ") },
        )
      : i18n.t(($) => {
          return $.workflows.automations.github.anyAuthor;
        }),
  ].join(" · ");
}

function githubWorkflowAutomationSummary(
  automation: Extract<WorkflowAutomationSummary, { readonly kind: "event" }>,
): string | null {
  switch (automation.eventType) {
    case "github-pull-request": {
      const config = automation.eventConfig;
      const action =
        GITHUB_PULL_REQUEST_ACTION_OPTIONS.find((option) => {
          return option.value === config.action;
        })?.label ?? config.action;
      return [
        config.repository,
        action,
        ...(config.merged === undefined
          ? []
          : [
              config.merged
                ? i18n.t(($) => {
                    return $.workflows.automations.github.pullRequestMergedOnly;
                  })
                : i18n.t(($) => {
                    return $.workflows.automations.github
                      .pullRequestClosedWithoutMergeOnly;
                  }),
            ]),
      ].join(" · ");
    }
    case "github-workflow-run-completed": {
      return githubWorkflowRunAutomationSummary(automation.eventConfig);
    }
    case "github-workflow-job-completed": {
      return githubWorkflowJobAutomationSummary(automation.eventConfig);
    }
    case "github-pull-request-review-submitted": {
      return githubReviewAutomationSummary(automation.eventConfig);
    }
    case "github-deployment-status-created": {
      return githubDeploymentAutomationSummary(automation.eventConfig);
    }
    case "github-issue-comment-created": {
      return githubCommentAutomationSummary(automation.eventConfig);
    }
    default: {
      return null;
    }
  }
}

function stripeBillingReasonLabel(reason: StripeInvoiceBillingReason): string {
  switch (reason) {
    case "automatic_pending_invoice_item_invoice": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason
          .automaticPendingInvoiceItemInvoice;
      });
    }
    case "manual": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.manual;
      });
    }
    case "quote_accept": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.quoteAccept;
      });
    }
    case "subscription": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.subscription;
      });
    }
    case "subscription_create": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.subscriptionCreate;
      });
    }
    case "subscription_cycle": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.subscriptionCycle;
      });
    }
    case "subscription_threshold": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason
          .subscriptionThreshold;
      });
    }
    case "subscription_update": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.subscriptionUpdate;
      });
    }
    case "upcoming": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.billingReason.upcoming;
      });
    }
  }
}

function stripeBillingReasonsSummary(
  reasons: readonly StripeInvoiceBillingReason[] | undefined,
): string {
  return reasons && reasons.length > 0
    ? reasons.map(stripeBillingReasonLabel).join(", ")
    : i18n.t(($) => {
        return $.workflows.automations.stripe.anyBillingReason;
      });
}

function workflowAutomationSummary(
  automation: WorkflowAutomationSummary,
): string | null {
  if (
    automation.kind !== "event" ||
    automation.eventType === "google-forms-response-submitted"
  ) {
    return null;
  }
  if (automation.eventType === "stripe-invoice-paid") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.stripe.bindingSummary;
      },
      {
        accountId: automation.eventConfig.stripeAccountId,
        billingReasons: stripeBillingReasonsSummary(
          automation.eventConfig.billingReasons,
        ),
      },
    );
  }
  return (
    githubWorkflowAutomationSummary(automation) ??
    sharedAutomationSummary(automation)
  );
}

type AutomationCreateDialogKind =
  | "chat-run-finished"
  | "interval"
  | "scheduled"
  | "once"
  | "gmail"
  | "gmail-label"
  | "github-pull-request"
  | "github-workflow-job"
  | "github-pull-request-review"
  | "github-deployment-status"
  | "github-issue-comment"
  | "github-workflow-run"
  | "google-calendar-created"
  | "google-calendar-updated"
  | "google-calendar-cancelled"
  | "google-forms"
  | "google-meet-transcript-generated"
  | "notion-child-page"
  | "notion-database-item"
  | "notion-page-content-updated"
  | "stripe-invoice-paid"
  | "webhook";

type AutomationCategoryKey =
  | "schedule"
  | "email"
  | "calendar"
  | "forms"
  | "notion"
  | "integrations";

type AutomationCreateOption = {
  readonly kind: AutomationCreateDialogKind;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof Clock;
  readonly badge?: string;
};

type AutomationCreateCategory = {
  readonly key: AutomationCategoryKey;
  readonly label: string;
  readonly icon: typeof Clock;
  readonly options: readonly AutomationCreateOption[];
};

function buildStripeInvoicePaidAutomationOptions(
  enabled: boolean,
): AutomationCreateOption[] {
  return enabled
    ? [
        {
          kind: "stripe-invoice-paid",
          title: i18n.t(($) => {
            return $.workflows.automations.stripe.invoicePaidTitle;
          }),
          description: i18n.t(($) => {
            return $.workflows.automations.stripe.invoicePaidDescription;
          }),
          icon: BrandStripe,
        },
      ]
    : [];
}

function buildIntegrationAutomationOptions({
  stripeInvoicePaidAutomationsEnabled,
  webhookTierEligible,
}: {
  readonly stripeInvoicePaidAutomationsEnabled: boolean;
  readonly webhookTierEligible: boolean;
}): AutomationCreateOption[] {
  return [
    {
      kind: "chat-run-finished",
      title: i18n.t(($) => {
        return $.workflows.automations.chat.runFinishedTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.chat.runFinishedDescription;
      }),
      icon: MessageCircle,
    },
    {
      kind: "github-workflow-run",
      title: i18n.t(($) => {
        return $.workflows.automations.github.workflowRunTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.github.workflowRunDescription;
      }),
      icon: BrandGithub,
    },
    {
      kind: "github-pull-request",
      title: i18n.t(($) => {
        return $.workflows.automations.github.pullRequestTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.github.pullRequestDescription;
      }),
      icon: BrandGithub,
    },
    {
      kind: "github-workflow-job",
      title: i18n.t(($) => {
        return $.workflows.automations.github.workflowJobTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.github.workflowJobDescription;
      }),
      icon: BrandGithub,
    },
    {
      kind: "github-pull-request-review",
      title: i18n.t(($) => {
        return $.workflows.automations.github.reviewTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.github.reviewDescription;
      }),
      icon: BrandGithub,
    },
    {
      kind: "github-deployment-status",
      title: i18n.t(($) => {
        return $.workflows.automations.github.deploymentStatusTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.github.deploymentStatusDescription;
      }),
      icon: BrandGithub,
    },
    {
      kind: "github-issue-comment",
      title: i18n.t(($) => {
        return $.workflows.automations.github.issueCommentTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.github.issueCommentDescription;
      }),
      icon: BrandGithub,
    },
    ...buildStripeInvoicePaidAutomationOptions(
      stripeInvoicePaidAutomationsEnabled,
    ),
    {
      kind: "webhook",
      title: i18n.t(($) => {
        return $.workflows.automations.webhook.createTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.webhook.createDescription;
      }),
      icon: LinkIcon,
      ...(webhookTierEligible
        ? {}
        : {
            badge: i18n.t(($) => {
              return $.workflows.automations.webhook.paidBadge;
            }),
          }),
    },
  ];
}

function buildNotionAutomationOptions(): AutomationCreateOption[] {
  return [
    {
      kind: "notion-child-page",
      title: i18n.t(($) => {
        return $.workflows.automations.notion.childPageTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.notion.childPageDescription;
      }),
      icon: FilePlus,
    },
    {
      kind: "notion-database-item",
      title: i18n.t(($) => {
        return $.workflows.automations.notion.databaseItemTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.notion.databaseItemDescription;
      }),
      icon: DatabasePlus,
    },
    {
      kind: "notion-page-content-updated",
      title: i18n.t(($) => {
        return $.workflows.automations.notion.contentUpdatedTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.notion.contentUpdatedDescription;
      }),
      icon: FilePen,
    },
  ];
}

function buildGoogleFormsAutomationOptions(): AutomationCreateOption[] {
  return [
    {
      kind: "google-forms",
      title: i18n.t(($) => {
        return $.workflows.automations.forms.responseSubmittedTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.forms.responseSubmittedDescription;
      }),
      icon: FileText,
    },
  ];
}

// Each category owns a single hue that colours only the card icon chip on the
// right; the category rail stays neutral and mirrors the app sidebar.
const AUTOMATION_CATEGORY_CHIP: Readonly<
  Record<AutomationCategoryKey, string>
> = Object.freeze({
  schedule: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  email: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  calendar: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  forms: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  notion: "bg-gray-500/10 text-gray-700 dark:text-gray-300",
  integrations: "bg-amber-500/10 text-amber-600 dark:text-amber-500",
});

function buildCalendarAutomationOptions(): AutomationCreateOption[] {
  return [
    {
      kind: "google-calendar-created",
      title: i18n.t(($) => {
        return $.workflows.automations.calendar.createdTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.calendar.createdDescription;
      }),
      icon: CalendarClock,
    },
    {
      kind: "google-calendar-updated",
      title: i18n.t(($) => {
        return $.workflows.automations.calendar.updatedTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.calendar.updatedDescription;
      }),
      icon: CalendarClock,
    },
    {
      kind: "google-calendar-cancelled",
      title: i18n.t(($) => {
        return $.workflows.automations.calendar.cancelledTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.calendar.cancelledDescription;
      }),
      icon: CalendarClock,
    },
    {
      kind: "google-meet-transcript-generated",
      title: i18n.t(($) => {
        return $.workflows.automations.meet.transcriptReadyTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.meet.transcriptReadyDescription;
      }),
      icon: Video,
    },
  ];
}

function buildScheduleAutomationOptions(): AutomationCreateOption[] {
  return [
    {
      kind: "interval",
      title: i18n.t(($) => {
        return $.workflows.automations.schedule.frequencyIntervalTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.schedule.frequencyIntervalDescription;
      }),
      icon: Repeat,
    },
    {
      kind: "scheduled",
      title: i18n.t(($) => {
        return $.workflows.automations.schedule.frequencyScheduleTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.schedule.frequencyScheduleDescription;
      }),
      icon: Clock,
    },
    {
      kind: "once",
      title: i18n.t(($) => {
        return $.workflows.automations.schedule.frequencyOnceTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.schedule.frequencyOnceDescription;
      }),
      icon: Clock,
    },
  ];
}

function buildEmailAutomationOptions(): AutomationCreateOption[] {
  return [
    {
      kind: "gmail",
      title: i18n.t(($) => {
        return $.workflows.automations.gmail.newMessageTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.gmail.newMessageDescription;
      }),
      icon: Mail,
    },
    {
      kind: "gmail-label",
      title: i18n.t(($) => {
        return $.workflows.automations.gmail.labelAppliedTitle;
      }),
      description: i18n.t(($) => {
        return $.workflows.automations.gmail.addLabelDescription;
      }),
      icon: Mail,
    },
  ];
}

function buildAutomationCreateCategories({
  stripeInvoicePaidAutomationsEnabled,
  webhookTierEligible,
}: {
  readonly stripeInvoicePaidAutomationsEnabled: boolean;
  readonly webhookTierEligible: boolean;
}): readonly AutomationCreateCategory[] {
  const googleFormsOptions = buildGoogleFormsAutomationOptions();
  const integrationOptions = buildIntegrationAutomationOptions({
    stripeInvoicePaidAutomationsEnabled,
    webhookTierEligible,
  });
  const notionOptions = buildNotionAutomationOptions();

  const categories: readonly AutomationCreateCategory[] = [
    {
      key: "schedule",
      label: i18n.t(($) => {
        return $.workflows.automations.picker.schedule;
      }),
      icon: Clock,
      options: buildScheduleAutomationOptions(),
    },
    {
      key: "email",
      label: i18n.t(($) => {
        return $.workflows.automations.picker.email;
      }),
      icon: Mail,
      options: buildEmailAutomationOptions(),
    },
    {
      key: "calendar",
      label: i18n.t(($) => {
        return $.workflows.automations.picker.calendar;
      }),
      icon: CalendarClock,
      options: buildCalendarAutomationOptions(),
    },
    {
      key: "forms",
      label: i18n.t(($) => {
        return $.workflows.automations.picker.forms;
      }),
      icon: FileText,
      options: googleFormsOptions,
    },
    {
      key: "notion",
      label: i18n.t(($) => {
        return $.workflows.automations.picker.notion;
      }),
      icon: BrandNotion,
      options: notionOptions,
    },
    {
      key: "integrations",
      label: i18n.t(($) => {
        return $.workflows.automations.picker.integrations;
      }),
      icon: LinkIcon,
      options: integrationOptions,
    },
  ];

  return categories.filter((category) => {
    return category.options.length > 0;
  });
}

function AutomationCreateCategoryButton({
  category,
  active,
  onSelect,
}: {
  readonly category: AutomationCreateCategory;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = category.icon;
  // Mirror the app sidebar nav row: neutral gray active state, plain icon,
  // h-8 rounded-lg row — no category colour on the rail.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 transition-colors duration-200",
        active
          ? "bg-state-selected font-medium text-foreground"
          : "text-sidebar-foreground hover:bg-state-hover",
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="truncate">{category.label}</span>
    </button>
  );
}

function AutomationCreateOptionCard({
  option,
  accentChip,
  onSelect,
}: {
  readonly option: AutomationCreateOption;
  readonly accentChip: string;
  readonly onSelect: () => void;
}) {
  const Icon = option.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-h-[8rem] flex-col items-start gap-3.5 rounded-2xl border border-[hsl(var(--gray-400))] bg-card p-5 text-left transition-colors hover:border-[hsl(var(--gray-500))] hover:bg-card-hover"
    >
      <span
        className={cn(
          "flex size-11 items-center justify-center rounded-xl",
          accentChip,
        )}
      >
        <Icon size={20} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-semibold">{option.title}</span>
        {option.badge ? (
          <span className="mt-0.5 w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            {option.badge}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {option.description}
        </span>
      </span>
    </button>
  );
}

function AutomationCreateMenu({
  onSelect,
  stripeInvoicePaidAutomationsEnabled,
  webhookTierEligible,
}: {
  readonly onSelect: (kind: AutomationCreateDialogKind) => void;
  readonly stripeInvoicePaidAutomationsEnabled: boolean;
  readonly webhookTierEligible: boolean;
}) {
  const open = useGet(workflowAutomationPickerOpen$);
  const setOpen = useSet(setWorkflowAutomationPickerOpen$);
  const activeKey = useGet(workflowAutomationPickerCategory$);
  const setActiveKey = useSet(setWorkflowAutomationPickerCategory$);
  const categories = buildAutomationCreateCategories({
    stripeInvoicePaidAutomationsEnabled,
    webhookTierEligible,
  });
  const activeCategory =
    categories.find((category) => {
      return category.key === activeKey;
    }) ?? categories[0];
  const activeChip = activeCategory
    ? AUTOMATION_CATEGORY_CHIP[activeCategory.key]
    : "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="neutral"
          className="shrink-0 gap-1.5 px-3 hover:bg-control-surface active:bg-control-surface [&_svg]:size-3.5"
        >
          <Plus size={14} />
          <span>
            {i18n.t(($) => {
              return $.workflows.automations.common.addAutomation;
            })}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent smMaxWidth={880}>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.common.addAutomation;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.common.chooseAutomation;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5 sm:min-h-[20rem] sm:flex-row sm:gap-7">
          <nav className="-ml-2 flex gap-1 overflow-x-auto pb-1 sm:w-44 sm:shrink-0 sm:flex-col sm:gap-1 sm:overflow-visible sm:border-r sm:border-border/60 sm:pb-0 sm:pr-4">
            {categories.map((category) => {
              return (
                <AutomationCreateCategoryButton
                  key={category.key}
                  category={category}
                  active={category.key === activeCategory?.key}
                  onSelect={() => {
                    setActiveKey(category.key);
                  }}
                />
              );
            })}
          </nav>
          <div className="grid min-w-0 flex-1 auto-rows-min grid-cols-1 content-start gap-4 sm:grid-cols-2">
            {activeCategory?.options.map((option) => {
              return (
                <AutomationCreateOptionCard
                  key={option.kind}
                  option={option}
                  accentChip={activeChip}
                  onSelect={() => {
                    onSelect(option.kind);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AutomationFormActions({
  pending,
  onCancel,
  submitDisabled = pending,
  children,
}: {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly submitDisabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={onCancel}
      >
        {i18n.t(($) => {
          return $.workflows.automations.common.cancel;
        })}
      </Button>
      <Button type="submit" disabled={submitDisabled}>
        {children}
      </Button>
    </DialogFooter>
  );
}

function CreateGoogleFormsResponseSubmittedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createAutomation] = useLoadableSet(
    createWorkflowGoogleFormsResponseSubmittedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.forms.addTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.forms.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.forms.addAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const formUrl = formTextValue(
              new FormData(event.currentTarget),
              "formUrl",
            );
            if (!formUrl) {
              return;
            }
            detach(
              (async () => {
                const warning = await createAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "google-forms",
                      event: "response_submitted",
                      formUrl,
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
                if (warning) {
                  toast.warning(warning);
                }
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.forms.formUrl;
            })}
            <Input
              name="formUrl"
              aria-label={i18n.t(($) => {
                return $.workflows.automations.forms.formUrl;
              })}
              required
              disabled={creating}
              placeholder={i18n.t(($) => {
                return $.workflows.automations.forms.formUrlPlaceholder;
              })}
            />
          </label>
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FileText size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.forms.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateGoogleMeetTranscriptGeneratedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGoogleMeetAutomation] = useLoadableSet(
    createWorkflowGoogleMeetTranscriptGeneratedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.meet.addTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.meet.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.meet.addAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            detach(
              (async () => {
                await createGoogleMeetAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "google-meet",
                      event: "transcript_generated",
                      scope: { type: "organizer_user" },
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.meet.transcriptHint;
            })}
          </div>
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Video size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.meet.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CHAT_RUN_FINISHED_STATUSES: readonly ChatRunFinishedRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

function ChatRunFinishedAutomationFields({
  creating,
}: {
  readonly creating: boolean;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.threadIdLabel;
        })}
        <Input
          name="chatThreadId"
          required
          disabled={creating}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.threadIdHint;
        })}
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.workflows.automations.chat.statusesLabel;
          })}
        </legend>
        <div className="flex flex-wrap gap-4">
          {CHAT_RUN_FINISHED_STATUSES.map((status) => {
            return (
              <label key={status} className="flex items-center gap-2">
                <Checkbox name={`status-${status}`} defaultChecked />
                <span className="text-sm text-foreground">
                  {chatRunFinishedStatusLabel(status)}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.patternLabel;
        })}
        <Input
          name="outputPattern"
          disabled={creating}
          placeholder={i18n.t(($) => {
            return $.workflows.automations.chat.patternPlaceholder;
          })}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.patternHint;
        })}
      </p>
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.statusesHint;
        })}
      </div>
    </>
  );
}

function buildChatRunFinishedEventConfig(
  form: FormData,
): ChatRunFinishedEventConfig | null {
  const chatThreadId = String(form.get("chatThreadId") ?? "").trim();
  if (!chatThreadId) {
    return null;
  }
  const statuses = CHAT_RUN_FINISHED_STATUSES.filter((status) => {
    return form.get(`status-${status}`) === "on";
  });
  if (statuses.length === 0) {
    return null;
  }
  const outputPattern = String(form.get("outputPattern") ?? "").trim();
  return {
    provider: "chat",
    event: "run_finished",
    chatThreadId,
    ...(statuses.length === CHAT_RUN_FINISHED_STATUSES.length
      ? {}
      : { runStatuses: [...statuses] }),
    ...(outputPattern ? { outputPattern } : {}),
  };
}

function CreateChatRunFinishedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createAutomation] = useLoadableSet(
    createWorkflowChatRunFinishedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.chat.addTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.chat.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.chat.addAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const eventConfig = buildChatRunFinishedEventConfig(
              new FormData(event.currentTarget),
            );
            if (!eventConfig) {
              return;
            }
            detach(
              (async () => {
                await createAutomation({ workflowId, eventConfig }, pageSignal);
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <ChatRunFinishedAutomationFields creating={creating} />
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {i18n.t(($) => {
              return $.workflows.automations.chat.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AutomationsSection({
  detail,
}: {
  readonly detail: WorkflowDetailResponse;
}) {
  const createDialog = useGet(workflowAutomationCreateDialog$);
  const setCreateDialog = useSet(setWorkflowAutomationCreateDialog$);
  const userLoadable = useLoadable(user$);
  const preferences = useLastResolved(userPreferences$);
  const currentUserId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? "") : "";
  const displayTimezone = preferences?.timezone ?? browserTimezone();
  const automations = detail.automations;

  return (
    <section className="mx-auto flex max-w-[900px] flex-col gap-3">
      <div className="flex flex-col gap-2">
        {automations.length > 0 ? (
          <div className={surfaceVariants({ className: "overflow-visible" })}>
            {automations.map((automation, index) => {
              return (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  canOperate={automation.ownerUserId === currentUserId}
                  canEditStructure={
                    automation.ownerUserId === currentUserId && !detail.official
                  }
                  displayTimezone={displayTimezone}
                  showDivider={index < automations.length - 1}
                />
              );
            })}
          </div>
        ) : (
          <div
            className={surfaceVariants({
              className:
                "flex min-h-[20rem] flex-col items-center justify-center px-6 text-center",
            })}
          >
            <img
              src={emptyAutomationsImg}
              alt={i18n.t(($) => {
                return $.workflows.automations.common.noAutomations;
              })}
              className="h-24 w-24 object-contain opacity-80"
            />
            <p className="mt-3 text-sm font-medium text-foreground">
              {i18n.t(($) => {
                return $.workflows.automations.common.noAutomations;
              })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {i18n.t(($) => {
                return $.workflows.automations.common.noAutomationsDescription;
              })}
            </p>
          </div>
        )}
      </div>
      <WorkflowAutomationCreateDialogs
        workflowId={detail.id}
        displayTimezone={displayTimezone}
        createDialog={createDialog}
        setCreateDialog={setCreateDialog}
      />
    </section>
  );
}

function selectedStripeBillingReasons(
  form: FormData,
): StripeInvoiceBillingReason[] {
  return STRIPE_INVOICE_BILLING_REASONS.filter((reason) => {
    return form.has(reason);
  });
}

function StripeBillingReasonFields({
  creating,
}: {
  readonly creating: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.stripe.billingReasons;
        })}
      </legend>
      <p className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.stripe.billingReasonsHint;
        })}
      </p>
      <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-2">
        {STRIPE_INVOICE_BILLING_REASONS.map((reason) => {
          return (
            <label
              key={reason}
              className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-background"
            >
              <Checkbox
                name={reason}
                disabled={creating}
                className="mt-0.5 shrink-0"
              />
              <span className="text-sm text-foreground">
                {stripeBillingReasonLabel(reason)}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function StripeAutomationCreateError({
  message,
}: {
  readonly message: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <p>{message}</p>
      </div>
      <Link
        pathname={ROUTES.connectors}
        className="w-fit font-medium underline underline-offset-2"
      >
        {i18n.t(($) => {
          return $.workflows.automations.stripe.manageConnection;
        })}
      </Link>
    </div>
  );
}

function CreateStripeInvoicePaidAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createAutomation] = useLoadableSet(
    createWorkflowStripeInvoicePaidAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const createError =
    createLoadable.state === "hasError"
      ? createLoadable.error instanceof Error
        ? createLoadable.error.message
        : i18n.t(($) => {
            return $.global.errors.requestFailed;
          })
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.stripe.addTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.stripe.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.stripe.addAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const billingReasons = selectedStripeBillingReasons(
              new FormData(event.currentTarget),
            );
            detach(
              (async () => {
                await createAutomation(
                  { workflowId, billingReasons },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
              "create Stripe invoice-paid automation",
            );
          }}
        >
          <StripeBillingReasonFields creating={creating} />
          {createError ? (
            <StripeAutomationCreateError message={createError} />
          ) : null}
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <BrandStripe size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.stripe.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationAutomationCreateDialogs({
  workflowId,
  createDialog,
  setCreateDialog,
}: {
  readonly workflowId: string;
  readonly createDialog: WorkflowAutomationCreateDialog;
  readonly setCreateDialog: (dialog: WorkflowAutomationCreateDialog) => void;
}) {
  return (
    <>
      {createDialog === "stripe-invoice-paid" ? (
        <CreateStripeInvoicePaidAutomationDialog
          workflowId={workflowId}
          open
          onOpenChange={(open) => {
            setCreateDialog(open ? "stripe-invoice-paid" : null);
          }}
        />
      ) : null}
      <CreateWebhookAutomationDialog
        workflowId={workflowId}
        open={createDialog === "webhook"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "webhook" : null);
        }}
      />
      <WorkflowWebhookUpgradeDialog />
    </>
  );
}

function WorkflowAutomationCreateDialogs({
  workflowId,
  displayTimezone,
  createDialog,
  setCreateDialog,
}: {
  readonly workflowId: string;
  readonly displayTimezone: string;
  readonly createDialog: WorkflowAutomationCreateDialog;
  readonly setCreateDialog: (dialog: WorkflowAutomationCreateDialog) => void;
}) {
  const dialogProps = (kind: AutomationCreateDialogKind) => {
    return {
      workflowId,
      open: createDialog === kind,
      onOpenChange: (open: boolean) => {
        setCreateDialog(open ? kind : null);
      },
    };
  };
  return (
    <>
      <CreateIntervalAutomationDialog {...dialogProps("interval")} />
      <CreateScheduledAutomationDialog
        displayTimezone={displayTimezone}
        {...dialogProps("scheduled")}
      />
      <CreateOnceAutomationDialog
        displayTimezone={displayTimezone}
        {...dialogProps("once")}
      />
      <CreateGmailNewMessageAutomationDialog {...dialogProps("gmail")} />
      <CreateGmailLabelAppliedAutomationDialog
        {...dialogProps("gmail-label")}
      />
      <CreateGoogleFormsResponseSubmittedAutomationDialog
        {...dialogProps("google-forms")}
      />
      <CreateGithubWorkflowRunCompletedAutomationDialog
        {...dialogProps("github-workflow-run")}
      />
      <CreateGithubWebhookAutomationDialog
        eventType="github-pull-request"
        {...dialogProps("github-pull-request")}
      />
      <CreateGithubWebhookAutomationDialog
        eventType="github-workflow-job-completed"
        {...dialogProps("github-workflow-job")}
      />
      <CreateGithubWebhookAutomationDialog
        eventType="github-pull-request-review-submitted"
        {...dialogProps("github-pull-request-review")}
      />
      <CreateGithubWebhookAutomationDialog
        eventType="github-deployment-status-created"
        {...dialogProps("github-deployment-status")}
      />
      <CreateGithubWebhookAutomationDialog
        eventType="github-issue-comment-created"
        {...dialogProps("github-issue-comment")}
      />
      <CreateGoogleCalendarEventAutomationDialog
        eventType="google-calendar-event-created"
        {...dialogProps("google-calendar-created")}
      />
      <CreateGoogleCalendarEventAutomationDialog
        eventType="google-calendar-event-updated"
        {...dialogProps("google-calendar-updated")}
      />
      <CreateGoogleCalendarEventAutomationDialog
        eventType="google-calendar-event-cancelled"
        {...dialogProps("google-calendar-cancelled")}
      />
      <CreateGoogleMeetTranscriptGeneratedAutomationDialog
        {...dialogProps("google-meet-transcript-generated")}
      />
      <CreateChatRunFinishedAutomationDialog
        {...dialogProps("chat-run-finished")}
      />
      <CreateNotionChildPageAutomationDialog
        {...dialogProps("notion-child-page")}
      />
      <CreateNotionDatabaseItemAutomationDialog
        {...dialogProps("notion-database-item")}
      />
      <CreateNotionPageContentUpdatedAutomationDialog
        {...dialogProps("notion-page-content-updated")}
      />
      <IntegrationAutomationCreateDialogs
        workflowId={workflowId}
        createDialog={createDialog}
        setCreateDialog={setCreateDialog}
      />
    </>
  );
}

function CreateNotionDatabaseItemAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createNotionAutomation] = useLoadableSet(
    createWorkflowNotionDatabaseItemAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.notion.addAction;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.notion
                .databaseItemDialogDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.notion.databaseItemAddAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const databaseUrl = formTextValue(form, "databaseUrl");
            if (!databaseUrl) {
              return;
            }
            detach(
              (async () => {
                await createNotionAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "notion",
                      event: "database_item_created",
                      databaseUrl,
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.notion.databaseUrl;
            })}
            <Input
              name="databaseUrl"
              aria-label={i18n.t(($) => {
                return $.workflows.automations.notion.databaseUrl;
              })}
              required
              disabled={creating}
              placeholder={i18n.t(($) => {
                return $.workflows.automations.notion.databaseUrlPlaceholder;
              })}
            />
          </label>
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <BrandNotion size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.notion.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function notionPageContentUpdatedEventConfigFromForm(
  form: FormData,
  scope: NotionPageContentUpdatedScopeMode,
): NotionPageContentUpdatedEventCreateConfig | null {
  const pageUrl = formTextValue(form, "pageUrl");
  const databaseUrl = formTextValue(form, "databaseUrl");
  if (scope === "page") {
    return pageUrl
      ? {
          provider: "notion",
          event: "page_content_updated",
          pageUrl,
        }
      : null;
  }
  return databaseUrl
    ? {
        provider: "notion",
        event: "page_content_updated",
        databaseUrl,
      }
    : null;
}

function NotionPageContentUpdatedScopeFields({
  scope,
  creating,
  setScope,
}: {
  readonly scope: NotionPageContentUpdatedScopeMode;
  readonly creating: boolean;
  readonly setScope: (scope: NotionPageContentUpdatedScopeMode) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.notion.scope;
        })}
        <Select
          value={scope}
          disabled={creating}
          onValueChange={(value) => {
            setScope(value === "database" ? "database" : "page");
          }}
        >
          <SelectTrigger
            aria-label={i18n.t(($) => {
              return $.workflows.automations.notion.scope;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="page">
              {i18n.t(($) => {
                return $.workflows.automations.notion.page;
              })}
            </SelectItem>
            <SelectItem value="database">
              {i18n.t(($) => {
                return $.workflows.automations.notion.database;
              })}
            </SelectItem>
          </SelectContent>
        </Select>
      </label>
      {scope === "page" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.workflows.automations.notion.pageUrl;
          })}
          <Input
            name="pageUrl"
            aria-label={i18n.t(($) => {
              return $.workflows.automations.notion.pageUrl;
            })}
            required
            disabled={creating}
            placeholder={i18n.t(($) => {
              return $.workflows.automations.notion.pageUrlPlaceholder;
            })}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.workflows.automations.notion.databaseUrl;
          })}
          <Input
            name="databaseUrl"
            aria-label={i18n.t(($) => {
              return $.workflows.automations.notion.databaseUrl;
            })}
            required
            disabled={creating}
            placeholder={i18n.t(($) => {
              return $.workflows.automations.notion.databaseUrlPlaceholder;
            })}
          />
        </label>
      )}
    </>
  );
}

function CreateNotionPageContentUpdatedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const scope = useGet(createNotionPageContentUpdatedScope$);
  const setScope = useSet(setCreateNotionPageContentUpdatedScope$);
  const [createLoadable, createNotionAutomation] = useLoadableSet(
    createWorkflowNotionPageContentUpdatedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.notion.addAction;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.notion
                .contentUpdatedDialogDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.notion.contentUpdatedAddAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const eventConfig = notionPageContentUpdatedEventConfigFromForm(
              form,
              scope,
            );
            if (!eventConfig) {
              return;
            }
            detach(
              (async () => {
                await createNotionAutomation(
                  {
                    workflowId,
                    eventConfig,
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <NotionPageContentUpdatedScopeFields
            scope={scope}
            creating={creating}
            setScope={setScope}
          />
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <BrandNotion size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.notion.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateNotionChildPageAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createNotionAutomation] = useLoadableSet(
    createWorkflowNotionChildPageAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.notion.addAction;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.notion.childPageDialogDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.notion.childPageAddAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const parentPageUrl = formTextValue(form, "parentPageUrl");
            if (!parentPageUrl) {
              return;
            }
            detach(
              (async () => {
                await createNotionAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "notion",
                      event: "child_page_created",
                      parentPageUrl,
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.notion.parentPageUrl;
            })}
            <Input
              name="parentPageUrl"
              aria-label={i18n.t(($) => {
                return $.workflows.automations.notion.parentPageUrl;
              })}
              required
              disabled={creating}
              placeholder={i18n.t(($) => {
                return $.workflows.automations.notion.pageUrlPlaceholder;
              })}
            />
          </label>
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <BrandNotion size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.notion.addAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateIntervalAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createScheduleAutomation] = useLoadableSet(
    createWorkflowScheduleAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addIntervalTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addIntervalDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.schedule.addIntervalAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildAutomationSchedule(
              "loop",
              {
                cronFields: defaultWorkflowCronFields(),
                intervalSeconds: String(form.get("intervalSeconds") ?? ""),
                atTime: "",
              },
              AUTOMATION_TIMEZONE,
            );
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleAutomation(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <WorkflowIntervalField disabled={creating} />

          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addIntervalAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateScheduledAutomationDialog({
  workflowId,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const cronFields = useGet(createScheduleCronFields$);
  const setCronFields = useSet(setCreateScheduleCronFields$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createScheduleAutomation] = useLoadableSet(
    createWorkflowScheduleAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addScheduleTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addScheduleDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.schedule.addScheduleAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildAutomationSchedule(
              "cron",
              {
                cronFields,
                intervalSeconds: "",
                atTime: String(form.get("atTime") ?? ""),
              },
              displayTimezone,
            );
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleAutomation(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <ScheduleAutomationFields
            scheduleType="cron"
            cronFields={cronFields}
            setCronFields={setCronFields}
            displayTimezone={displayTimezone}
            disabled={creating}
          />

          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addScheduleAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateOnceAutomationDialog({
  workflowId,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const setCronFields = useSet(setCreateScheduleCronFields$);
  const [createLoadable, createScheduleAutomation] = useLoadableSet(
    createWorkflowScheduleAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addOnceTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addOnceDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.schedule.addOnceAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildAutomationSchedule(
              "once",
              {
                cronFields: defaultWorkflowCronFields(),
                intervalSeconds: "",
                atTime: String(form.get("atTime") ?? ""),
              },
              displayTimezone,
            );
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleAutomation(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <ScheduleAutomationFields
            scheduleType="once"
            cronFields={defaultWorkflowCronFields()}
            setCronFields={setCronFields}
            displayTimezone={displayTimezone}
            disabled={creating}
          />

          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.automations.schedule.addOnceAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleAutomationFields({
  scheduleType,
  cronFields,
  setCronFields,
  displayTimezone,
  disabled,
  defaultIntervalSeconds,
  defaultAtTime,
}: {
  readonly scheduleType: WorkflowScheduleType;
  readonly cronFields: WorkflowCronFields;
  readonly setCronFields: (fields: WorkflowCronFields) => void;
  readonly displayTimezone: string;
  readonly disabled: boolean;
  readonly defaultIntervalSeconds?: number;
  readonly defaultAtTime?: string;
}) {
  if (scheduleType === "loop") {
    return (
      <WorkflowIntervalField
        disabled={disabled}
        defaultIntervalSeconds={defaultIntervalSeconds}
      />
    );
  }

  if (scheduleType === "once") {
    return (
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.schedule.runAt;
        })}
        <Input
          name="atTime"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.schedule.runAt;
          })}
          type="datetime-local"
          defaultValue={defaultAtTime}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.workflows.automations.schedule.displaysIn;
            },
            { timezone: timezoneDisplayName(displayTimezone) },
          )}
        </span>
      </label>
    );
  }

  return (
    <WorkflowCronFieldsForm
      fields={cronFields}
      onChange={setCronFields}
      displayTimezone={displayTimezone}
      disabled={disabled}
    />
  );
}

function WorkflowIntervalField({
  disabled,
  defaultIntervalSeconds = 15 * 60,
}: {
  readonly disabled: boolean;
  readonly defaultIntervalSeconds?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.schedule.every;
      })}
      <Select
        name="intervalSeconds"
        defaultValue={String(defaultIntervalSeconds)}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-9 w-full"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.schedule.every;
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {getWorkflowIntervalSecondOptions(defaultIntervalSeconds).map(
            (seconds) => {
              return (
                <SelectItem key={seconds} value={String(seconds)}>
                  {formatWorkflowIntervalSeconds(seconds)}
                </SelectItem>
              );
            },
          )}
        </SelectContent>
      </Select>
    </label>
  );
}

function WorkflowCronFieldsForm({
  fields,
  onChange,
  displayTimezone,
  disabled,
}: {
  readonly fields: WorkflowCronFields;
  readonly onChange: (fields: WorkflowCronFields) => void;
  readonly displayTimezone: string;
  readonly disabled: boolean;
}) {
  const updateFields = (patch: Partial<WorkflowCronFields>) => {
    onChange({ ...fields, ...patch });
  };
  return (
    <div className="flex flex-col gap-3">
      <WorkflowCronFrequencyField
        frequency={fields.frequency}
        disabled={disabled}
        onChange={(frequency) => {
          updateFields({ frequency });
        }}
      />

      {fields.frequency === "custom" ? (
        <WorkflowCustomCronField
          value={fields.customCronExpression}
          disabled={disabled}
          onChange={(customCronExpression) => {
            updateFields({ customCronExpression });
          }}
        />
      ) : (
        <>
          {fields.frequency === "every_week" ? (
            <WorkflowDayOfWeekPicker
              dayOfWeek={fields.dayOfWeek}
              disabled={disabled}
              onChange={(dayOfWeek) => {
                updateFields({ dayOfWeek });
              }}
            />
          ) : null}

          {fields.frequency === "every_month" ? (
            <WorkflowDayOfMonthField
              dayOfMonth={fields.dayOfMonth}
              disabled={disabled}
              onChange={(dayOfMonth) => {
                updateFields({ dayOfMonth });
              }}
            />
          ) : null}

          <WorkflowCronTimeField
            hour={fields.hour}
            minute={fields.minute}
            displayTimezone={displayTimezone}
            disabled={disabled}
            onHourChange={(hour) => {
              updateFields({ hour });
            }}
            onMinuteChange={(minute) => {
              updateFields({ minute });
            }}
          />
        </>
      )}
    </div>
  );
}

function WorkflowCronFrequencyField({
  frequency,
  disabled,
  onChange,
}: {
  readonly frequency: WorkflowCronFrequency;
  readonly disabled: boolean;
  readonly onChange: (frequency: WorkflowCronFrequency) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.schedule.repeats;
      })}
      <Select
        value={frequency}
        disabled={disabled}
        onValueChange={(value) => {
          onChange(value as WorkflowCronFrequency);
        }}
      >
        <SelectTrigger className="h-9 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORKFLOW_CRON_FREQUENCY_OPTIONS.map((option) => {
            return (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function WorkflowCustomCronField({
  value,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.schedule.cronExpression;
      })}
      <Input
        aria-label={i18n.t(($) => {
          return $.workflows.automations.schedule.cronExpression;
        })}
        value={value}
        disabled={disabled}
        placeholder="0 9 * * *"
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </label>
  );
}

function WorkflowDayOfMonthField({
  dayOfMonth,
  disabled,
  onChange,
}: {
  readonly dayOfMonth: string;
  readonly disabled: boolean;
  readonly onChange: (dayOfMonth: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.schedule.dayOfMonth;
      })}
      <Select value={dayOfMonth} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
          className="h-9 w-full"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.schedule.dayOfMonth;
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: 31 }, (_, index) => {
            const day = String(index + 1);
            return (
              <SelectItem key={day} value={day}>
                {day}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function WorkflowCronTimeField({
  hour,
  minute,
  displayTimezone,
  disabled,
  onHourChange,
  onMinuteChange,
}: {
  readonly hour: number;
  readonly minute: number;
  readonly displayTimezone: string;
  readonly disabled: boolean;
  readonly onHourChange: (hour: number) => void;
  readonly onMinuteChange: (minute: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {i18n.t(
          ($) => {
            return $.workflows.automations.schedule.time;
          },
          { timezone: timezoneDisplayName(displayTimezone) },
        )}
      </span>
      <div className="flex items-center gap-2">
        <WorkflowNumberSelect
          value={hour}
          options={WORKFLOW_CRON_HOUR_OPTIONS}
          disabled={disabled}
          ariaLabel={i18n.t(($) => {
            return $.workflows.automations.schedule.hour;
          })}
          onChange={onHourChange}
        />
        <span className="text-muted-foreground">:</span>
        <WorkflowNumberSelect
          value={minute}
          options={getWorkflowMinuteOptions(minute)}
          disabled={disabled}
          ariaLabel={i18n.t(($) => {
            return $.workflows.automations.schedule.minute;
          })}
          onChange={onMinuteChange}
        />
      </div>
    </div>
  );
}

function WorkflowNumberSelect({
  value,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  readonly value: number;
  readonly options: readonly number[];
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <Select
      value={String(value)}
      disabled={disabled}
      onValueChange={(nextValue) => {
        onChange(Number(nextValue));
      }}
    >
      <SelectTrigger className="h-9 w-20" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => {
          return (
            <SelectItem key={option} value={String(option)}>
              {String(option).padStart(2, "0")}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function WorkflowDayOfWeekPicker({
  dayOfWeek,
  disabled,
  onChange,
}: {
  readonly dayOfWeek: string;
  readonly disabled: boolean;
  readonly onChange: (dayOfWeek: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.schedule.dayOfWeek;
        })}
      </span>
      <div className="flex flex-wrap gap-1">
        {workflowDayOfWeekOptions().map(([value, label]) => {
          const selected = dayOfWeek.split(",").includes(value);
          return (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              disabled={disabled}
              aria-pressed={selected}
              className={cn(
                "min-w-10 px-2 text-xs disabled:opacity-60",
                selected
                  ? "border border-primary"
                  : "border-border/60 text-muted-foreground",
              )}
              onClick={() => {
                const current = dayOfWeek.split(",").filter(Boolean);
                if (selected) {
                  if (current.length <= 1) {
                    return;
                  }
                  onChange(
                    current
                      .filter((day) => {
                        return day !== value;
                      })
                      .join(","),
                  );
                  return;
                }
                onChange([...current, value].join(","));
              }}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function updateGmailMatchCondition(
  conditions: readonly GmailMatchCondition[],
  index: number,
  update: Partial<GmailMatchCondition>,
): readonly GmailMatchCondition[] {
  return conditions.map((condition, conditionIndex) => {
    return conditionIndex === index ? { ...condition, ...update } : condition;
  });
}

function gmailMatchConditionUsed(
  conditions: readonly GmailMatchCondition[],
  index: number,
  field: GmailMatchField,
  operator: GmailMatchOperator,
): boolean {
  return conditions.some((condition, conditionIndex) => {
    return (
      conditionIndex !== index &&
      condition.field === field &&
      condition.operator === operator
    );
  });
}

function gmailMatchConditionCopy(index: number) {
  const number = index + 1;
  return {
    fieldAria: i18n.t(
      ($) => {
        return $.workflows.automations.gmail.conditionField;
      },
      { number },
    ),
    operatorAria: i18n.t(
      ($) => {
        return $.workflows.automations.gmail.conditionOperator;
      },
      { number },
    ),
    placeholder: i18n.t(($) => {
      return $.workflows.automations.gmail.enterValue;
    }),
    removeAria: i18n.t(
      ($) => {
        return $.workflows.automations.gmail.removeCondition;
      },
      { number },
    ),
  };
}

function removeGmailMatchCondition(
  conditions: readonly GmailMatchCondition[],
  index: number,
): readonly GmailMatchCondition[] {
  return conditions.filter((_, conditionIndex) => {
    return conditionIndex !== index;
  });
}

function GmailMatchConditionRow({
  condition,
  conditions,
  index,
  disabled,
  onChange,
}: {
  readonly condition: GmailMatchCondition;
  readonly conditions: readonly GmailMatchCondition[];
  readonly index: number;
  readonly disabled: boolean;
  readonly onChange: (conditions: readonly GmailMatchCondition[]) => void;
}) {
  const fieldLabel = gmailMatchFieldOption(condition.field).label;
  const operatorOptions = gmailMatchOperatorOptions(condition.field);
  const operatorOption = gmailMatchOperatorOption(
    condition.field,
    condition.operator,
  );
  const operatorLabel = operatorOption.label;
  const copy = gmailMatchConditionCopy(index);
  const valueAriaLabel = `${fieldLabel} ${operatorLabel.toLocaleLowerCase(
    currentLocale(),
  )}`;
  const updateCondition = (update: Partial<GmailMatchCondition>) => {
    onChange(updateGmailMatchCondition(conditions, index, update));
  };

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_2.25rem] items-center gap-2 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.35fr)_minmax(0,2fr)_2.25rem]">
      <Select
        value={condition.field}
        disabled={disabled}
        onValueChange={(value) => {
          const field = gmailMatchFieldOption(value).field;
          updateCondition({
            field,
            operator: gmailMatchOperatorForField(field, condition.operator),
          });
        }}
      >
        <SelectTrigger aria-label={copy.fieldAria}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GMAIL_MATCH_FIELDS.map((option) => {
            const operator = gmailMatchOperatorForField(
              option.field,
              condition.operator,
            );
            return (
              <SelectItem
                key={option.field}
                value={option.field}
                disabled={gmailMatchConditionUsed(
                  conditions,
                  index,
                  option.field,
                  operator,
                )}
              >
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Select
        value={condition.operator}
        disabled={disabled}
        onValueChange={(value) => {
          updateCondition({
            operator: gmailMatchOperatorOption(condition.field, value).operator,
          });
        }}
      >
        <SelectTrigger aria-label={copy.operatorAria}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operatorOptions.map((option) => {
            return (
              <SelectItem
                key={option.operator}
                value={option.operator}
                disabled={gmailMatchConditionUsed(
                  conditions,
                  index,
                  condition.field,
                  option.operator,
                )}
              >
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Input
        name={`${condition.field}${operatorOption.formSuffix}`}
        aria-label={valueAriaLabel}
        value={condition.value}
        disabled={disabled}
        placeholder={copy.placeholder}
        className="col-span-2 row-start-2 sm:col-auto sm:row-auto"
        onChange={(event) => {
          updateCondition({ value: event.currentTarget.value });
        }}
      />
      <Button
        showTooltip
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copy.removeAria}
        disabled={disabled || conditions.length === 1}
        className="col-start-3 row-start-1 h-9 w-9 shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground sm:col-auto sm:row-auto [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
        onClick={() => {
          onChange(removeGmailMatchCondition(conditions, index));
        }}
      >
        <X size={16} />
      </Button>
    </div>
  );
}

function GmailMatchConditionsEditor({
  conditions,
  disabled,
  onChange,
}: {
  readonly conditions: readonly GmailMatchCondition[];
  readonly disabled: boolean;
  readonly onChange: (conditions: readonly GmailMatchCondition[]) => void;
}) {
  const nextCondition = nextGmailMatchCondition(conditions);
  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => {
        return (
          <GmailMatchConditionRow
            key={`${condition.field}-${condition.operator}`}
            condition={condition}
            conditions={conditions}
            index={index}
            disabled={disabled}
            onChange={onChange}
          />
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !nextCondition}
        className="-ml-2 w-fit px-2 font-normal"
        onClick={() => {
          if (nextCondition) {
            onChange([...conditions, nextCondition]);
          }
        }}
      >
        <Plus size={14} />
        {i18n.t(($) => {
          return $.workflows.automations.gmail.addCondition;
        })}
      </Button>
    </div>
  );
}

function CreateGmailNewMessageAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailAutomation] = useLoadableSet(
    createWorkflowGmailNewMessageAutomation$,
  );
  const matchConditions = useGet(createGmailMatchConditions$);
  const setMatchConditions = useSet(setCreateGmailMatchConditions$);
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent maxWidth="2xl">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.gmail.addMessageTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.gmail.addMessageDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.gmail.addMessageAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            detach(
              (async () => {
                await createGmailAutomation(
                  {
                    workflowId,
                    eventConfig: buildGmailNewMessageEventConfig(form),
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <GmailMatchConditionsEditor
            conditions={matchConditions}
            disabled={creating}
            onChange={setMatchConditions}
          />
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.automations.gmail.addMessageAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function signedWebhookCurlExample(
  automation: Pick<
    WebhookWorkflowAutomationSummary,
    "webhookSecret" | "webhookUrl"
  >,
): string {
  const secret = automation.webhookSecret ?? "<signing-secret>";
  const webhookUrl = automation.webhookUrl ?? "<webhook-url>";
  return [
    `BODY='{"hello":"world"}'`,
    "TIMESTAMP=$(date +%s)",
    `SIGNATURE=$(printf "%s.%s" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "${secret}" -hex | awk '{print $2}')`,
    `curl -X POST "${webhookUrl}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "X-Okou-Timestamp: $TIMESTAMP" \\',
    '  -H "X-Okou-Signature: $SIGNATURE" \\',
    '  --data "$BODY"',
  ].join("\n");
}

function CreateGmailLabelAppliedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailLabelAutomation] = useLoadableSet(
    createWorkflowGmailLabelAppliedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.gmail.addLabelTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.gmail.addLabelDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.gmail.addLabelAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const eventConfig = buildGmailLabelAppliedEventConfig(form);
            if (!eventConfig) {
              return;
            }
            detach(
              (async () => {
                await createGmailLabelAutomation(
                  { workflowId, eventConfig },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.gmail.labelName;
            })}
            <Input
              name="labelName"
              aria-label={i18n.t(($) => {
                return $.workflows.automations.gmail.labelName;
              })}
              required
              disabled={creating}
              placeholder={i18n.t(($) => {
                return $.workflows.automations.gmail.labelPlaceholder;
              })}
            />
          </label>
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.automations.gmail.addLabelAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GithubWorkflowRunAutomationFields({
  disabled,
  defaultConfig,
}: {
  readonly disabled: boolean;
  readonly defaultConfig?: GithubWorkflowRunCompletedEventConfig;
}) {
  const filters = defaultConfig?.filters;
  const fields: readonly {
    readonly fieldName: string;
    readonly label: string;
    readonly placeholder: string;
    readonly defaultValues: readonly string[] | undefined;
  }[] = [
    {
      fieldName: "repositories",
      label: i18n.t(($) => {
        return $.workflows.automations.github.repositories;
      }),
      placeholder: i18n.t(($) => {
        return $.workflows.automations.github.repositoriesPlaceholder;
      }),
      defaultValues: filters?.repositories,
    },
    {
      fieldName: "workflows",
      label: i18n.t(($) => {
        return $.workflows.automations.github.workflows;
      }),
      placeholder: i18n.t(($) => {
        return $.workflows.automations.github.workflowsPlaceholder;
      }),
      defaultValues: filters?.workflows,
    },
    {
      fieldName: "branches",
      label: i18n.t(($) => {
        return $.workflows.automations.github.branches;
      }),
      placeholder: i18n.t(($) => {
        return $.workflows.automations.github.branchesPlaceholder;
      }),
      defaultValues: filters?.branches,
    },
    {
      fieldName: "events",
      label: i18n.t(($) => {
        return $.workflows.automations.github.events;
      }),
      placeholder: i18n.t(($) => {
        return $.workflows.automations.github.eventsPlaceholder;
      }),
      defaultValues: filters?.events,
    },
    {
      fieldName: "actors",
      label: i18n.t(($) => {
        return $.workflows.automations.github.actors;
      }),
      placeholder: i18n.t(($) => {
        return $.workflows.automations.github.actorsPlaceholder;
      }),
      defaultValues: filters?.actors,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.filterHelp;
        })}
      </p>
      {fields.map((field) => {
        return (
          <label
            key={field.fieldName}
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {field.label}
            <Input
              name={field.fieldName}
              aria-label={field.label}
              disabled={disabled}
              defaultValue={field.defaultValues?.join(", ") ?? ""}
              placeholder={field.placeholder}
            />
          </label>
        );
      })}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.workflows.automations.github.conclusions;
          })}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS.map((option) => {
            return (
              <label
                key={option.value}
                className="flex items-center gap-2 text-xs text-foreground"
              >
                {/* Native input: the shared `Checkbox` renders a Base UI hidden
                    input that carries `name` but not `value`, so it would submit
                    "on" and this filter reads `FormData.getAll(name)`. */}
                <input
                  type="checkbox"
                  name="conclusions"
                  value={option.value}
                  disabled={disabled}
                  defaultChecked={filters?.conclusions?.includes(option.value)}
                  className="size-4 accent-primary"
                />
                {option.label}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.workflows.automations.github.selectNoneConclusion;
          })}
        </p>
      </fieldset>
    </div>
  );
}

function GithubFilterInput({
  name,
  label,
  placeholder,
  defaultValues,
  disabled,
}: {
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
  readonly defaultValues?: readonly string[];
  readonly disabled: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        name={name}
        aria-label={label}
        disabled={disabled}
        defaultValue={defaultValues?.join(", ") ?? ""}
        placeholder={placeholder}
      />
    </label>
  );
}

function GithubCheckboxFilters<T extends string>({
  name,
  label,
  options,
  selected,
  disabled,
}: {
  readonly name: string;
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly selected?: readonly T[];
  readonly disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs text-muted-foreground">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => {
          return (
            <label
              key={option.value}
              className="flex items-center gap-2 text-xs text-foreground"
            >
              {/* Native input: see the note in GithubWorkflowRunAutomationFields. */}
              <input
                type="checkbox"
                name={name}
                value={option.value}
                disabled={disabled}
                defaultChecked={selected?.includes(option.value)}
                className="size-4 accent-primary"
              />
              {option.label}
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.selectNoneAny;
        })}
      </p>
    </fieldset>
  );
}

function GithubWorkflowJobAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubWorkflowJobCompletedEventConfig;
}) {
  return (
    <>
      <GithubFilterInput
        name="workflows"
        label={i18n.t(($) => {
          return $.workflows.automations.github.workflows;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.workflowsShortPlaceholder;
        })}
        defaultValues={config?.filters.workflows}
        disabled={disabled}
      />
      <GithubFilterInput
        name="jobs"
        label={i18n.t(($) => {
          return $.workflows.automations.github.jobs;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.jobsPlaceholder;
        })}
        defaultValues={config?.filters.jobs}
        disabled={disabled}
      />
      <GithubFilterInput
        name="branches"
        label={i18n.t(($) => {
          return $.workflows.automations.github.branches;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.branchesPlaceholder;
        })}
        defaultValues={config?.filters.branches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="runnerLabels"
        label={i18n.t(($) => {
          return $.workflows.automations.github.runnerLabels;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.runnerLabelsPlaceholder;
        })}
        defaultValues={config?.filters.runnerLabels}
        disabled={disabled}
      />
      <GithubFilterInput
        name="runnerGroups"
        label={i18n.t(($) => {
          return $.workflows.automations.github.runnerGroups;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.runnerGroupsPlaceholder;
        })}
        defaultValues={config?.filters.runnerGroups}
        disabled={disabled}
      />
      <GithubCheckboxFilters
        name="conclusions"
        label={i18n.t(($) => {
          return $.workflows.automations.github.conclusions;
        })}
        options={GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS}
        selected={config?.filters.conclusions}
        disabled={disabled}
      />
    </>
  );
}

function GithubReviewAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubPullRequestReviewSubmittedEventConfig;
}) {
  return (
    <>
      <GithubFilterInput
        name="baseBranches"
        label={i18n.t(($) => {
          return $.workflows.automations.github.baseBranches;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.branchesPlaceholder;
        })}
        defaultValues={config?.filters.baseBranches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="headBranches"
        label={i18n.t(($) => {
          return $.workflows.automations.github.headBranches;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.headBranchesPlaceholder;
        })}
        defaultValues={config?.filters.headBranches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="trustedAuthors"
        label={i18n.t(($) => {
          return $.workflows.automations.github.trustedAuthors;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.authorsPlaceholder;
        })}
        defaultValues={config?.filters.trustedAuthors}
        disabled={disabled}
      />
      <GithubCheckboxFilters
        name="reviewStates"
        label={i18n.t(($) => {
          return $.workflows.automations.github.reviewStates;
        })}
        options={GITHUB_REVIEW_STATE_OPTIONS}
        selected={config?.filters.reviewStates}
        disabled={disabled}
      />
    </>
  );
}

function GithubDeploymentAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubDeploymentStatusCreatedEventConfig;
}) {
  const productionEnvironment = config?.filters.productionEnvironment;
  return (
    <>
      <GithubFilterInput
        name="environments"
        label={i18n.t(($) => {
          return $.workflows.automations.github.environments;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.environmentsPlaceholder;
        })}
        defaultValues={config?.filters.environments}
        disabled={disabled}
      />
      <GithubFilterInput
        name="refs"
        label={i18n.t(($) => {
          return $.workflows.automations.github.refs;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.refsPlaceholder;
        })}
        defaultValues={config?.filters.refs}
        disabled={disabled}
      />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.productionEnvironment;
        })}
        <Select
          name="productionEnvironment"
          defaultValue={
            productionEnvironment === undefined
              ? "any"
              : String(productionEnvironment)
          }
          disabled={disabled}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label={i18n.t(($) => {
              return $.workflows.automations.github.productionEnvironment;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">
              {i18n.t(($) => {
                return $.workflows.automations.github.any;
              })}
            </SelectItem>
            <SelectItem value="true">
              {i18n.t(($) => {
                return $.workflows.automations.github.productionOnly;
              })}
            </SelectItem>
            <SelectItem value="false">
              {i18n.t(($) => {
                return $.workflows.automations.github.nonProductionOnly;
              })}
            </SelectItem>
          </SelectContent>
        </Select>
      </label>
      <GithubFilterInput
        name="creators"
        label={i18n.t(($) => {
          return $.workflows.automations.github.creators;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.creatorsPlaceholder;
        })}
        defaultValues={config?.filters.creators}
        disabled={disabled}
      />
      <GithubFilterInput
        name="apps"
        label={i18n.t(($) => {
          return $.workflows.automations.github.apps;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.appsPlaceholder;
        })}
        defaultValues={config?.filters.apps}
        disabled={disabled}
      />
      <GithubCheckboxFilters
        name="deploymentStates"
        label={i18n.t(($) => {
          return $.workflows.automations.github.deploymentStates;
        })}
        options={GITHUB_DEPLOYMENT_STATE_OPTIONS}
        selected={config?.filters.states}
        disabled={disabled}
      />
    </>
  );
}

function GithubCommentAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubIssueCommentCreatedEventConfig;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.subject;
        })}
        <Select
          name="subject"
          defaultValue={config?.filters.subject ?? "both"}
          disabled={disabled}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label={i18n.t(($) => {
              return $.workflows.automations.github.subject;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITHUB_SUBJECT_OPTIONS.map((option) => {
              return (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </label>
      <GithubFilterInput
        name="trustedAuthors"
        label={i18n.t(($) => {
          return $.workflows.automations.github.trustedAuthors;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.authorsPlaceholder;
        })}
        defaultValues={config?.filters.trustedAuthors}
        disabled={disabled}
      />
      <GithubFilterInput
        name="commentPrefixes"
        label={i18n.t(($) => {
          return $.workflows.automations.github.commentPrefixes;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.commentPrefixesPlaceholder;
        })}
        defaultValues={config?.filters.commentPrefixes}
        disabled={disabled}
      />
    </>
  );
}

function GithubPullRequestMergedSelect({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubPullRequestEventConfig;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.github.pullRequestMerged;
      })}
      <Select
        name="merged"
        defaultValue={
          config?.merged === undefined ? "any" : String(config.merged)
        }
        disabled={disabled}
      >
        <SelectTrigger
          className="h-9 w-full"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.github.pullRequestMerged;
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">
            {i18n.t(($) => {
              return $.workflows.automations.github.any;
            })}
          </SelectItem>
          <SelectItem value="true">
            {i18n.t(($) => {
              return $.workflows.automations.github.pullRequestMergedOnly;
            })}
          </SelectItem>
          <SelectItem value="false">
            {i18n.t(($) => {
              return $.workflows.automations.github
                .pullRequestClosedWithoutMergeOnly;
            })}
          </SelectItem>
        </SelectContent>
      </Select>
    </label>
  );
}

function GithubPullRequestFilterFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubPullRequestEventConfig;
}) {
  return (
    <>
      <GithubFilterInput
        name="baseBranches"
        label={i18n.t(($) => {
          return $.workflows.automations.github.baseBranches;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.branchesPlaceholder;
        })}
        defaultValues={config?.filters.baseBranches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="authors"
        label={i18n.t(($) => {
          return $.workflows.automations.github.pullRequestAuthors;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.authorsPlaceholder;
        })}
        defaultValues={config?.filters.authors}
        disabled={disabled}
      />
      <GithubFilterInput
        name="pullRequestNumbers"
        label={i18n.t(($) => {
          return $.workflows.automations.github.pullRequestNumbers;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.pullRequestNumbersPlaceholder;
        })}
        defaultValues={config?.filters.pullRequestNumbers}
        disabled={disabled}
      />
      <GithubFilterInput
        name="labels"
        label={i18n.t(($) => {
          return $.workflows.automations.github.pullRequestLabels;
        })}
        placeholder={i18n.t(($) => {
          return $.workflows.automations.github.pullRequestLabelsPlaceholder;
        })}
        defaultValues={config?.filters.labels}
        disabled={disabled}
      />
    </>
  );
}

function GithubPullRequestAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubPullRequestEventConfig;
}) {
  const createAction = useGet(createGithubPullRequestAction$);
  const editingAction = useGet(editingGithubPullRequestAction$);
  const setCreateAction = useSet(setCreateGithubPullRequestAction$);
  const setEditingAction = useSet(setEditingGithubPullRequestAction$);
  const action = config ? (editingAction ?? config.action) : createAction;
  const setAction = config ? setEditingAction : setCreateAction;
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.repository;
        })}
        <Input
          name="repository"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.github.repository;
          })}
          required
          disabled={disabled}
          defaultValue={config?.repository ?? ""}
          placeholder={i18n.t(($) => {
            return $.workflows.automations.github.repositoryPlaceholder;
          })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.pullRequestAction;
        })}
        <Select
          name="action"
          value={action}
          disabled={disabled}
          onValueChange={(value) => {
            setAction(githubPullRequestActionValue(value, "closed"));
          }}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label={i18n.t(($) => {
              return $.workflows.automations.github.pullRequestAction;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITHUB_PULL_REQUEST_ACTION_OPTIONS.map((option) => {
              return (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </label>
      {action === "closed" ? (
        <GithubPullRequestMergedSelect disabled={disabled} config={config} />
      ) : null}
      <GithubPullRequestFilterFields disabled={disabled} config={config} />
    </>
  );
}
function githubWebhookAutomationSpecificFields(
  eventType: GithubWebhookAutomationEventType,
  disabled: boolean,
  defaultConfig: GithubWebhookAutomationEventConfig | undefined,
): ReactNode {
  switch (eventType) {
    case "github-pull-request": {
      const config =
        defaultConfig?.event === "pull_request" ? defaultConfig : undefined;
      return (
        <GithubPullRequestAutomationFields
          disabled={disabled}
          config={config}
        />
      );
    }
    case "github-workflow-job-completed": {
      const config =
        defaultConfig?.event === "workflow_job_completed"
          ? defaultConfig
          : undefined;
      return (
        <GithubWorkflowJobAutomationFields
          disabled={disabled}
          config={config}
        />
      );
    }
    case "github-pull-request-review-submitted": {
      const config =
        defaultConfig?.event === "pull_request_review_submitted"
          ? defaultConfig
          : undefined;
      return (
        <GithubReviewAutomationFields disabled={disabled} config={config} />
      );
    }
    case "github-deployment-status-created": {
      const config =
        defaultConfig?.event === "deployment_status_created"
          ? defaultConfig
          : undefined;
      return (
        <GithubDeploymentAutomationFields disabled={disabled} config={config} />
      );
    }
    case "github-issue-comment-created": {
      const config =
        defaultConfig?.event === "issue_comment_created"
          ? defaultConfig
          : undefined;
      return (
        <GithubCommentAutomationFields disabled={disabled} config={config} />
      );
    }
  }
}

function GithubWebhookAutomationFields({
  eventType,
  disabled,
  defaultConfig,
}: {
  readonly eventType: GithubWebhookAutomationEventType;
  readonly disabled: boolean;
  readonly defaultConfig?: GithubWebhookAutomationEventConfig;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.github.filterHelp;
        })}
      </p>
      {eventType !== "github-pull-request" &&
      defaultConfig?.event !== "pull_request" ? (
        <GithubFilterInput
          name="repositories"
          label={i18n.t(($) => {
            return $.workflows.automations.github.repositories;
          })}
          placeholder={i18n.t(($) => {
            return $.workflows.automations.github.repositoriesPlaceholder;
          })}
          defaultValues={defaultConfig?.filters.repositories}
          disabled={disabled}
        />
      ) : null}
      {githubWebhookAutomationSpecificFields(
        eventType,
        disabled,
        defaultConfig,
      )}
    </div>
  );
}

function GithubNotInstalledNotice({
  githubData,
}: {
  readonly githubData: GithubIntegrationData | null;
}) {
  const installUrl =
    githubData && !githubData.isInstalled
      ? (githubData.installUrl ?? null)
      : null;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.github.installedRequired;
      })}{" "}
      {installUrl ? (
        <Button
          asChild
          type="button"
          variant="link"
          className="h-auto p-0 text-xs"
        >
          <a href={installUrl} target="_blank" rel="noreferrer">
            {i18n.t(($) => {
              return $.workflows.automations.github.installApp;
            })}
          </a>
        </Button>
      ) : (
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.github.installAdminRequired;
          })}
        </span>
      )}
    </div>
  );
}

function GithubLoadErrorNotice() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {i18n.t(($) => {
        return $.workflows.automations.github.loadError;
      })}
    </div>
  );
}

function CreateGithubWorkflowRunCompletedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const githubLoadable = useLoadable(githubIntegrationData$);
  const githubData =
    githubLoadable.state === "hasData" ? githubLoadable.data : null;
  const [createLoadable, createGithubWorkflowRunAutomation] = useLoadableSet(
    createWorkflowGithubWorkflowRunCompletedAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const loadingGithub = githubLoadable.state === "loading";
  const githubLoadError = githubLoadable.state === "hasError";
  const isInstalled = githubData?.isInstalled ?? false;
  const submitDisabled =
    creating || loadingGithub || githubLoadError || !isInstalled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent contentClassName="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.github.addWorkflowTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.github.addWorkflowDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={i18n.t(($) => {
            return $.workflows.automations.github.addWorkflowAria;
          })}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const eventConfig = buildGithubWorkflowRunCompletedEventConfig(
              new FormData(event.currentTarget),
            );
            detach(
              (async () => {
                await createGithubWorkflowRunAutomation(
                  { workflowId, eventConfig },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <GithubWorkflowRunAutomationFields
            disabled={creating || loadingGithub || githubLoadError}
          />
          {githubLoadable.state === "hasData" && !isInstalled ? (
            <GithubNotInstalledNotice githubData={githubData} />
          ) : null}
          {githubLoadError ? <GithubLoadErrorNotice /> : null}
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
            submitDisabled={submitDisabled}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.automations.github.addWorkflowAction;
            })}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function githubWebhookAutomationTitle(
  eventType: GithubWebhookAutomationEventType,
): string {
  switch (eventType) {
    case "github-pull-request": {
      return i18n.t(($) => {
        return $.workflows.automations.github.pullRequestTitle;
      });
    }
    case "github-workflow-job-completed": {
      return i18n.t(($) => {
        return $.workflows.automations.github.workflowJobTitle;
      });
    }
    case "github-pull-request-review-submitted": {
      return i18n.t(($) => {
        return $.workflows.automations.github.reviewTitle;
      });
    }
    case "github-deployment-status-created": {
      return i18n.t(($) => {
        return $.workflows.automations.github.deploymentStatusTitle;
      });
    }
    case "github-issue-comment-created": {
      return i18n.t(($) => {
        return $.workflows.automations.github.issueCommentTitle;
      });
    }
  }
}

function githubWebhookDialogCopy(title: string) {
  const aria = i18n.t(
    ($) => {
      return $.workflows.automations.github.addWebhookAria;
    },
    { title },
  );
  return {
    action: i18n.t(($) => {
      return $.workflows.automations.github.addWebhookAction;
    }),
    aria,
    cancel: automationActionCopy().cancel,
    description: i18n.t(($) => {
      return $.workflows.automations.github.addWebhookDescription;
    }),
    title: aria,
  };
}

function CreateGithubWebhookAutomationDialog({
  workflowId,
  eventType,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly eventType: GithubWebhookAutomationEventType;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const githubLoadable = useLoadable(githubIntegrationData$);
  const githubData =
    githubLoadable.state === "hasData" ? githubLoadable.data : null;
  const [createLoadable, createGithubWebhookAutomation] = useLoadableSet(
    createWorkflowGithubWebhookAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const loadingGithub = githubLoadable.state === "loading";
  const githubLoadError = githubLoadable.state === "hasError";
  const isInstalled = githubData?.isInstalled ?? false;
  const submitDisabled =
    creating || loadingGithub || githubLoadError || !isInstalled;
  const title = githubWebhookAutomationTitle(eventType);
  const copy = githubWebhookDialogCopy(title);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent contentClassName="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form
          aria-label={copy.aria}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const eventConfig = buildGithubWebhookEventConfig(
              eventType,
              new FormData(event.currentTarget),
            );
            detach(
              (async () => {
                if (
                  eventType === "github-pull-request" &&
                  eventConfig.event === "pull_request"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-workflow-job-completed" &&
                  eventConfig.event === "workflow_job_completed"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-pull-request-review-submitted" &&
                  eventConfig.event === "pull_request_review_submitted"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-deployment-status-created" &&
                  eventConfig.event === "deployment_status_created"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-issue-comment-created" &&
                  eventConfig.event === "issue_comment_created"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                }
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <GithubWebhookAutomationFields
            eventType={eventType}
            disabled={creating || loadingGithub || githubLoadError}
          />
          {githubLoadable.state === "hasData" && !isInstalled ? (
            <GithubNotInstalledNotice githubData={githubData} />
          ) : null}
          {githubLoadError ? <GithubLoadErrorNotice /> : null}
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
            submitDisabled={submitDisabled}
          >
            {creating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <BrandGithub size={14} />
            )}
            {copy.action}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function googleCalendarDialogCopy(
  eventType: GoogleCalendarAutomationEventType,
) {
  const description =
    eventType === "google-calendar-event-cancelled"
      ? i18n.t(($) => {
          return $.workflows.automations.calendar.addDescriptionCancelled;
        })
      : eventType === "google-calendar-event-updated"
        ? i18n.t(($) => {
            return $.workflows.automations.calendar.addDescriptionUpdated;
          })
        : i18n.t(($) => {
            return $.workflows.automations.calendar.addDescriptionCreated;
          });
  return {
    action: i18n.t(($) => {
      return $.workflows.automations.calendar.addAction;
    }),
    aria: i18n.t(($) => {
      return $.workflows.automations.calendar.addAria;
    }),
    calendarId: i18n.t(($) => {
      return $.workflows.automations.calendar.calendarId;
    }),
    cancel: automationActionCopy().cancel,
    description,
    title: i18n.t(($) => {
      return $.workflows.automations.calendar.addTitle;
    }),
  };
}

function CreateGoogleCalendarEventAutomationDialog({
  workflowId,
  eventType,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly eventType: GoogleCalendarAutomationEventType;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGoogleCalendarAutomation] = useLoadableSet(
    createWorkflowGoogleCalendarEventAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const copy = googleCalendarDialogCopy(eventType);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form
          aria-label={copy.aria}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            detach(
              (async () => {
                const calendarId = googleCalendarIdFromForm(form);
                if (eventType === "google-calendar-event-created") {
                  await createGoogleCalendarAutomation(
                    {
                      workflowId,
                      eventType: "google-calendar-event-created",
                      eventConfig: {
                        provider: "google-calendar",
                        event: "event_created",
                        calendarId,
                      },
                    },
                    pageSignal,
                  );
                } else if (eventType === "google-calendar-event-updated") {
                  await createGoogleCalendarAutomation(
                    {
                      workflowId,
                      eventType: "google-calendar-event-updated",
                      eventConfig: {
                        provider: "google-calendar",
                        event: "event_updated",
                        calendarId,
                      },
                    },
                    pageSignal,
                  );
                } else {
                  await createGoogleCalendarAutomation(
                    {
                      workflowId,
                      eventType: "google-calendar-event-cancelled",
                      eventConfig: {
                        provider: "google-calendar",
                        event: "event_cancelled",
                        calendarId,
                      },
                    },
                    pageSignal,
                  );
                }
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {copy.calendarId}
            <Input
              name="calendarId"
              aria-label={copy.calendarId}
              disabled={creating}
              defaultValue="primary"
              placeholder={i18n.t(($) => {
                return $.workflows.automations.calendar.calendarIdPlaceholder;
              })}
            />
          </label>
          <AutomationFormActions
            pending={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {copy.action}
          </AutomationFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const createdAutomation = useGet(createdWorkflowWebhookAutomation$);
  const setCreatedAutomation = useSet(setCreatedWorkflowWebhookAutomation$);
  const reloadWorkflows = useSet(reloadWorkflows$);
  const [createLoadable, createWebhookAutomation] = useLoadableSet(
    createWorkflowWebhookAutomation$,
  );
  const upgradeDialogSource = useGet(workflowWebhookUpgradeDialogSource$);
  const creating =
    createLoadable.state === "loading" ||
    (upgradeDialogSource?.action === "create" &&
      upgradeDialogSource.workflowId === workflowId);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (createdAutomation) {
            reloadWorkflows();
          }
          setCreatedAutomation(null);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent maxWidth="2xl">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.webhook.addTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.automations.webhook.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {createdAutomation ? (
          <CreatedWebhookAutomationView
            automation={createdAutomation}
            onDone={() => {
              reloadWorkflows();
              setCreatedAutomation(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <CreateWebhookAutomationView
            creating={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
            onCreate={() => {
              detach(
                (async () => {
                  const automation = await createWebhookAutomation(
                    { workflowId },
                    pageSignal,
                  );
                  if (automation) {
                    setCreatedAutomation(automation);
                  }
                })(),
                Reason.DomCallback,
              );
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreatedWebhookAutomationView({
  automation,
  onDone,
}: {
  readonly automation: WebhookWorkflowAutomationSummary;
  readonly onDone: () => void;
}) {
  const curlExample = signedWebhookCurlExample(automation);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.webhook.url;
        })}
        {automation.webhookUrl ? (
          <WebhookReadonlyField
            value={automation.webhookUrl}
            onCopy={() => {
              copyText(automation.webhookUrl ?? "");
            }}
          />
        ) : null}
      </label>
      {automation.webhookSecret ? (
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.workflows.automations.webhook.secret;
          })}
          <WebhookReadonlyField
            value={automation.webhookSecret}
            onCopy={() => {
              copyText(automation.webhookSecret ?? "");
            }}
          />
        </label>
      ) : null}
      <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.webhook.signedCurl;
        })}
        <div className="relative min-w-0">
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-3 pr-20 font-mono text-xs leading-5 text-foreground">
            {curlExample}
          </pre>
          <Button
            type="button"
            variant="outline"
            className="absolute right-2 top-2 h-7 px-2 text-xs"
            onClick={() => {
              copyText(curlExample);
            }}
          >
            <Copy size={13} />
            {i18n.t(($) => {
              return $.workflows.automations.webhook.copy;
            })}
          </Button>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          {i18n.t(($) => {
            return $.workflows.automations.common.done;
          })}
        </Button>
      </DialogFooter>
    </div>
  );
}

function WebhookReadonlyField({
  value,
  onCopy,
}: {
  readonly value: string;
  readonly onCopy: () => void;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <Input readOnly value={value} className="min-w-0" />
      <Button type="button" variant="outline" onClick={onCopy}>
        <Copy size={14} />
        {i18n.t(($) => {
          return $.workflows.automations.webhook.copy;
        })}
      </Button>
    </div>
  );
}

function RevealWebhookSecretDialog({
  automation,
  onOpenChange,
}: {
  readonly automation: WebhookWorkflowAutomationSummary;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const copy = workflowWebhookCopy();
  const pageSignal = useGet(pageSignal$);
  const [revealLoadable, revealSecret] = useLoadableSet(
    revealWorkflowWebhookSecret$,
  );
  const secret =
    revealLoadable.state === "hasData" ? revealLoadable.data : null;
  const revealing = revealLoadable.state === "loading";
  const curlExample = secret ? signedWebhookCurlExample(secret) : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent maxWidth="2xl">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.workflows.automations.webhook.revealTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(
              ($) => {
                return $.workflows.automations.webhook.revealDescription;
              },
              { suffix: automation.secretLastFour },
            )}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="flex min-w-0 flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              {copy.url}
              <WebhookReadonlyField
                value={secret.webhookUrl}
                onCopy={() => {
                  copyText(secret.webhookUrl);
                }}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              {copy.secret}
              <WebhookReadonlyField
                value={secret.webhookSecret}
                onCopy={() => {
                  copyText(secret.webhookSecret);
                }}
              />
            </label>
            {curlExample ? (
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                {copy.signedCurl}
                <div className="relative min-w-0">
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-3 pr-20 font-mono text-xs leading-5 text-foreground">
                    {curlExample}
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    className="absolute right-2 top-2 h-7 px-2 text-xs"
                    onClick={() => {
                      copyText(curlExample);
                    }}
                  >
                    <Copy size={13} />
                    {copy.copy}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.webhook.secretHiddenHint;
            })}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {secret ? copy.done : copy.cancel}
          </Button>
          {!secret ? (
            <Button
              type="button"
              disabled={revealing}
              onClick={() => {
                detach(
                  (async () => {
                    await revealSecret(
                      { automationId: automation.id },
                      pageSignal,
                    );
                  })(),
                  Reason.DomCallback,
                  "reveal workflow webhook secret",
                );
              }}
            >
              {revealing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Eye size={14} />
              )}
              {copy.reveal}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookAutomationView({
  creating,
  onCancel,
  onCreate,
}: {
  readonly creating: boolean;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.webhook.secretOneTimeHint;
        })}
      </div>
      <WorkflowDialogFooter
        busy={creating}
        label={i18n.t(($) => {
          return $.workflows.automations.webhook.create;
        })}
        onCancel={onCancel}
        onConfirm={onCreate}
      />
    </div>
  );
}

function stripeDeliveryStatusLabel(status: StripeDeliveryStatus): string {
  switch (status) {
    case "pending": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.deliveryStatus.pending;
      });
    }
    case "delivered": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.deliveryStatus.delivered;
      });
    }
    case "skipped": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.deliveryStatus.skipped;
      });
    }
    case "failed": {
      return i18n.t(($) => {
        return $.workflows.automations.stripe.deliveryStatus.failed;
      });
    }
  }
}

function formatStripeHealthTimestamp(
  value: string | null,
  displayTimezone: string,
): string | null {
  if (!value || !hasValidRunTimestamp(value)) {
    return null;
  }
  return new Date(value).toLocaleString(currentLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: displayTimezone,
  });
}

function stripeLastMatchingEventLabel(
  automation: WorkflowStripeInvoicePaidAutomation,
  displayTimezone: string,
): string {
  return (
    formatStripeHealthTimestamp(
      automation.health.lastMatchingEventReceivedAt,
      displayTimezone,
    ) ??
    i18n.t(($) => {
      return $.workflows.automations.stripe.noMatchingEvents;
    })
  );
}

function stripeLastDeliveryLabel(
  automation: WorkflowStripeInvoicePaidAutomation,
  displayTimezone: string,
): string {
  const status = automation.health.lastDeliveryStatus;
  if (!status) {
    return i18n.t(($) => {
      return $.workflows.automations.stripe.noDeliveries;
    });
  }
  const statusLabel = stripeDeliveryStatusLabel(status);
  const timestamp = formatStripeHealthTimestamp(
    automation.health.lastDeliveryStatusAt,
    displayTimezone,
  );
  return timestamp ? `${statusLabel} · ${timestamp}` : statusLabel;
}

function AutomationRunStat({
  icon,
  label,
  value,
  emphasized,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly emphasized: boolean;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      aria-label={`${label}: ${value}`}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-sm",
          emphasized ? "font-medium text-foreground" : "text-muted-foreground",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function AutomationRowStats({
  automation,
  displayTimezone,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly displayTimezone: string;
}) {
  if (
    automation.kind === "event" &&
    automation.eventType === "stripe-invoice-paid"
  ) {
    return (
      <>
        <AutomationRunStat
          icon={<History size={14} />}
          label={i18n.t(($) => {
            return $.workflows.automations.stripe.lastEvent;
          })}
          value={stripeLastMatchingEventLabel(automation, displayTimezone)}
          emphasized={hasValidRunTimestamp(
            automation.health.lastMatchingEventReceivedAt,
          )}
        />
        <AutomationRunStat
          icon={<CircleCheck size={14} />}
          label={i18n.t(($) => {
            return $.workflows.automations.stripe.delivery;
          })}
          value={stripeLastDeliveryLabel(automation, displayTimezone)}
          emphasized={automation.health.lastDeliveryStatus !== null}
        />
      </>
    );
  }

  return (
    <>
      <AutomationRunStat
        icon={<History size={14} />}
        label={i18n.t(($) => {
          return $.workflows.automations.schedule.last;
        })}
        value={formatWorkflowAutomationRun(
          automation.lastRunAt,
          displayTimezone,
        )}
        emphasized={hasValidRunTimestamp(automation.lastRunAt)}
      />
      {automation.kind === "schedule" ? (
        <AutomationRunStat
          icon={<Clock size={14} />}
          label={i18n.t(($) => {
            return $.workflows.automations.schedule.next;
          })}
          value={formatWorkflowAutomationNextRun(
            automation.nextRunAt,
            displayTimezone,
          )}
          emphasized={hasValidRunTimestamp(automation.nextRunAt)}
        />
      ) : (
        <div aria-hidden="true" />
      )}
    </>
  );
}

function GoogleCalendarAutomationWarning({
  automation,
  canOperate,
  canEditStructure,
  onChangeCalendar,
}: {
  readonly automation: GoogleCalendarWorkflowAutomationSummary;
  readonly canOperate: boolean;
  readonly canEditStructure: boolean;
  readonly onChangeCalendar: () => void;
}) {
  if (!automation.warning) {
    return null;
  }
  const description =
    automation.warning === "calendar_not_found"
      ? i18n.t(($) => {
          return $.workflows.automations.calendar.calendarNotFoundDescription;
        })
      : i18n.t(($) => {
          return $.workflows.automations.calendar.reconnectDescription;
        });

  return (
    <div
      role="alert"
      className="flex min-w-0 items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400 sm:col-span-5"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium">
          {automation.enabled ? (
            <>
              {i18n.t(($) => {
                return $.workflows.automations.calendar.enabledIntent;
              })}
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          {i18n.t(($) => {
            return $.workflows.automations.calendar.actionRequiredPaused;
          })}
        </p>
        <p>{description}</p>
        {automation.warning === "calendar_not_found" && canEditStructure ? (
          <Button
            type="button"
            variant="link"
            className="h-auto w-fit p-0 text-xs text-amber-700 dark:text-amber-400"
            onClick={onChangeCalendar}
          >
            {i18n.t(($) => {
              return $.workflows.automations.calendar.changeCalendar;
            })}
          </Button>
        ) : null}
        {automation.warning === "reconnect_required" && canOperate ? (
          <GoogleCalendarReconnectAction automation={automation} />
        ) : null}
      </div>
    </div>
  );
}

function officialReconciliationStatusLabel(
  status: NonNullable<
    WorkflowAutomationSummary["official"]
  >["reconciliationStatus"],
): string {
  switch (status) {
    case "reconciling": {
      return i18n.t(($) => {
        return $.workflows.official.statusReconciling;
      });
    }
    case "needs_reconfiguration": {
      return i18n.t(($) => {
        return $.workflows.official.statusNeedsReconfiguration;
      });
    }
    case "failed": {
      return i18n.t(($) => {
        return $.workflows.official.statusFailed;
      });
    }
    case "current": {
      return i18n.t(($) => {
        return $.workflows.official.statusCurrent;
      });
    }
  }
}

function officialIntendedStateLabel(enabled: boolean): string {
  return enabled
    ? i18n.t(($) => {
        return $.workflows.official.intendedOn;
      })
    : i18n.t(($) => {
        return $.workflows.official.intendedOff;
      });
}

interface AutomationRowProps {
  readonly automation: WorkflowAutomationSummary;
  readonly canOperate: boolean;
  readonly canEditStructure: boolean;
  readonly displayTimezone: string;
  readonly showDivider: boolean;
}

function AutomationRowHeading({
  automation,
  title,
  subtitle,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly title: string;
  readonly subtitle: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <AutomationListIcon automation={automation} size="sm" />
      <div className="min-w-0">
        <div
          className="truncate text-sm font-medium text-foreground"
          title={title}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={subtitle}
          >
            {subtitle}
          </div>
        ) : null}
        {automation.official ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {i18n.t(
              ($) => {
                return $.workflows.official.reconciliationState;
              },
              {
                state: officialReconciliationStatusLabel(
                  automation.official.reconciliationStatus,
                ),
                intended: officialIntendedStateLabel(
                  automation.official.intendedEnabled,
                ),
              },
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AutomationRow({
  automation,
  canOperate,
  canEditStructure,
  displayTimezone,
  showDivider,
}: AutomationRowProps) {
  const targetedAutomationId = useGet(targetedWorkflowAutomationId$);
  const scrollRef = useSet(scrollTargetedWorkflowAutomationIntoViewRef$);
  const editingAutomationId = useGet(editingWorkflowAutomationId$);
  const setEditingAutomationId = useSet(setEditingWorkflowAutomationId$);
  const setEditingGoogleCalendarId = useSet(setEditingGoogleCalendarId$);
  const editing = editingAutomationId === automation.id;
  const targeted = targetedAutomationId === automation.id;
  const title = workflowScheduleTitle(automation, displayTimezone);
  const subtitle = workflowAutomationSubtitle(automation);
  const stripeAutomation =
    automation.kind === "event" &&
    automation.eventType === "stripe-invoice-paid"
      ? automation
      : null;
  const calendarAutomation = isGoogleCalendarWorkflowAutomation(automation)
    ? automation
    : null;

  return (
    <>
      <div
        ref={targeted ? scrollRef : undefined}
        data-automation-id={automation.id}
        aria-current={targeted ? "true" : undefined}
        className={cn(
          "group grid min-w-0 grid-cols-1 gap-3 px-5 py-4 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-state-hover sm:grid-cols-[minmax(0,1.2fr)_minmax(9rem,0.9fr)_minmax(13.5rem,1.1fr)_auto_7.75rem] sm:items-center sm:gap-4",
          targeted && "bg-state-selected ring-2 ring-inset ring-ring",
          !automation.enabled && "opacity-75",
        )}
      >
        <AutomationRowHeading
          automation={automation}
          title={title}
          subtitle={subtitle}
        />
        <AutomationRowStats
          automation={automation}
          displayTimezone={displayTimezone}
        />
        <AutomationStatusSwitch
          automation={automation}
          title={title}
          canManage={canOperate}
        />
        {canOperate ? (
          <AutomationControls
            automation={automation}
            displayTimezone={displayTimezone}
            canEditStructure={canEditStructure}
          />
        ) : (
          <div aria-hidden="true" />
        )}
        {calendarAutomation ? (
          <GoogleCalendarAutomationWarning
            automation={calendarAutomation}
            canOperate={canOperate}
            canEditStructure={canEditStructure}
            onChangeCalendar={() => {
              setEditingGoogleCalendarId(
                calendarAutomation.eventConfig.calendarId,
              );
              setEditingAutomationId(calendarAutomation.id);
            }}
          />
        ) : null}
        {stripeAutomation ? (
          <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground sm:col-span-5">
            <p>
              {i18n.t(($) => {
                return $.workflows.automations.stripe.immutableHint;
              })}
            </p>
            {stripeAutomation.health.warning === "delivery_failed" ? (
              <div
                role="alert"
                className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <p>
                  {i18n.t(($) => {
                    return $.workflows.automations.stripe.deliveryWarning;
                  })}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {showDivider ? (
        <div className="mx-5 h-px bg-divider/50" aria-hidden="true" />
      ) : null}
      {canEditStructure ? (
        <EditWorkflowAutomationDialog
          automation={automation}
          displayTimezone={displayTimezone}
          open={editing}
          onOpenChange={(open) => {
            if (!open) {
              setEditingAutomationId(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

function workflowAutomationSubtitle(
  automation: WorkflowAutomationSummary,
): string | null {
  if (
    isWebhookWorkflowAutomation(automation) &&
    automation.disabledReason === "paid_plan_required"
  ) {
    return i18n.t(($) => {
      return $.workflows.automations.common.disabledPaidPlan;
    });
  }
  const matchSummary = workflowAutomationSummary(automation);
  if (matchSummary) {
    return matchSummary;
  }
  if (isWebhookWorkflowAutomation(automation)) {
    return i18n.t(($) => {
      return $.workflows.automations.webhook.hidden;
    });
  }
  return automationKindLabel(automation);
}

function hasValidRunTimestamp(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

function formatWorkflowAutomationRun(
  value: string | null,
  displayTimezone: string,
): string {
  if (!value) {
    return i18n.t(($) => {
      return $.workflows.automations.schedule.noRunsYet;
    });
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return i18n.t(($) => {
      return $.workflows.automations.schedule.noRunsYet;
    });
  }

  return date.toLocaleString(currentLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: displayTimezone,
  });
}

function formatWorkflowAutomationNextRun(
  value: string | null,
  displayTimezone: string,
): string {
  if (!value) {
    return i18n.t(($) => {
      return $.workflows.automations.schedule.noUpcomingRun;
    });
  }

  return formatWorkflowAutomationRun(value, displayTimezone);
}

function AutomationStatusSwitch({
  automation,
  title,
  canManage,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly title: string;
  readonly canManage: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowAutomationEnabled$,
  );
  const upgradeDialogSource = useGet(workflowWebhookUpgradeDialogSource$);
  const toggling =
    enabledLoadable.state === "loading" ||
    (upgradeDialogSource?.action === "enable" &&
      upgradeDialogSource.automationId === automation.id);

  return (
    <div className="flex items-center justify-start sm:justify-center">
      <LoadingSwitch
        checked={automation.enabled}
        loading={toggling}
        disabled={!canManage}
        ariaLabel={i18n.t(
          ($) => {
            return automation.enabled
              ? $.workflows.automations.common.disable
              : $.workflows.automations.common.enable;
          },
          { title },
        )}
        onCheckedChange={(enabled) => {
          detach(
            setEnabled({ automationId: automation.id, enabled }, pageSignal),
            Reason.DomCallback,
          );
        }}
      />
    </div>
  );
}

function AutomationEditButton({
  automation,
  displayTimezone,
  busy,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly displayTimezone: string;
  readonly busy: boolean;
}) {
  const copy = automationActionCopy();
  const setEditingAutomationId = useSet(setEditingWorkflowAutomationId$);
  const setEditingGoogleCalendarId = useSet(setEditingGoogleCalendarId$);
  const setEditingScheduleCronFields = useSet(setEditingScheduleCronFields$);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={copy.editAutomation}
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-selected-hover hover:text-foreground"
          onClick={() => {
            if (
              automation.kind === "schedule" &&
              automation.schedule.type === "cron"
            ) {
              setEditingScheduleCronFields(
                parseWorkflowCronFields(automation.schedule, displayTimezone),
              );
            }
            if (isGoogleCalendarWorkflowAutomation(automation)) {
              setEditingGoogleCalendarId(automation.eventConfig.calendarId);
            }
            setEditingAutomationId(automation.id);
          }}
        >
          <Pencil size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">{copy.editAutomation}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function AutomationControls({
  automation,
  displayTimezone,
  canEditStructure,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly displayTimezone: string;
  readonly canEditStructure: boolean;
}) {
  const copy = automationActionCopy();
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const revealWebhookSecretAutomationId = useGet(
    revealWebhookSecretAutomationId$,
  );
  const setRevealWebhookSecretAutomationId = useSet(
    setRevealWebhookSecretAutomationId$,
  );
  const [runNowLoadable, runNow] = useLoadableSet(runWorkflowAutomationNow$);
  const busy = runNowLoadable.state === "loading";
  const canEdit = canEditStructure && canEditWorkflowAutomation(automation);
  const revealWebhookSecretOpen =
    revealWebhookSecretAutomationId === automation.id &&
    isWebhookWorkflowAutomation(automation);

  return (
    <div className="flex min-w-0 items-center justify-end pr-1.5">
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center justify-end gap-1 opacity-100 transition-opacity pointer-events-auto [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:pointer-events-auto [@media(hover:hover)]:group-focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={copy.runNow}
                className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-selected-hover hover:text-foreground"
                onClick={() => {
                  detach(
                    (async () => {
                      const result = await runNow(automation.id, pageSignal);
                      navigate(ROUTES.chat, {
                        pathParams: { threadId: result.chatThreadId },
                      });
                    })(),
                    Reason.DomCallback,
                    "run workflow automation now",
                  );
                }}
              >
                {busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{copy.runNow}</p>
            </TooltipContent>
          </Tooltip>
          {canEdit ? (
            <AutomationEditButton
              automation={automation}
              displayTimezone={displayTimezone}
              busy={busy}
            />
          ) : null}
          {canEditStructure || isWebhookWorkflowAutomation(automation) ? (
            <AutomationMoreActionsMenu
              automation={automation}
              disabled={busy}
              canDelete={canEditStructure}
              onRevealWebhookSecret={
                isWebhookWorkflowAutomation(automation)
                  ? () => {
                      setRevealWebhookSecretAutomationId(automation.id);
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </TooltipProvider>
      {revealWebhookSecretOpen && isWebhookWorkflowAutomation(automation) ? (
        <RevealWebhookSecretDialog
          automation={automation}
          onOpenChange={(open) => {
            if (!open) {
              setRevealWebhookSecretAutomationId(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function AutomationMoreActionsMenu({
  automation,
  disabled,
  canDelete,
  onRevealWebhookSecret,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly disabled: boolean;
  readonly canDelete: boolean;
  readonly onRevealWebhookSecret?: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [deleteLoadable, deleteAutomation] = useLoadableSet(
    deleteWorkflowAutomation$,
  );
  const deleting = deleteLoadable.state === "loading";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || deleting}
              aria-label={i18n.t(($) => {
                return $.workflows.automations.common.moreActions;
              })}
              className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-state-selected-hover hover:text-foreground data-popup-open:bg-state-selected-hover data-popup-open:text-foreground"
            >
              <EllipsisVertical size={14} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            {i18n.t(($) => {
              return $.workflows.automations.common.moreActions;
            })}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        {onRevealWebhookSecret ? (
          <DropdownMenuModalItem
            disabled={deleting}
            className="gap-2"
            onModalSelect={onRevealWebhookSecret}
          >
            <Eye size={14} />
            {i18n.t(($) => {
              return $.workflows.automations.webhook.revealTitle;
            })}
          </DropdownMenuModalItem>
        ) : null}
        {canDelete ? (
          <DropdownMenuItem
            disabled={deleting}
            className="gap-2 text-destructive focus:text-destructive"
            onClick={() => {
              detach(
                deleteAutomation(automation.id, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {deleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash size={14} />
            )}
            {i18n.t(($) => {
              return $.workflows.automations.common.deleteAutomation;
            })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function canEditWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): boolean {
  return (
    automation.kind === "schedule" ||
    isGmailWorkflowAutomation(automation) ||
    isGithubWorkflowAutomation(automation) ||
    isGoogleCalendarWorkflowAutomation(automation) ||
    (automation.kind === "event" &&
      automation.eventType === "chat-run-finished")
  );
}

function editWorkflowAutomationTitle(
  automation: WorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return i18n.t(($) => {
      return $.workflows.automations.schedule.editSchedule;
    });
  }

  if (automation.eventType === "chat-run-finished") {
    return i18n.t(($) => {
      return $.workflows.automations.chat.viewTitle;
    });
  }
  if (isGoogleCalendarWorkflowAutomation(automation)) {
    return i18n.t(($) => {
      return $.workflows.automations.calendar.changeCalendar;
    });
  }
  if (automation.eventType === "gmail-new-message") {
    return i18n.t(($) => {
      return $.workflows.automations.gmail.editMatch;
    });
  }
  if (automation.eventType === "github-workflow-run-completed") {
    return i18n.t(($) => {
      return $.workflows.automations.github.editWorkflowFilters;
    });
  }
  if (isGithubWebhookWorkflowAutomation(automation)) {
    return i18n.t(
      ($) => {
        return $.workflows.automations.github.editWebhookFilters;
      },
      { title: githubWebhookAutomationTitle(automation.eventType) },
    );
  }
  return automation.eventType === "gmail-label-applied"
    ? i18n.t(($) => {
        return $.workflows.automations.gmail.editLabel;
      })
    : i18n.t(($) => {
        return $.workflows.automations.github.editLabel;
      });
}

function EditWorkflowAutomationDialog({
  automation,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const close = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        maxWidth={
          automation.kind === "event" &&
          (automation.eventType === "gmail-new-message" ||
            automation.eventType === "github-workflow-run-completed" ||
            isGithubWebhookWorkflowAutomation(automation))
            ? "2xl"
            : "lg"
        }
      >
        <DialogHeader>
          <DialogTitle>{editWorkflowAutomationTitle(automation)}</DialogTitle>
          <DialogDescription>
            {automation.kind === "event" &&
            automation.eventType === "chat-run-finished"
              ? i18n.t(($) => {
                  return $.workflows.automations.chat.viewDescription;
                })
              : i18n.t(($) => {
                  return $.workflows.automations.common.updateDescription;
                })}
          </DialogDescription>
        </DialogHeader>
        {automation.kind === "event" &&
        automation.eventType === "chat-run-finished" ? (
          <ChatRunFinishedAutomationDetails
            automation={automation}
            onClose={close}
          />
        ) : null}
        {automation.kind === "schedule" ? (
          <UpdateScheduleAutomationForm
            automation={automation}
            displayTimezone={displayTimezone}
            onCancel={close}
          />
        ) : null}
        {isGoogleCalendarWorkflowAutomation(automation) ? (
          <UpdateGoogleCalendarAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-new-message" ? (
          <UpdateGmailNewMessageAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-label-applied" ? (
          <UpdateGmailLabelAppliedAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "github-workflow-run-completed" ? (
          <UpdateGithubWorkflowRunCompletedAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {isGithubWebhookWorkflowAutomation(automation) ? (
          <UpdateGithubWebhookAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChatRunFinishedAutomationDetails({
  automation,
  onClose,
}: {
  readonly automation: Extract<
    WorkflowAutomationSummary,
    { readonly kind: "event"; readonly eventType: "chat-run-finished" }
  >;
  readonly onClose: () => void;
}) {
  const actionCopy = automationActionCopy();
  const config = automation.eventConfig;
  const statuses = config.runStatuses ?? CHAT_RUN_FINISHED_STATUSES;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.watchedThreadLabel;
        })}
        <Link
          pathname={ROUTES.chat}
          options={{ pathParams: { threadId: config.chatThreadId } }}
          className="w-fit rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground underline-offset-2 hover:underline"
        >
          {config.chatThreadId}
        </Link>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.statusesLabel;
        })}
        <span className="text-sm text-foreground">
          {statuses.map(chatRunFinishedStatusLabel).join(", ")}
        </span>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.chat.patternLabel;
        })}
        {config.outputPattern ? (
          <span className="w-fit rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground">
            {config.outputPattern}
          </span>
        ) : (
          <span className="text-sm text-foreground">
            {i18n.t(($) => {
              return $.workflows.automations.chat.anyOutput;
            })}
          </span>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {actionCopy.done}
        </Button>
      </DialogFooter>
    </div>
  );
}

function UpdateScheduleAutomationForm({
  automation,
  displayTimezone,
  onCancel,
}: {
  readonly automation: Extract<WorkflowAutomationSummary, { kind: "schedule" }>;
  readonly displayTimezone: string;
  readonly onCancel: () => void;
}) {
  const cronFields = useGet(editingScheduleCronFields$);
  const setCronFields = useSet(setEditingScheduleCronFields$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateScheduleAutomation] = useLoadableSet(
    updateWorkflowScheduleAutomation$,
  );
  const saving = updateLoadable.state === "loading";
  const schedule = automation.schedule;

  return (
    <form
      aria-label={i18n.t(($) => {
        return $.workflows.automations.schedule.updateScheduleAria;
      })}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const scheduleValue = buildAutomationSchedule(
          schedule.type,
          {
            cronFields,
            intervalSeconds: String(form.get("intervalSeconds") ?? ""),
            atTime: String(form.get("atTime") ?? ""),
          },
          displayTimezone,
        );
        if (!scheduleValue) {
          return;
        }
        detach(
          (async () => {
            await updateScheduleAutomation(
              {
                automationId: automation.id,
                schedule: scheduleValue,
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <ScheduleAutomationFields
        scheduleType={schedule.type}
        cronFields={cronFields}
        setCronFields={setCronFields}
        displayTimezone={displayTimezone}
        defaultIntervalSeconds={
          schedule.type === "loop" ? schedule.intervalSeconds : undefined
        }
        defaultAtTime={
          schedule.type === "once"
            ? localDateTimeInputValue(schedule.atTime)
            : undefined
        }
        disabled={saving}
      />
      <AutomationFormActions pending={saving} onCancel={onCancel}>
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Clock size={13} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.schedule.saveSchedule;
          })}
        </span>
      </AutomationFormActions>
    </form>
  );
}

function UpdateGoogleCalendarAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: GoogleCalendarWorkflowAutomationSummary;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const calendarId = useGet(editingGoogleCalendarId$);
  const setCalendarId = useSet(setEditingGoogleCalendarId$);
  const [updateLoadable, updateGoogleCalendarAutomation] = useLoadableSet(
    updateWorkflowGoogleCalendarAutomationEventConfig$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label={i18n.t(($) => {
        return $.workflows.automations.calendar.changeAria;
      })}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const submittedCalendarId = calendarId.trim();
        if (!submittedCalendarId) {
          return;
        }
        detach(
          (async () => {
            await updateGoogleCalendarAutomation(
              {
                automationId: automation.id,
                eventConfig: updatedGoogleCalendarEventConfig(
                  automation,
                  submittedCalendarId,
                ),
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.calendar.calendarId;
        })}
        <Input
          name="calendarId"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.calendar.calendarId;
          })}
          className={AUTOMATION_FIELD_CLASS}
          disabled={saving}
          maxLength={1024}
          placeholder={i18n.t(($) => {
            return $.workflows.automations.calendar.calendarIdPlaceholder;
          })}
          required
          value={calendarId}
          onChange={(event) => {
            setCalendarId(event.target.value);
          }}
        />
      </label>
      {updateLoadable.state === "hasError" ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            {i18n.t(($) => {
              return $.workflows.automations.calendar.updateError;
            })}
          </p>
        </div>
      ) : null}
      <AutomationFormActions pending={saving} onCancel={onCancel}>
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <CalendarClock size={13} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.calendar.saveCalendar;
          })}
        </span>
      </AutomationFormActions>
    </form>
  );
}

function UpdateGmailNewMessageAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    WorkflowAutomationSummary,
    { eventType: "gmail-new-message" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailAutomation] = useLoadableSet(
    updateWorkflowAutomationEventConfig$,
  );
  const matchConditionsByAutomationId = useGet(editingGmailMatchConditions$);
  const setMatchConditions = useSet(setEditingGmailMatchConditions$);
  const matchConditions =
    matchConditionsByAutomationId[automation.id] ??
    gmailMatchConditions(automation.eventConfig);
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label={i18n.t(($) => {
        return $.workflows.automations.gmail.updateMessageAria;
      })}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        detach(
          (async () => {
            await updateGmailAutomation(
              {
                automationId: automation.id,
                eventConfig: buildGmailNewMessageEventConfig(
                  form,
                  automation.eventConfig,
                ),
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <GmailMatchConditionsEditor
        conditions={matchConditions}
        disabled={saving}
        onChange={(conditions) => {
          setMatchConditions({ automationId: automation.id, conditions });
        }}
      />
      <AutomationFormActions pending={saving} onCancel={onCancel}>
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Mail size={13} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.gmail.saveMatch;
          })}
        </span>
      </AutomationFormActions>
    </form>
  );
}

function UpdateGmailLabelAppliedAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    WorkflowAutomationSummary,
    { eventType: "gmail-label-applied" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailLabelAutomation] = useLoadableSet(
    updateWorkflowAutomationEventConfig$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label={i18n.t(($) => {
        return $.workflows.automations.gmail.updateLabelAria;
      })}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const eventConfig = buildGmailLabelAppliedEventConfig(form);
        if (!eventConfig) {
          return;
        }
        detach(
          (async () => {
            await updateGmailLabelAutomation(
              {
                automationId: automation.id,
                eventConfig,
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.automations.gmail.labelName;
        })}
        <Input
          name="labelName"
          aria-label={i18n.t(($) => {
            return $.workflows.automations.gmail.labelName;
          })}
          required
          defaultValue={automation.eventConfig.labelName}
          disabled={saving}
          placeholder={i18n.t(($) => {
            return $.workflows.automations.gmail.labelPlaceholder;
          })}
          className={AUTOMATION_FIELD_CLASS}
        />
      </label>
      <AutomationFormActions pending={saving} onCancel={onCancel}>
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Mail size={13} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.gmail.saveLabel;
          })}
        </span>
      </AutomationFormActions>
    </form>
  );
}

function UpdateGithubWorkflowRunCompletedAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    WorkflowAutomationSummary,
    { eventType: "github-workflow-run-completed" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGithubWorkflowRunAutomation] = useLoadableSet(
    updateWorkflowAutomationEventConfig$,
  );
  const saving = updateLoadable.state === "loading";
  return (
    <form
      aria-label={i18n.t(($) => {
        return $.workflows.automations.github.updateWorkflowAria;
      })}
      className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1"
      onSubmit={(event) => {
        event.preventDefault();
        const eventConfig = buildGithubWorkflowRunCompletedEventConfig(
          new FormData(event.currentTarget),
        );
        detach(
          (async () => {
            await updateGithubWorkflowRunAutomation(
              {
                automationId: automation.id,
                eventConfig,
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <GithubWorkflowRunAutomationFields
        disabled={saving}
        defaultConfig={automation.eventConfig}
      />
      <AutomationFormActions pending={saving} onCancel={onCancel}>
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <BrandGithub size={13} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.github.saveFilters;
          })}
        </span>
      </AutomationFormActions>
    </form>
  );
}

function UpdateGithubWebhookAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: GithubWebhookWorkflowAutomationSummary;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGithubWebhookAutomation] = useLoadableSet(
    updateWorkflowAutomationEventConfig$,
  );
  const saving = updateLoadable.state === "loading";
  return (
    <form
      aria-label={i18n.t(
        ($) => {
          return $.workflows.automations.github.updateWebhookAria;
        },
        { title: githubWebhookAutomationTitle(automation.eventType) },
      )}
      className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1"
      onSubmit={(event) => {
        event.preventDefault();
        const eventConfig = buildGithubWebhookEventConfig(
          automation.eventType,
          new FormData(event.currentTarget),
        );
        detach(
          (async () => {
            await updateGithubWebhookAutomation(
              { automationId: automation.id, eventConfig },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <GithubWebhookAutomationFields
        eventType={automation.eventType}
        disabled={saving}
        defaultConfig={automation.eventConfig}
      />
      <AutomationFormActions pending={saving} onCancel={onCancel}>
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <BrandGithub size={13} />
        )}
        <span>
          {i18n.t(($) => {
            return $.workflows.automations.github.saveFilters;
          })}
        </span>
      </AutomationFormActions>
    </form>
  );
}

function DetailSkeleton() {
  return (
    <DetailPageShell scroll={false}>
      <WorkflowBreadcrumb detail={null} />
      <DetailPageHeader className="pb-3">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="mt-4 h-9 w-80 rounded bg-muted" />
        </div>
      </DetailPageHeader>
    </DetailPageShell>
  );
}
