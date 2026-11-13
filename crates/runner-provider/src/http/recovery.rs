//! Bounded request recovery. Replay permission is a protocol guarantee, not a body property.

use tokio::sync::OwnedSemaphorePermit;
use tokio_util::sync::CancellationToken;

use super::*;

pub(super) const MAX_CONCURRENT_RECOVERIES: usize = 8;

#[derive(Clone, Copy)]
pub(crate) enum RetryConditions {
    Reset,
    ResetOrStatus(reqwest::StatusCode),
    Transient,
}

#[derive(Clone)]
pub(crate) struct RecoveryPolicy {
    attempts: u8,
    delay: Duration,
    conditions: RetryConditions,
    gate: Option<(Instant, CancellationToken)>,
    full_attempt_timeouts: bool,
    jitter: bool,
}

impl RecoveryPolicy {
    pub(crate) fn never() -> Self {
        Self::bounded(1, Duration::ZERO, RetryConditions::Reset)
    }

    pub(crate) fn idempotent() -> Self {
        Self {
            jitter: true,
            ..Self::bounded(2, Duration::from_millis(100), RetryConditions::Reset)
        }
    }

    pub(super) fn for_method(method: &reqwest::Method) -> Self {
        if matches!(
            *method,
            reqwest::Method::GET | reqwest::Method::HEAD | reqwest::Method::OPTIONS
        ) {
            Self::idempotent()
        } else {
            Self::never()
        }
    }

    pub(crate) fn bounded(attempts: u8, delay: Duration, conditions: RetryConditions) -> Self {
        Self {
            attempts: attempts.max(1),
            delay,
            conditions,
            gate: None,
            full_attempt_timeouts: false,
            jitter: false,
        }
    }

    pub(crate) fn until(mut self, deadline: Instant, cancel: CancellationToken) -> Self {
        self.gate = Some((deadline, cancel));
        self
    }

    /// Retain an existing multi-attempt operation's per-attempt timeout allowance.
    pub(crate) fn full_attempt_timeouts(mut self) -> Self {
        self.full_attempt_timeouts = true;
        self
    }

    fn retryable(&self, result: &Result<Response, reqwest::Error>) -> bool {
        match result {
            Err(error) => {
                matches!(self.conditions, RetryConditions::Transient)
                    || api_transport_cause(error) == ApiTransportCause::ConnectionReset
            }
            Ok(response) => match self.conditions {
                RetryConditions::Reset => false,
                RetryConditions::ResetOrStatus(status) => response.status() == status,
                RetryConditions::Transient => is_transient_http_status(response.status()),
            },
        }
    }

    fn delay_before_retry(&self, deadline: tokio::time::Instant) -> Option<Duration> {
        let delay = self.delay
            + if self.jitter {
                Duration::from_millis((Uuid::new_v4().as_u128() % 51) as u64)
            } else {
                Duration::ZERO
            };
        if deadline.saturating_duration_since(tokio::time::Instant::now()) <= delay {
            return None;
        }
        if let Some((until, cancel)) = &self.gate
            && (cancel.is_cancelled() || until.saturating_duration_since(Instant::now()) <= delay)
        {
            return None;
        }
        Some(delay)
    }

    async fn wait(&self, delay: Duration, deadline: tokio::time::Instant) -> bool {
        if let Some((until, cancel)) = &self.gate {
            tokio::select! {
                biased;
                () = cancel.cancelled() => return false,
                () = tokio::time::sleep(delay) => {}
            }
            !cancel.is_cancelled()
                && *until > Instant::now()
                && tokio::time::Instant::now() < deadline
        } else {
            tokio::time::sleep(delay).await;
            tokio::time::Instant::now() < deadline
        }
    }
}

pub(crate) struct AttemptOutcome {
    pub result: ProviderResult<Response>,
    pub context: ApiRequestContext,
    pub started: Instant,
    pub finished: Instant,
}

pub(crate) type PrepareReplay<'a> = dyn FnMut(&mut Request) -> ProviderResult<()> + Send + 'a;

pub(super) async fn send(
    prepared: PreparedApiRequest,
    claim: Option<(runner_types::ids::RunId, Instant)>,
    mut observed_context: Option<&mut ApiRequestContext>,
    mut prepare_replay: Option<&mut PrepareReplay<'_>>,
) -> AttemptOutcome {
    let PreparedApiRequest {
        client,
        diagnostics,
        client_headers,
        retry_slots,
        policy,
        mut request,
        mut context,
    } = prepared;
    let original_request_id = context.client_request_id.clone();
    let attempt_timeout = request.timeout().copied().unwrap_or(DEFAULT_TIMEOUT);
    let total_timeout = if policy.full_attempt_timeouts {
        attempt_timeout
            .saturating_mul(u32::from(policy.attempts))
            .saturating_add(
                policy
                    .delay
                    .saturating_mul(u32::from(policy.attempts.saturating_sub(1))),
            )
    } else {
        attempt_timeout
    };
    let deadline = tokio::time::Instant::now() + total_timeout;
    let mut retry_permit: Option<OwnedSemaphorePermit> = None;
    let mut attempt = 1;
    loop {
        if let Some(observed) = observed_context.as_deref_mut() {
            *observed = context.clone();
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        *request.timeout_mut() = Some(attempt_timeout.min(remaining));
        let replay = (attempt < policy.attempts)
            .then(|| request.try_clone())
            .flatten();
        let started = if attempt == 1 {
            claim.map_or_else(Instant::now, |(_, started)| started)
        } else {
            Instant::now()
        };
        let active_client = client.current();
        let execution =
            diagnostics.scope(&context.client_request_id, active_client.execute(request));
        let (result, finished) = if let Some((run_id, _)) = claim {
            transport_timing::observe_claim_attempt(context.clone(), run_id, started, execution)
                .await
        } else {
            let result = execution.await;
            (result, Instant::now())
        };
        match &result {
            Ok(response) => diagnostics.response(response, &context.client_request_id, started),
            Err(error) => diagnostics.failure(&context, started, error),
        }
        if result
            .as_ref()
            .is_err_and(|error| api_transport_cause(error) == ApiTransportCause::ConnectionReset)
            && client.retire(&active_client).is_err()
        {
            // Keep the original request failure and existing retry budget. A
            // pool rebuild must never cancel healthy requests or leak settings.
            info!(
                client_request_id = %context.client_request_id,
                endpoint = context.endpoint_label,
                "API connection pool replacement failed"
            );
        }
        let permit_available = if replay.is_some() && policy.retryable(&result) {
            if retry_permit.is_none() {
                retry_permit = retry_slots.clone().try_acquire_owned().ok();
            }
            retry_permit.is_some()
        } else {
            false
        };
        let delay = permit_available
            .then(|| policy.delay_before_retry(deadline))
            .flatten();
        let (status, failure_kind, failure_cause) = match &result {
            Ok(response) => (response.status().as_u16().to_string(), "http_status", ""),
            Err(error) => (
                String::new(),
                api_failure_kind(error).as_str(),
                api_transport_cause(error).as_str(),
            ),
        };
        if delay.is_some() {
            info!(
                original_client_request_id = %original_request_id,
                client_request_id = %context.client_request_id,
                endpoint = context.endpoint_label,
                attempt,
                max_attempts = policy.attempts,
                status,
                failure_kind,
                failure_cause,
                will_retry = true,
                "API request recovery waiting"
            );
        }
        if let Some(delay) = delay
            && policy.wait(delay, deadline).await
            && let Some(mut next) = replay
        {
            if let Some(prepare) = prepare_replay.as_deref_mut()
                && let Err(error) = prepare(&mut next)
            {
                return AttemptOutcome {
                    result: Err(error),
                    context,
                    started,
                    finished,
                };
            }
            let applied = match client_headers.apply(next.headers_mut()) {
                Ok(applied) => applied,
                Err(error) => {
                    return AttemptOutcome {
                        result: Err(error),
                        context,
                        started,
                        finished,
                    };
                }
            };
            let next_context = request_context(context.endpoint_label, &next, applied);
            info!(
                original_client_request_id = %original_request_id,
                previous_client_request_id = %context.client_request_id,
                client_request_id = %next_context.client_request_id,
                endpoint = context.endpoint_label,
                attempt = attempt + 1,
                max_attempts = policy.attempts,
                "API request recovery attempt"
            );
            drop(result);
            request = next;
            context = next_context;
            attempt += 1;
            continue;
        }
        if attempt > 1 || (policy.attempts > 1 && policy.retryable(&result)) {
            info!(
                original_client_request_id = %original_request_id,
                client_request_id = %context.client_request_id,
                endpoint = context.endpoint_label,
                attempt,
                max_attempts = policy.attempts,
                status,
                failure_kind,
                failure_cause,
                will_retry = false,
                outcome = if result.as_ref().is_ok_and(|response| response.status().is_success()) { "recovered" } else { "stopped" },
                "API request recovery completed"
            );
        }
        return AttemptOutcome {
            result: result.map_err(|error| api_transport_error(context.clone(), error)),
            context,
            started,
            finished,
        };
    }
}

#[cfg(test)]
mod tests;
