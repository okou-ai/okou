//! One real provider claim waits at an owned external HTTP response boundary.

use std::sync::{Arc, Mutex};

use hyper::{Method, http::request::Parts};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_types::ids::RunId;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::{TestResult, continuation_api::TOKEN, evidence, io};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Unavailable,
    Decode,
    Disconnect,
}

impl Outcome {
    pub fn label(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Decode => "decode",
            Self::Disconnect => "disconnect",
        }
    }
}

pub struct Gate {
    run: RunId,
    runner: RunnerProcessIdentity,
    entered: watch::Sender<bool>,
    released: watch::Sender<bool>,
    receipt: Mutex<Option<Value>>,
    outcome: Outcome,
}

impl Gate {
    pub fn with_outcome(run: RunId, runner: RunnerProcessIdentity, outcome: Outcome) -> Arc<Self> {
        Arc::new(Self {
            run,
            runner,
            entered: watch::channel(false).0,
            released: watch::channel(false).0,
            receipt: Mutex::new(None),
            outcome,
        })
    }

    pub async fn respond(&self, parts: &Parts, bytes: &[u8]) -> TestResult<Outcome> {
        if bytes.len() > 16 * 1024 {
            return Err(io::Error::other("native claim body exceeded its bound").into());
        }
        let body: Value = serde_json::from_slice(bytes)?;
        let path = format!("/api/runners/jobs/{}/claim", self.run);
        if parts.method != Method::POST
            || parts.uri.path() != path
            || parts.uri.query() != Some("workflowSkills=2")
            || parts
                .headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                != Some(format!("Bearer {TOKEN}").as_str())
            || body.get("runnerIdentity") != Some(&serde_json::to_value(self.runner)?)
        {
            return Err(
                io::Error::other("native claim request changed its original authority").into(),
            );
        }
        {
            let mut receipt = self
                .receipt
                .lock()
                .map_err(|_| io::Error::other("claim receipt poisoned"))?;
            if receipt.is_some() {
                return Err(io::Error::other("native claim was submitted more than once").into());
            }
            *receipt = Some(json!({"path":path,"received_ns":evidence::clocks()?.0,"body":body}));
        }
        let mut released = self.released.subscribe();
        self.entered.send_replace(true);
        while !*released.borrow_and_update() {
            released.changed().await?;
        }
        let mut receipt = self
            .receipt
            .lock()
            .map_err(|_| io::Error::other("claim receipt poisoned"))?;
        let receipt = receipt
            .as_mut()
            .ok_or_else(|| io::Error::other("claim request disappeared"))?;
        receipt["response_released_ns"] = json!(evidence::clocks()?.0);
        match self.outcome {
            Outcome::Unavailable => receipt["status"] = json!(404),
            Outcome::Decode => {
                receipt["status"] = json!(200);
                receipt["failure_boundary"] = json!("decode");
                receipt["response_body_hex"] = json!("7b");
            }
            Outcome::Disconnect => {
                receipt["status"] = Value::Null;
                receipt["failure_boundary"] = json!("disconnect");
                receipt["response_body_hex"] = Value::Null;
            }
        }
        Ok(self.outcome)
    }

    pub async fn wait_entered(&self) -> TestResult<()> {
        let mut entered = self.entered.subscribe();
        while !*entered.borrow_and_update() {
            entered.changed().await?;
        }
        Ok(())
    }

    pub fn is_held(&self) -> bool {
        *self.entered.borrow() && !*self.released.borrow()
    }

    pub fn release(&self) {
        self.released.send_replace(true);
    }

    pub fn receipt(&self) -> TestResult<Value> {
        self.receipt
            .lock()
            .map_err(|_| io::Error::other("claim receipt poisoned"))?
            .clone()
            .ok_or_else(|| io::Error::other("actual native claim request missing").into())
    }
}

#[tokio::test]
async fn held_real_provider_failures_allow_heartbeat_and_return_unavailable() -> TestResult<()> {
    use runner_lifecycle::{
        idle_pool::{IdlePool, IdlePoolConfig},
        resource_budget::ResourceBudget,
    };
    use runner_provider::JobCandidate;
    use std::time::Duration;

    for fault in [Outcome::Unavailable, Outcome::Decode, Outcome::Disconnect] {
        let directory = tempfile::tempdir()?;
        let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 1,
        })));
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let mut probe = super::foreground_probe::Probe::new(
            &pool,
            &budget,
            directory.path(),
            "synthetic-rootfs",
        )
        .await?;
        let run = RunId::new_v4();
        let (provider, gate) = probe.hold_claim_failure(run, fault)?;
        let mut claim = Box::pin(provider.claim(JobCandidate::new(run, "vm0/default".into())));
        let mut completed = None;
        let outcome: TestResult<()> = async {
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                entered = gate.wait_entered() => entered?,
                result = claim.as_mut() => {
                    completed = Some(result);
                    return Err(io::Error::other("provider did not wait for actual response").into());
                }
            }
            super::cleanup_progress::pending(claim.as_mut(), &mut completed).await?;
            assert!(gate.is_held());
            probe.request()?;
            assert_eq!(probe.complete().await?["receipt"]["acknowledgement_status"], 204);
            assert!(gate.is_held());
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        }).await??;
        Ok(())
    }.await;
        gate.release();
        let result = match completed {
            Some(result) => result,
            None => claim.as_mut().await,
        };
        drop(claim);
        let reporting = probe.finish().await;
        outcome?;
        reporting?;
        assert!(result.is_none());
        match fault {
            Outcome::Unavailable => assert_eq!(gate.receipt()?["status"], 404),
            Outcome::Decode => assert_eq!(gate.receipt()?["status"], 200),
            Outcome::Disconnect => assert_eq!(gate.receipt()?["status"], Value::Null),
        }
    }
    Ok(())
}
