use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;

use async_trait::async_trait;
use sandbox::{Sandbox, SandboxConfig, SandboxCreateCustody};

use super::*;

struct FileProducerFactory {
    provider: MockSandboxFactory,
    reader: Mutex<Option<UnixStream>>,
    entered: Arc<Notify>,
    home: PathBuf,
}

#[async_trait]
impl SandboxFactory for FileProducerFactory {
    fn name(&self) -> &str {
        "test-file-producer"
    }
    fn config_hash(&self) -> String {
        "test-file-producer".into()
    }
    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.provider.create(config).await
    }
    async fn create_with_custody(
        &self,
        config: SandboxConfig,
        custody: SandboxCreateCustody,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        let mut reader = self.reader.lock().unwrap().take().unwrap();
        let entered = self.entered.clone();
        let path = self.home.clone();
        let work = tokio::task::spawn_blocking(move || {
            let _custody = custody;
            entered.notify_one();
            let mut gate = [0];
            reader.read_exact(&mut gate).unwrap();
            std::fs::write(path, b"actual accepted home bytes").unwrap();
        });
        work.await.unwrap();
        self.provider.create(config).await
    }
    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.provider.destroy(sandbox).await;
    }
    async fn shutdown(&mut self) {
        self.provider.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_create_keeps_original_fresh_and_full_lease_until_real_blocking_io_finishes() {
    let mut owner = Owner::new().await;
    let (reader, mut writer) = UnixStream::pair().unwrap();
    let entered = Arc::new(Notify::new());
    let home = owner.fixture.dir.path().join("created-home-bytes");
    let factory: crate::SharedFactory = Arc::new(Box::new(FileProducerFactory {
        provider: MockSandboxFactory::new(),
        reader: Mutex::new(Some(reader)),
        entered: entered.clone(),
        home: home.clone(),
    }));
    let profiles = BTreeMap::from([(
        "vm0/default".into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 2048,
            rootfs_hash: "test-rootfs".into(),
            home_disk_mb: 32,
        },
    )]);
    let factories = BTreeMap::from([("vm0/default".into(), (factory, true))]);
    owner.replenisher =
        BlankPoolReplenisher::new(&profiles, &factories, &owner.fixture.budget, 1, None);
    assert!(owner.start());
    tokio::time::timeout(WAIT, entered.notified())
        .await
        .unwrap();
    let foreground =
        tokio::time::timeout(WAIT, owner.admission.acquire(2, &CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(
        owner
            .fixture
            .operations
            .snapshot()
            .unwrap()
            .registered_operations,
        1
    );
    assert!(!home.exists());
    {
        let waiting = owner.replenisher.wait_for_optional_preparation();
        tokio::pin!(waiting);
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        writer.write_all(b"x").unwrap();
        let result = tokio::time::timeout(WAIT, waiting).await.unwrap().unwrap();
        assert!(!result.snapshot().prepared);
    }
    assert_eq!(
        tokio::fs::read(home).await.unwrap(),
        b"actual accepted home bytes"
    );
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    assert_eq!(owner.fixture.operations.snapshot().unwrap().uncertain, 1);
    drop(foreground);
    owner.dispose().await;
}
