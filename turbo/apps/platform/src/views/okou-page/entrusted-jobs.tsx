import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Archive, ArrowRight, LoaderCircle } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@okouai/ui";
import type { Job, JobSummary } from "@okouai/api-contracts/contracts/jobs";
import {
  entrustedJobs$,
  jobHasPreviousPage$,
  nextJobPage$,
  previousJobPage$,
  jobListFilter$,
  selectJobListFilter$,
  selectedJob$,
  selectedJobId$,
  selectJob$,
  jobReplyText$,
  setJobReply$,
  submitJobReply$,
  jobReplySaved$,
  jobGrantDuration$,
  setJobGrantDuration$,
  respondToJobAuthorization$,
  archiveSelectedJob$,
  bindJobResult$,
  selectedJobGrant$,
  bindJobFilterTab$,
  jobReturnFocus$,
  openJobFromCard$,
} from "../../signals/okou-page/entrusted-jobs.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function JobAuthorization({ job }: { readonly job: Job }) {
  const { t } = useTranslation();
  const durationLabels = t(
    ($) => {
      return $.chat.entrustedJobs.durations;
    },
    { returnObjects: true },
  );
  const duration = useGet(jobGrantDuration$);
  const chooseDuration = useSet(setJobGrantDuration$);
  const [operation, respond] = useLoadableSet(respondToJobAuthorization$);
  const signal = useGet(pageSignal$);
  const request = job.work.authorization;
  const currentGrant = useLoadable(selectedJobGrant$);
  if (!request || job.status !== "waiting_authorization") {
    return null;
  }
  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <p className="text-sm">{request.action}</p>
      <p className="break-words text-xs text-muted-foreground">
        {request.connector} · {request.permission}
      </p>
      {currentGrant.state === "hasData" && currentGrant.data && (
        <p className="text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.chat.entrustedJobs.currentGrant;
            },
            {
              scope: `${currentGrant.data.connectorSlug}/${currentGrant.data.permission}`,
              expiry:
                currentGrant.data.expiresAt === null
                  ? t(($) => {
                      return $.chat.entrustedJobs.noExpiry;
                    })
                  : new Date(currentGrant.data.expiresAt).toLocaleString(),
            },
          )}
        </p>
      )}
      <label className="text-sm font-medium" htmlFor="job-grant-duration">
        {t(($) => {
          return $.chat.entrustedJobs.duration;
        })}
      </label>
      <Select value={duration} onValueChange={chooseDuration}>
        <SelectTrigger id="job-grant-duration">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(["1h", "24h", "7d", "always"] as const).map((value) => {
            return (
              <SelectItem key={value} value={value}>
                {durationLabels[value]}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={operation.state === "loading"}
          onClick={() => {
            detach(respond("granted", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.entrustedJobs.authorize;
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={operation.state === "loading"}
          onClick={() => {
            detach(respond("declined", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.entrustedJobs.decline;
          })}
        </Button>
      </div>
    </section>
  );
}

function JobResult({ job }: { readonly job: Job }) {
  const { t } = useTranslation();
  const bindResult = useSet(bindJobResult$);
  const result = job.results.find((item) => {
    return item.id === job.work.currentResultId;
  });
  return (
    <>
      {result && (
        <section
          key={result.id}
          ref={
            job.status === "completed" &&
            !job.viewedResultIds.includes(result.id)
              ? bindResult
              : undefined
          }
          data-job-id={job.id}
          data-result-id={result.id}
          className="grid gap-3 rounded-xl border border-border p-4"
        >
          <h3 className="text-sm font-medium">
            {t(($) => {
              return $.chat.entrustedJobs.result;
            })}
          </h3>
          <p className="whitespace-pre-wrap break-words text-sm">
            {result.text}
          </p>
          {result.references.map((reference) => {
            return (
              <a
                key={`${reference.url}/${reference.title}`}
                className="text-sm text-primary underline underline-offset-4 hover:text-primary/80"
                href={reference.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {reference.title}
              </a>
            );
          })}
        </section>
      )}
    </>
  );
}

function TaskInputContent({
  input,
}: {
  readonly input: Job["inputs"][number];
}) {
  const { t } = useTranslation();
  return (
    <>
      {input.kind === "reply"
        ? input.text
        : input.kind === "observation"
          ? `${t(($) => {
              return $.chat.entrustedJobs.sourceUpdate;
            })}: ${input.text}`
          : t(($) => {
              return input.outcome === "granted"
                ? $.chat.entrustedJobs.granted
                : $.chat.entrustedJobs.declined;
            })}
    </>
  );
}

function JobDetails({ job }: { readonly job: Job }) {
  const { t } = useTranslation();
  const statusLabels = t(
    ($) => {
      return $.chat.entrustedJobs.states;
    },
    { returnObjects: true },
  );
  const text = useGet(jobReplyText$);
  const setText = useSet(setJobReply$);
  const saved = useGet(jobReplySaved$);
  const [reply, submit] = useLoadableSet(submitJobReply$);
  const [archive, doArchive] = useLoadableSet(archiveSelectedJob$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm font-medium">{statusLabels[job.status]}</p>
        <p className="whitespace-pre-wrap break-words text-sm">
          {job.objective}
        </p>
      </div>
      {job.work.explanation && (
        <p className="whitespace-pre-wrap break-words text-sm">
          {job.work.explanation}
        </p>
      )}
      {job.work.progress && (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">
            {t(($) => {
              return $.chat.entrustedJobs.progress;
            })}
          </h3>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {job.work.progress}
          </p>
        </section>
      )}
      <JobResult job={job} />
      {job.inputs.length > 0 && (
        <section className="grid gap-3">
          <h3 className="text-sm font-medium">
            {t(($) => {
              return $.chat.entrustedJobs.replies;
            })}
          </h3>
          {job.inputs.map((input) => {
            return (
              <p
                key={input.id}
                className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm"
              >
                <TaskInputContent input={input} />
              </p>
            );
          })}
        </section>
      )}
      <JobAuthorization job={job} />
      {job.status !== "archived" && (
        <>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              detach(submit(signal), Reason.DomCallback);
            }}
          >
            <label className="text-sm font-medium" htmlFor="job-reply">
              {t(($) => {
                return $.chat.entrustedJobs.reply;
              })}
            </label>
            <Textarea
              id="job-reply"
              value={text}
              maxLength={16_000}
              rows={3}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                disabled={!text.trim() || reply.state === "loading"}
              >
                {t(($) => {
                  return $.chat.entrustedJobs.saveReply;
                })}
              </Button>
              {saved && (
                <p role="status" className="text-xs text-muted-foreground">
                  {t(($) => {
                    return $.chat.entrustedJobs.saved;
                  })}
                </p>
              )}
            </div>
          </form>
          <Button
            type="button"
            variant="ghost"
            className="justify-self-start"
            disabled={archive.state === "loading"}
            onClick={() => {
              detach(doArchive(signal), Reason.DomCallback);
            }}
          >
            <Archive size={16} />
            {t(($) => {
              return $.chat.entrustedJobs.archive;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

function JobDialog({
  returnFocus,
}: {
  readonly returnFocus: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const id = useGet(selectedJobId$);
  const select = useSet(selectJob$);
  const detail = useLastLoadable(selectedJob$);
  const job =
    detail.state === "hasData" && detail.data?.id === id ? detail.data : null;
  return (
    <Dialog
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) {
          select(null);
        }
      }}
    >
      <DialogContent maxWidth="lg" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>
            {job?.title ??
              t(($) => {
                return $.chat.entrustedJobs.details;
              })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.entrustedJobs.detailsDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {job ? (
          <JobDetails job={job} />
        ) : detail.state === "hasError" ? (
          <p role="status">
            {t(($) => {
              return $.global.errors.requestFailed;
            })}
          </p>
        ) : (
          <LoaderCircle
            className="animate-spin"
            aria-label={t(($) => {
              return $.chat.entrustedJobs.loading;
            })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function rank(job: JobSummary) {
  return job.status.startsWith("waiting_") ? 0 : job.hasUnseenResult ? 1 : 2;
}
function JobPagination() {
  const { t } = useTranslation();
  const page = useLastLoadable(entrustedJobs$);
  const pending = useLoadable(entrustedJobs$);
  const hasPrevious = useGet(jobHasPreviousPage$);
  const previous = useSet(previousJobPage$);
  const next = useSet(nextJobPage$);
  const signal = useGet(pageSignal$);
  return (
    <>
      {(hasPrevious || (page.state === "hasData" && page.data.nextAfter)) && (
        <div className="flex justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            disabled={!hasPrevious || pending.state === "loading"}
            onClick={previous}
          >
            {t(($) => {
              return $.chat.entrustedJobs.previous;
            })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={
              page.state !== "hasData" ||
              !page.data.nextAfter ||
              pending.state === "loading"
            }
            onClick={() => {
              detach(next(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.entrustedJobs.next;
            })}
          </Button>
        </div>
      )}
    </>
  );
}

export function EntrustedJobs() {
  const { t } = useTranslation();
  const statusLabels = t(
    ($) => {
      return $.chat.entrustedJobs.states;
    },
    { returnObjects: true },
  );
  const filterLabels = t(
    ($) => {
      return $.chat.entrustedJobs.filters;
    },
    { returnObjects: true },
  );
  const returnFocus = useGet(jobReturnFocus$);
  const filterTab = useSet(bindJobFilterTab$);
  const page = useLastLoadable(entrustedJobs$);
  const pending = useLoadable(entrustedJobs$);
  const filter = useGet(jobListFilter$);
  const chooseFilter = useSet(selectJobListFilter$);
  const openJob = useSet(openJobFromCard$);
  const jobs =
    page.state === "hasData"
      ? [...page.data.jobs].sort((left, right) => {
          return (
            rank(left) - rank(right) ||
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.id.localeCompare(right.id)
          );
        })
      : [];
  return (
    <div className="grid gap-4">
      <Tabs
        value={filter}
        onValueChange={(value) => {
          if (typeof value === "string") {
            chooseFilter(value);
          }
        }}
      >
        <TabsList>
          {(["home", "history", "archived"] as const).map((value) => {
            return (
              <TabsTrigger
                key={value}
                value={value}
                ref={filter === value ? filterTab : undefined}
              >
                {filterLabels[value]}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      {page.state === "hasError" ? (
        <p role="status">
          {t(($) => {
            return $.global.errors.requestFailed;
          })}
        </p>
      ) : pending.state === "loading" && page.state !== "hasData" ? (
        <LoaderCircle
          className="animate-spin"
          aria-label={t(($) => {
            return $.chat.entrustedJobs.loading;
          })}
        />
      ) : jobs.length === 0 ? (
        <p className="py-5 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.entrustedJobs.empty;
          })}
        </p>
      ) : (
        jobs.map((job) => {
          return (
            <Button
              key={job.id}
              type="button"
              variant="neutral"
              className="h-auto min-h-20 justify-start whitespace-normal rounded-xl border border-border bg-card p-4 text-left font-normal"
              onClick={(event) => {
                openJob(job.id, event.currentTarget);
              }}
            >
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="font-medium">{job.title}</span>
                <span className="text-xs text-muted-foreground">
                  {statusLabels[job.status]}
                </span>
                {job.work.explanation && (
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {job.work.explanation}
                  </span>
                )}
              </span>
              <ArrowRight size={16} aria-hidden />
            </Button>
          );
        })
      )}
      <JobPagination />
      <JobDialog returnFocus={returnFocus} />
    </div>
  );
}
