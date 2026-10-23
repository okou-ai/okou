//! Actual returned Guest identity and positively joined required cleanup.

use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use async_trait::async_trait;
use runner_lifecycle::host_memory_operations::HostMemoryOperations;
use sandbox::{
    Sandbox, SandboxBackingProcess, SandboxConfig, SandboxCreateCustody, SandboxCreateObserver,
};
use sandbox_firecracker::{
    GuestPreparationCheckpoint, GuestPreparationObservation, GuestPreparationStage,
};
use serde_json::{Value, json};

use super::*;

#[derive(Default)]
struct State {
    owners: Option<(Arc<ResourceBudget>, HostMemoryOperations)>,
    created: Option<Value>,
    stages: Vec<Value>,
    backing: Option<Arc<dyn SandboxBackingProcess>>,
    cleanup: Option<Value>,
}

pub struct Probe {
    pub stage: GuestPreparationStage,
    pub stage_gate: Arc<foreground_io::Gate>,
    pub cleanup_gate: Arc<foreground_io::Gate>,
    directory: PathBuf,
    state: Mutex<State>,
}

pub fn accounting(operations: &HostMemoryOperations) -> io::Result<Value> {
    let value = operations.snapshot().map_err(io::Error::other)?;
    Ok(
        json!({"registered_operations":value.registered_operations,"started":value.started,
        "ordinary_growth_bytes":value.ordinary_growth_bytes,"cleanup_growth_bytes":value.cleanup_growth_bytes,
        "tracked_tasks":value.tracked_tasks,"uncertain":value.uncertain}),
    )
}

impl Probe {
    pub fn new(stage: GuestPreparationStage, directory: PathBuf) -> io::Result<Self> {
        Ok(Self {
            stage,
            directory,
            stage_gate: Arc::new(foreground_io::Gate::new()?),
            cleanup_gate: Arc::new(foreground_io::Gate::new()?),
            state: Mutex::new(State::default()),
        })
    }

    pub fn bind(&self, context: &transitions::Context) -> TestResult<()> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("returned Guest probe poisoned"))?
            .owners = Some((context.budget.clone(), context.operations.clone()));
        Ok(())
    }

    fn home(&self, id: &str) -> io::Result<Value> {
        let parsed = uuid::Uuid::parse_str(id).map_err(io::Error::other)?;
        if parsed.to_string() != id {
            return Err(io::Error::other("returned Guest identity changed"));
        }
        let path = sandbox_firecracker::FactoryPaths::new(self.directory.clone())
            .workspace(id)
            .join("home.ext4");
        let mut file = std::fs::File::open(&path)?;
        let bytes = file.metadata()?.len();
        let mut block = [0; 1024];
        file.seek(SeekFrom::Start(1024))?;
        file.read_exact(&mut block)?;
        if bytes != fixture::IMAGE_BYTES || block[56..58] != [0x53, 0xef] {
            return Err(io::Error::other(
                "returned actual home is not original sized ext4",
            ));
        }
        Ok(
            json!({"path":path,"bytes":bytes,"ext4_magic":"53ef","filesystem_uuid":hex::encode(&block[104..120]),
            "superblock_hex":hex::encode(block),"superblock_sha256":continuation::digest(&block)}),
        )
    }

    fn created(&self, id: &str) -> io::Result<()> {
        let home = self.home(id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("returned Guest probe poisoned"))?;
        if state.created.is_some() {
            return Err(io::Error::other(
                "optional actual Guest created more than once",
            ));
        }
        state.created =
            Some(json!({"sandbox_id":id,"returned_ns":evidence::clocks()?.0,"home":home}));
        Ok(())
    }

    pub fn snapshot(&self) -> io::Result<Value> {
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("returned Guest probe poisoned"))?;
        Ok(json!({"created":state.created,"stages":state.stages,"cleanup":state.cleanup}))
    }

    pub fn backing(&self) -> io::Result<Arc<dyn SandboxBackingProcess>> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("returned Guest probe poisoned"))?
            .backing
            .clone()
            .ok_or_else(|| io::Error::other("actual returned backing missing"))
    }

    pub fn checkpoint(self: &Arc<Self>) -> GuestPreparationCheckpoint {
        let probe = self.clone();
        Arc::new(move |observation| {
            let probe = probe.clone();
            Box::pin(async move {
                probe.observe(observation).await.map_err(|error| {
                    sandbox::SandboxError::Initialization {
                        phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
                        message: format!("actual returned Guest checkpoint: {error}"),
                    }
                })
            })
        })
    }

    async fn observe(&self, observation: GuestPreparationObservation) -> io::Result<()> {
        if observation.stage == GuestPreparationStage::Restore {
            return Ok(());
        }
        let home = self.home(&observation.sandbox_id)?;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| io::Error::other("returned Guest probe poisoned"))?;
            let created = state
                .created
                .as_ref()
                .ok_or_else(|| io::Error::other("stage preceded actual returned Guest"))?;
            if created.get("sandbox_id").and_then(Value::as_str) != Some(&observation.sandbox_id)
                || created.get("home").and_then(|v| v.get("filesystem_uuid"))
                    != home.get("filesystem_uuid")
                || state
                    .backing
                    .as_ref()
                    .is_some_and(|b| b.identity() != observation.backing.identity())
            {
                return Err(io::Error::other(
                    "actual Guest home/backing generation substituted",
                ));
            }
            state.stages.push(json!({"stage":observation.stage.label(),"completed_ns":evidence::clocks()?.0,
                "sandbox_id":observation.sandbox_id,"backing_generation":observation.backing.identity().generation(),
                "actual_success":true,"home":home}));
            state.backing = Some(observation.backing);
        }
        if observation.stage == self.stage {
            let gate = self.stage_gate.clone();
            tokio::task::spawn_blocking(move || gate.blocking_wait())
                .await
                .map_err(io::Error::other)??;
        }
        Ok(())
    }

    fn owns(&self, id: &str) -> io::Result<bool> {
        Ok(self
            .state
            .lock()
            .map_err(|_| io::Error::other("returned Guest probe poisoned"))?
            .created
            .as_ref()
            .and_then(|v| v.get("sandbox_id"))
            .and_then(Value::as_str)
            == Some(id))
    }

    fn cleanup(
        &self,
        id: &str,
        backing: &Arc<dyn SandboxBackingProcess>,
        home: Value,
    ) -> io::Result<()> {
        let workspace =
            sandbox_firecracker::FactoryPaths::new(self.directory.clone()).workspace(id);
        let absent = match std::fs::symlink_metadata(&workspace) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => return Err(error),
            Ok(_) => false,
        };
        if !absent {
            return Err(io::Error::other(
                "actual returned Guest workspace survived destruction",
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("returned Guest probe poisoned"))?;
        let (budget, operations) = state
            .owners
            .as_ref()
            .ok_or_else(|| io::Error::other("returned Guest owners missing"))?;
        let cleanup = json!({"sandbox_id":id,"backing_generation":backing.identity().generation(),
            "positive_backing_wait":true,"workspace":workspace,"workspace_absent":true,"last_home":home,
            "cleanup_ns":evidence::clocks()?.0,"allocated":budget.allocated(),"accounting":accounting(operations)?});
        state.cleanup = Some(cleanup);
        Ok(())
    }
}

pub struct Factory {
    pub inner: Box<dyn SandboxFactory>,
    pub probe: Arc<Probe>,
}

#[async_trait]
impl SandboxFactory for Factory {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }
    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }
    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        observer: &mut dyn SandboxCreateObserver,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create_with_observer(config, observer).await
    }
    async fn create_with_custody(
        &self,
        config: SandboxConfig,
        custody: SandboxCreateCustody,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        let sandbox = self.inner.create_with_custody(config, custody).await?;
        if let Err(error) = self.probe.created(sandbox.id()) {
            self.inner.destroy(sandbox).await;
            return Err(sandbox::SandboxError::Initialization {
                phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
                message: format!("observe actual returned Guest: {error}"),
            });
        }
        Ok(sandbox)
    }
    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        let owned = self.probe.owns(sandbox.id());
        if matches!(owned, Ok(false)) {
            self.inner.destroy(sandbox).await;
            return;
        }
        if let Err(error) = self.destroy_actual(sandbox).await {
            std::panic::resume_unwind(Box::new(error.to_string()));
        }
    }
    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

impl Factory {
    async fn destroy_actual(&self, sandbox: Box<dyn Sandbox>) -> TestResult<()> {
        let id = sandbox.id().to_owned();
        let backing = self.probe.backing()?;
        if sandbox
            .backing_process()
            .is_none_or(|b| b.identity() != backing.identity())
        {
            return Err(io::Error::other("required cleanup lost exact returned backing").into());
        }
        let home = self.probe.home(&id)?;
        self.inner.destroy(sandbox).await;
        if !backing.exit_confirmed().await {
            return Err(io::Error::other("returned backing wait unconfirmed").into());
        }
        self.probe.cleanup(&id, &backing, home)?;
        let gate = self.probe.cleanup_gate.clone();
        tokio::task::spawn_blocking(move || gate.blocking_wait()).await??;
        Ok(())
    }
}
