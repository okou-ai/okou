use cli_test_support::mock_build::test_runner_build_session_id;
use runner_host::host_file::{self, DirMode};
use runner_host::paths::HomePaths;
use runner_host::state_file::{self, OwnerCheck};

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedCa {
    session: String,
    combined: String,
}

pub(super) async fn prepare_test_ca(home: &HomePaths) {
    static COMBINED_CA: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    let combined = COMBINED_CA
        .get_or_init(|| async { tokio::task::spawn_blocking(load_combined_ca).await.unwrap() })
        .await;

    // Share bytes only: every case keeps its own files, lock and reconciliation.
    host_file::ensure_dir(&home.ca_dir(), DirMode::Private, "test CA directory").unwrap();
    state_file::write_private_atomic(&home.ca_dir().join("mitmproxy-ca.pem"), combined.as_bytes())
        .await
        .unwrap();
    crate::ca::ensure(home).await.unwrap();
}

fn load_combined_ca() -> String {
    let runtime = tokio::runtime::Handle::current();
    let Some(session) = test_runner_build_session_id() else {
        return runtime.block_on(generate_combined_ca());
    };
    // nextest isolates cases in separate processes. Reuse only within its
    // verified parent session, with one bounded slot beside the test binary.
    let executable = std::env::current_exe().unwrap();
    let profile = executable.parent().unwrap().parent().unwrap();
    let directory = profile.join(".runner-network-test-ca");
    host_file::ensure_dir(&directory, DirMode::Private, "test CA cache").unwrap();
    let lock = runner_host::lock::open_lock_file(&directory.join("identity.lock")).unwrap();
    lock.lock().unwrap();
    // This blocking owner retains the lock until generation and publication
    // physically finish, even if its async observer stops waiting.
    let path = directory.join("identity-v1.json");
    if let Some(text) = runtime
        .block_on(state_file::read_to_string(
            &path,
            64 * 1024,
            OwnerCheck::CurrentEuidNoUntrustedWrites,
        ))
        .unwrap()
    {
        let cached: CachedCa = serde_json::from_str(&text).unwrap();
        if cached.session == session {
            return cached.combined;
        }
    }
    let cached = CachedCa {
        session,
        combined: runtime.block_on(generate_combined_ca()),
    };
    state_file::write_private_atomic_blocking(&path, &serde_json::to_vec(&cached).unwrap())
        .unwrap();
    cached.combined
}

async fn generate_combined_ca() -> String {
    // Lifecycle cases retain production-strength inputs. Genuine generation
    // and recovery coverage stays independent in ca::tests.
    let seed = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(seed.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    std::fs::read_to_string(home.ca_dir().join("mitmproxy-ca.pem")).unwrap()
}
