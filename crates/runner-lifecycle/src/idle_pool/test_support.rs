use std::sync::Arc;

use sandbox::{DeviceRateLimits, Sandbox, SandboxFactory, SandboxId};
use sandbox_mock::{MockSandbox, MockSandboxFactory};

use crate::guest_timezone::GuestTimezoneIntent;
use crate::resource_budget::BudgetLease;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::WorkspaceImagePromotionContext;
use runner_types::ids::RunId;

use super::ParkedIdleCandidate;
use super::entry::{IdleSandboxMetadata, IdleSandboxResources};

const DEFAULT_PROFILE_NAME: &str = "vm0/default";
const DEFAULT_SOURCE_IP: &str = "10.0.0.1";
const DEFAULT_SANDBOX_NAME: &str = "idle-test";

pub struct ParkedIdleCandidateBuilder {
    sandbox: Box<dyn Sandbox>,
    factory: Arc<Box<dyn SandboxFactory>>,
    reuse_key: String,
    sandbox_id: SandboxId,
    profile_name: String,
    device_rate_limits: Option<DeviceRateLimits>,
    budget_lease: BudgetLease,
    source_ip: String,
    storage_fingerprints: StorageFingerprints,
    restored_session_identity: Option<RestoredSessionIdentity>,
    history_generation_run_id: Option<RunId>,
    guest_timezone_intent: GuestTimezoneIntent,
    last_completed_at: Option<String>,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

impl ParkedIdleCandidateBuilder {
    pub fn new(
        reuse_key: impl Into<String>,
        budget_lease: BudgetLease,
    ) -> ParkedIdleCandidateBuilder {
        Self {
            sandbox: Box::new(MockSandbox::new(DEFAULT_SANDBOX_NAME)),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            reuse_key: reuse_key.into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: DEFAULT_PROFILE_NAME.into(),
            device_rate_limits: None,
            budget_lease,
            source_ip: DEFAULT_SOURCE_IP.into(),
            storage_fingerprints: StorageFingerprints::default(),
            restored_session_identity: None,
            history_generation_run_id: None,
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            last_completed_at: None,
            workspace_promotion: None,
        }
    }

    pub fn with_sandbox(mut self, sandbox: Box<dyn Sandbox>) -> Self {
        self.sandbox = sandbox;
        self
    }

    pub fn with_mock_sandbox_name(mut self, name: &str) -> Self {
        self.sandbox = Box::new(MockSandbox::new(name));
        self
    }

    pub fn with_factory(mut self, factory: Arc<Box<dyn SandboxFactory>>) -> Self {
        self.factory = factory;
        self
    }

    pub fn with_sandbox_id(mut self, sandbox_id: SandboxId) -> Self {
        self.sandbox_id = sandbox_id;
        self
    }

    pub fn with_profile_name(mut self, profile_name: impl Into<String>) -> Self {
        self.profile_name = profile_name.into();
        self
    }

    pub fn with_device_rate_limits(mut self, device_rate_limits: DeviceRateLimits) -> Self {
        self.device_rate_limits = Some(device_rate_limits);
        self
    }

    pub fn with_source_ip(mut self, source_ip: impl Into<String>) -> Self {
        self.source_ip = source_ip.into();
        self
    }

    pub fn with_last_completed_at(mut self, last_completed_at: impl Into<String>) -> Self {
        self.last_completed_at = Some(last_completed_at.into());
        self
    }

    pub fn with_history_generation_run_id(mut self, history_generation_run_id: RunId) -> Self {
        self.history_generation_run_id = Some(history_generation_run_id);
        self
    }

    pub fn with_guest_timezone_intent(
        mut self,
        guest_timezone_intent: GuestTimezoneIntent,
    ) -> Self {
        self.guest_timezone_intent = guest_timezone_intent;
        self
    }

    pub fn with_workspace_promotion(
        mut self,
        workspace_promotion: WorkspaceImagePromotionContext,
    ) -> Self {
        self.workspace_promotion = Some(workspace_promotion);
        self
    }

    pub fn build(self) -> ParkedIdleCandidate {
        let Self {
            sandbox,
            factory,
            reuse_key,
            sandbox_id,
            profile_name,
            device_rate_limits,
            budget_lease,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            guest_timezone_intent,
            last_completed_at,
            workspace_promotion,
        } = self;
        let metadata = IdleSandboxMetadata {
            identity: super::entry::IdleSandboxIdentity::Exact(reuse_key),
            sandbox_id,
            profile_name,
            device_rate_limits,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            history_generation_run_id,
            guest_timezone_intent,
            last_completed_at,
        };
        ParkedIdleCandidate {
            resources: IdleSandboxResources {
                sandbox,
                factory,
                workspace_promotion,
            },
            metadata,
            budget_lease,
        }
    }
}
