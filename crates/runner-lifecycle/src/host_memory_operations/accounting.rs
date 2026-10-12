use std::collections::HashMap;
use std::sync::Arc;

use runner_host::host_memory::HostMemoryObservation;
use sandbox::{BackingProcessIdentity, SandboxBackingProcess};

use super::{
    MemoryOperationError as Error, MemoryOperationId, MemoryOperationPlan, MemoryOperationPolicy,
    MemoryOperationSnapshot, Result,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Class {
    Ordinary,
    Cleanup,
}

#[derive(Clone)]
pub(super) struct CapturedBacking {
    pub identity: BackingProcessIdentity,
    pub process: Arc<dyn SandboxBackingProcess>,
}

impl CapturedBacking {
    pub fn capture(process: Arc<dyn SandboxBackingProcess>) -> Self {
        // Provider accessors run outside accounting, just like wait observation.
        Self {
            identity: process.identity(),
            process,
        }
    }
}

#[derive(Clone)]
pub(super) enum Purpose {
    Preparation(Option<CapturedBacking>),
    Retirement(CapturedBacking),
    HostIo,
}

#[derive(Clone)]
pub(super) struct CapturedPlan {
    pub allowance: u64,
    pub class: Class,
    pub purpose: Purpose,
}

impl CapturedPlan {
    pub fn capture(plan: MemoryOperationPlan, policy: MemoryOperationPolicy) -> Result<Self> {
        let (allowance, class, purpose) = match plan {
            MemoryOperationPlan::Fresh {
                memory_mib,
                preparation_bytes,
            } => (
                policy.bounds.growth_bytes(memory_mib, preparation_bytes)?,
                Class::Ordinary,
                Purpose::Preparation(None),
            ),
            MemoryOperationPlan::Resume {
                memory_mib,
                preparation_bytes,
                backing,
            } => (
                policy.bounds.growth_bytes(memory_mib, preparation_bytes)?,
                Class::Ordinary,
                Purpose::Preparation(Some(CapturedBacking::capture(backing))),
            ),
            MemoryOperationPlan::Retire {
                growth_bytes,
                backing,
            } => (
                growth_bytes,
                Class::Cleanup,
                Purpose::Retirement(CapturedBacking::capture(backing)),
            ),
            MemoryOperationPlan::HostIo { growth_bytes } => {
                (growth_bytes, Class::Ordinary, Purpose::HostIo)
            }
            MemoryOperationPlan::CleanupIo { growth_bytes } => {
                (growth_bytes, Class::Cleanup, Purpose::HostIo)
            }
        };
        if allowance == 0 {
            return Err(Error::UnsupportedGrowth);
        }
        let unused = match class {
            Class::Ordinary => policy.bounds.cleanup_reserve_bytes,
            Class::Cleanup => policy
                .bounds
                .cleanup_reserve_bytes
                .saturating_sub(allowance),
        };
        let required = allowance
            .checked_add(policy.bounds.operating_floor_bytes)
            .and_then(|bytes| bytes.checked_add(unused))
            .ok_or(Error::AccountingOverflow)?;
        if required > policy.bounds.host_total_bytes {
            return Err(Error::UnsupportedGrowth);
        }
        Ok(Self {
            allowance,
            class,
            purpose,
        })
    }

    pub fn same_purpose(&self, other: &Self) -> bool {
        self.class == other.class
            && matches!(
                (&self.purpose, &other.purpose),
                (Purpose::Preparation(_), Purpose::Preparation(_))
                    | (Purpose::Retirement(_), Purpose::Retirement(_))
                    | (Purpose::HostIo, Purpose::HostIo)
            )
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    Queued,
    Granted,
    Started,
    Uncertain,
}

struct Entry {
    plan: CapturedPlan,
    stage: Stage,
}

pub(super) struct Sample {
    pub revision: u64,
    pub observation: HostMemoryObservation,
}

pub(super) struct Ledger {
    entries: HashMap<MemoryOperationId, Entry>,
    revision: u64,
    unhealthy: bool,
    closed: bool,
}

impl Ledger {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            revision: 0,
            unhealthy: false,
            closed: false,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn ensure_healthy(&self) -> Result<()> {
        if self.unhealthy {
            return Err(Error::OwnershipInvariant);
        }
        Ok(())
    }

    fn advance(&mut self) -> Result<()> {
        if let Some(next) = self.revision.checked_add(1) {
            self.revision = next;
            Ok(())
        } else {
            self.unhealthy = true;
            Err(Error::AccountingOverflow)
        }
    }

    fn entry(&mut self, id: MemoryOperationId, stage: Stage) -> Result<&mut Entry> {
        self.ensure_healthy()?;
        match self.entries.get_mut(&id) {
            Some(entry) if entry.stage == stage => Ok(entry),
            _ => {
                self.unhealthy = true;
                Err(Error::OwnershipInvariant)
            }
        }
    }

    pub fn plan(&mut self, id: MemoryOperationId, stage: Stage) -> Result<CapturedPlan> {
        Ok(self.entry(id, stage)?.plan.clone())
    }

    pub fn register(
        &mut self,
        id: MemoryOperationId,
        plan: CapturedPlan,
        policy: MemoryOperationPolicy,
    ) -> Result<()> {
        self.ensure_healthy()?;
        if self.closed {
            return Err(Error::Closed);
        }
        if self.entries.len() >= policy.max_operations {
            return Err(Error::OperationLimit);
        }
        if self.entries.contains_key(&id) {
            self.unhealthy = true;
            return Err(Error::OwnershipInvariant);
        }
        self.advance()?;
        self.entries.insert(
            id,
            Entry {
                plan,
                stage: Stage::Queued,
            },
        );
        Ok(())
    }

    /// All reads finish outside this section. Recheck age at mutation, not before
    /// a potentially contended lock. Exclude only the exact proven-unused owner.
    pub fn grant(
        &mut self,
        id: MemoryOperationId,
        plan: CapturedPlan,
        expected: Stage,
        sample: Sample,
        policy: MemoryOperationPolicy,
    ) -> Result<()> {
        let current = self.entry(id, expected)?.plan.clone();
        if self.closed {
            return Err(Error::Closed);
        }
        if !current.same_purpose(&plan) {
            return Err(Error::PurposeChanged);
        }
        if sample.revision != self.revision {
            return Err(Error::AccountingChanged);
        }
        let available = sample.available(policy)?;
        let mut ordinary = 0_u64;
        let mut cleanup = 0_u64;
        let mut cleanup_inflight = 0_usize;
        for (other, entry) in &self.entries {
            if *other == id {
                continue;
            }
            if entry.stage == Stage::Queued {
                if plan.class == Class::Ordinary && entry.plan.class == Class::Cleanup {
                    return Err(Error::CleanupWaiting);
                }
                continue;
            }
            match entry.plan.class {
                Class::Ordinary => {
                    ordinary = ordinary
                        .checked_add(entry.plan.allowance)
                        .ok_or(Error::AccountingOverflow)?;
                }
                Class::Cleanup => {
                    cleanup = cleanup
                        .checked_add(entry.plan.allowance)
                        .ok_or(Error::AccountingOverflow)?;
                    cleanup_inflight = cleanup_inflight
                        .checked_add(1)
                        .ok_or(Error::AccountingOverflow)?;
                }
            }
        }
        match plan.class {
            Class::Ordinary => {
                ordinary = ordinary
                    .checked_add(plan.allowance)
                    .ok_or(Error::AccountingOverflow)?;
            }
            Class::Cleanup => {
                if cleanup_inflight >= policy.max_cleanup_inflight {
                    return Err(Error::CleanupWaveFull);
                }
                cleanup = cleanup
                    .checked_add(plan.allowance)
                    .ok_or(Error::AccountingOverflow)?;
            }
        }
        // Used reserve is counted in cleanup already. Above-reserve cleanup is
        // not capped, subtracted from the floor, or converted to released bytes.
        let unused = policy.bounds.cleanup_reserve_bytes.saturating_sub(cleanup);
        let required = policy
            .bounds
            .operating_floor_bytes
            .checked_add(ordinary)
            .and_then(|bytes| bytes.checked_add(cleanup))
            .and_then(|bytes| bytes.checked_add(unused))
            .ok_or(Error::AccountingOverflow)?;
        if available < required {
            return Err(Error::InsufficientHeadroom {
                available,
                required,
            });
        }
        self.advance()?;
        let entry = self.entry(id, expected)?;
        entry.plan = plan;
        entry.stage = Stage::Granted;
        Ok(())
    }

    pub fn start(&mut self, id: MemoryOperationId) -> Result<()> {
        self.entry(id, Stage::Granted)?;
        if self.closed {
            return Err(Error::Closed);
        }
        self.advance()?;
        self.entry(id, Stage::Granted)?.stage = Stage::Started;
        Ok(())
    }

    /// One terminal owner starts both pre-admitted phases or neither. Check all
    /// fallible conditions before advancing either row; no provider work runs here.
    pub fn start_retirement(
        &mut self,
        live: MemoryOperationId,
        tail: MemoryOperationId,
    ) -> Result<()> {
        if self.closed {
            return Err(Error::Closed);
        }
        let live_plan = self.plan(live, Stage::Granted)?;
        let tail_plan = self.plan(tail, Stage::Granted)?;
        if live == tail
            || !matches!(live_plan.purpose, Purpose::Retirement(_))
            || tail_plan.class != Class::Cleanup
            || !matches!(tail_plan.purpose, Purpose::HostIo)
        {
            return Err(Error::PurposeChanged);
        }
        self.advance()?;
        // Both exact rows were checked above and no mutation can interleave.
        self.entry(live, Stage::Granted)?.stage = Stage::Started;
        self.entry(tail, Stage::Granted)?.stage = Stage::Started;
        Ok(())
    }

    pub fn bind(&mut self, id: MemoryOperationId, backing: CapturedBacking) -> Result<()> {
        let plan = self.plan(id, Stage::Started)?;
        if !matches!(plan.purpose, Purpose::Preparation(None)) {
            return Err(Error::BackingAlreadyCaptured);
        }
        self.advance()?;
        self.entry(id, Stage::Started)?.plan.purpose = Purpose::Preparation(Some(backing));
        Ok(())
    }

    pub fn settle(
        &mut self,
        id: MemoryOperationId,
        sample: Sample,
        policy: MemoryOperationPolicy,
    ) -> Result<()> {
        self.entry(id, Stage::Started)?;
        if sample.revision != self.revision {
            return Err(Error::AccountingChanged);
        }
        sample.available(policy)?;
        self.advance()?;
        self.entries.remove(&id);
        Ok(())
    }

    pub fn abandon(&mut self, id: MemoryOperationId) {
        if self.ensure_healthy().is_err() {
            return;
        }
        let Some(entry) = self.entries.get(&id) else {
            self.unhealthy = true;
            return;
        };
        let unused = matches!(entry.stage, Stage::Queued | Stage::Granted);
        if self.advance().is_err() {
            return;
        }
        if unused {
            self.entries.remove(&id);
        } else if let Some(entry) = self.entries.get_mut(&id) {
            entry.stage = Stage::Uncertain;
        }
    }

    pub fn close(&mut self) -> Result<()> {
        // No allowance changes. Admission checks closed independently; a valid
        // already-completed phase may still settle while shutdown joins it.
        self.closed = true;
        self.ensure_healthy()
    }

    pub fn snapshot(&self, tracked_tasks: usize) -> Result<MemoryOperationSnapshot> {
        self.ensure_healthy()?;
        let mut report = MemoryOperationSnapshot {
            registered_operations: self.entries.len(),
            queued: 0,
            granted: 0,
            started: 0,
            uncertain: 0,
            ordinary_growth_bytes: 0,
            cleanup_growth_bytes: 0,
            tracked_tasks,
            closed: self.closed,
        };
        for entry in self.entries.values() {
            match entry.stage {
                Stage::Queued => report.queued += 1,
                Stage::Granted => report.granted += 1,
                Stage::Started => report.started += 1,
                Stage::Uncertain => report.uncertain += 1,
            }
            if entry.stage == Stage::Queued {
                continue;
            }
            let pending = match entry.plan.class {
                Class::Ordinary => &mut report.ordinary_growth_bytes,
                Class::Cleanup => &mut report.cleanup_growth_bytes,
            };
            *pending = pending
                .checked_add(entry.plan.allowance)
                .ok_or(Error::AccountingOverflow)?;
        }
        Ok(report)
    }
}
