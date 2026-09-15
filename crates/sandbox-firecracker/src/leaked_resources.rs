use std::path::PathBuf;

use nbd_cow::PooledNbdCowDevice;

use crate::network::NetnsLease;
use crate::process::ProcessExitCompletion;

/// Resources that require async cleanup when a sandbox is dropped without
/// going through `factory.destroy()` or when create is dropped mid-allocation.
///
/// Drop impls send these to a cleanup channel owned by the factory, which
/// drains them asynchronously.
pub(crate) struct LeakedResources {
    pub(crate) sandbox_id: String,
    /// None only for allocation cleanup that never launched a process.
    pub(crate) process_exit: Option<ProcessExitCompletion>,
    pub(crate) cow_device: Option<PooledNbdCowDevice>,
    pub(crate) network: Option<NetnsLease>,
    pub(crate) sock_dir: PathBuf,
    pub(crate) workspace: PathBuf,
    pub(crate) delete_workspace: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::NetnsLease;

    fn test_network() -> NetnsLease {
        NetnsLease::new_for_test("test-ns")
    }

    fn test_leaked_resource(sandbox_id: &str) -> LeakedResources {
        LeakedResources {
            sandbox_id: sandbox_id.into(),
            process_exit: None,
            cow_device: None,
            network: None,
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
            delete_workspace: true,
        }
    }

    #[tokio::test]
    async fn leaked_resources_channel_receives_on_send() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        tx.send(LeakedResources {
            sandbox_id: "test-sandbox".into(),
            process_exit: None,
            cow_device: None,
            network: Some(test_network()),
            sock_dir: PathBuf::from("/tmp/nonexistent-sock"),
            workspace: PathBuf::from("/tmp/nonexistent-ws"),
            delete_workspace: true,
        })
        .unwrap();

        let mut leaked = rx.recv().await.unwrap();
        assert_eq!(leaked.sandbox_id, "test-sandbox");
        assert!(leaked.cow_device.is_none());
        let network = leaked.network.take().unwrap();
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();
    }

    #[test]
    fn leaked_resources_send_does_not_panic_on_closed_channel() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        drop(rx);

        let resources = LeakedResources {
            sandbox_id: "test".into(),
            process_exit: None,
            cow_device: None,
            network: Some(test_network()),
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
            delete_workspace: true,
        };

        // Should not panic — just returns Err with the original payload.
        let mut resources = tx.send(resources).unwrap_err().0;
        let network = resources.network.take().unwrap();
        assert_eq!(network.name(), "test-ns");
        let _ = network.into_info_for_test();
    }

    #[test]
    fn leaked_resources_unbounded_send_accepts_burst() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();

        for index in 0..64 {
            tx.send(test_leaked_resource(&format!("leaked-{index}")))
                .unwrap();
        }

        for index in 0..64 {
            assert_eq!(rx.try_recv().unwrap().sandbox_id, format!("leaked-{index}"));
        }
    }
}
