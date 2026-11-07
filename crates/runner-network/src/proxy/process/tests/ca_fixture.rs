use cli_test_support::mock_build::test_runner_build_session_id;
use runner_host::host_file::{self, DirMode};
use runner_host::paths::HomePaths;
use runner_host::state_file::{self, OwnerCheck};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize)]
struct CaFixture {
    cert: String,
    key: String,
    combined: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedCa {
    session: String,
    executable: PathBuf,
    identity: CaFixture,
}

pub(super) async fn prepare_test_ca(home: &HomePaths) {
    static CA: tokio::sync::OnceCell<CaFixture> = tokio::sync::OnceCell::const_new();
    let identity = CA
        .get_or_init(|| async { tokio::task::spawn_blocking(load_ca).await.unwrap() })
        .await;

    // Copy the complete generated fixture, not another validation pass. Every
    // case keeps independent files and a lock; actual proxy startup still
    // validates and reconciles its identity through prepare_for_proxy.
    let lock = runner_host::lock::acquire(home.ca_lock()).await.unwrap();
    let directory = home.ca_dir();
    tokio::task::spawn_blocking(move || {
        let _lock = lock;
        host_file::ensure_dir(&directory, DirMode::Private, "test CA directory").unwrap();
        for (name, content) in [
            (crate::ca::CA_CERT, &identity.cert),
            ("mitmproxy-ca-key.pem", &identity.key),
            ("mitmproxy-ca.pem", &identity.combined),
        ] {
            state_file::write_private_atomic_blocking(&directory.join(name), content.as_bytes())
                .unwrap();
        }
        std::fs::set_permissions(
            directory.join(crate::ca::CA_CERT),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    })
    .await
    .unwrap();
}

fn load_ca() -> CaFixture {
    let runtime = tokio::runtime::Handle::current();
    let Some(session) = test_runner_build_session_id() else {
        return runtime.block_on(generate_ca());
    };
    // nextest isolates cases in separate processes. Reuse only within its
    // verified parent session and binary. Build mounts may have a foreign
    // owner inside containers; keep the private slot in the temporary root.
    let executable = std::env::current_exe().unwrap();
    let directory = std::env::temp_dir().join(format!(
        "okou-runner-network-test-ca-{}",
        nix::unistd::geteuid()
    ));
    host_file::ensure_dir(&directory, DirMode::Private, "test CA cache").unwrap();
    let lock = runner_host::lock::open_lock_file(&directory.join("identity.lock")).unwrap();
    lock.lock().unwrap();
    // This blocking owner retains the lock until generation and publication
    // physically finish, even if its async observer stops waiting.
    let path = directory.join("identity-v2.json");
    if let Some(text) = runtime
        .block_on(state_file::read_to_string(
            &path,
            64 * 1024,
            OwnerCheck::CurrentEuidNoUntrustedWrites,
        ))
        .unwrap()
    {
        let cached: CachedCa = serde_json::from_str(&text).unwrap();
        if cached.session == session && cached.executable == executable {
            return cached.identity;
        }
    }
    let cached = CachedCa {
        session,
        executable,
        identity: runtime.block_on(generate_ca()),
    };
    state_file::write_private_atomic_blocking(&path, &serde_json::to_vec(&cached).unwrap())
        .unwrap();
    cached.identity
}

async fn generate_ca() -> CaFixture {
    // Lifecycle cases retain production-strength inputs. Genuine generation
    // and recovery coverage stays independent in ca::tests.
    let seed = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(seed.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    CaFixture {
        cert: std::fs::read_to_string(home.ca_dir().join(crate::ca::CA_CERT)).unwrap(),
        key: std::fs::read_to_string(home.ca_dir().join("mitmproxy-ca-key.pem")).unwrap(),
        combined: std::fs::read_to_string(home.ca_dir().join("mitmproxy-ca.pem")).unwrap(),
    }
}
