//! The actual system resolver and its resulting owned OS socket; no provider IO.

use runner_types::ids::RunId;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::super::fixture::bounded;
use crate::{
    tailscale::tests::fixture::Cache,
    tailscale::{Failure, Key, Work, resolver::Resolver},
};

#[tokio::test]
async fn an_unowned_system_resolver_cannot_start_network_work() {
    assert_eq!(
        Resolver::new().resolve("localhost", 443).await,
        Err(Failure::DomainFailed)
    );
}

#[tokio::test]
async fn a_system_resolved_connection_remains_in_the_run_until_actual_socket_closure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (mut io, _) = listener.accept().await.unwrap();
        let mut message = [0; 20];
        bounded(io.read_exact(&mut message)).await.unwrap();
        assert_eq!(&message, b"owned-system-resolve");
        let mut byte = [0];
        assert_eq!(bounded(io.read(&mut byte)).await.unwrap(), 0);
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let trace = crate::tailscale::evidence::Trace::new(true);
    let observed = trace.clone();
    let work: Work = Box::new(move |control| {
        Box::pin(observed.scope(async move {
            let mut io = Resolver::new().connect("localhost", port).await?;
            io.write_all(b"owned-system-resolve")
                .await
                .map_err(|_| Failure::DomainFailed)?;
            control.ready();
            control.cancelled().cancelled().await;
            Ok(())
        }))
    });
    let node = access
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    let snapshot = trace.snapshot().unwrap();
    assert_eq!(
        snapshot.endpoints[0].address,
        std::net::SocketAddr::from(([127, 0, 0, 1], port))
    );
    for stage in [
        crate::tailscale::evidence::Stage::ControlDns,
        crate::tailscale::evidence::Stage::ControlTcp,
    ] {
        assert!(
            snapshot.steps.iter().any(|step| step.stage == stage
                && step.status == crate::tailscale::evidence::Status::Passed)
        );
    }
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(peer).await.unwrap();
}

async fn dns_fixture(action: &str) -> serde_json::Value {
    let address = std::env::var("OKOU_NATIVE_DNS_CONTROL")
        .expect("isolated DNS qualification harness required");
    let address: std::net::SocketAddr = address.parse().unwrap();
    assert_eq!(
        address.ip(),
        "127.0.0.2".parse::<std::net::IpAddr>().unwrap()
    );
    let mut io = bounded(tokio::net::TcpStream::connect(address))
        .await
        .unwrap();
    io.write_all(format!("{action}\n").as_bytes())
        .await
        .unwrap();
    let mut bytes = Vec::new();
    bounded(io.take(4096).read_to_end(&mut bytes))
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
#[ignore = "requires an isolated resolv.conf and the owned loopback DNS fixture"]
async fn cancelled_system_dns_keeps_all_four_nodes_until_libc_and_runtime_physically_finish() {
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let mut nodes = Vec::new();
    for i in 0..4 {
        let work: Work = Box::new(move |_control| {
            Box::pin(async move {
                Resolver::new()
                    .resolve(&format!("n{i}.native-dns.invalid"), 443)
                    .await?;
                Ok(())
            })
        });
        nodes.push(
            access
                .native_node(
                    Key {
                        configuration: uuid::Uuid::new_v4(),
                        generation: 1,
                    },
                    work,
                )
                .unwrap(),
        );
    }
    bounded(async {
        loop {
            if dns_fixture("status").await["names"]
                .as_array()
                .unwrap()
                .len()
                == 4
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    run.close();
    for node in &nodes {
        assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
    }
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(8), run.shutdown_native())
            .await
            .unwrap(),
        Err(Failure::CleanupTimedOut)
    );
    let next = cache.register(RunId::new_v4());
    let fresh = next.lookup(uuid::Uuid::new_v4()).unwrap();
    let inert: Work = Box::new(|_| Box::pin(async { Ok(()) }));
    assert!(matches!(
        fresh.native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1
            },
            inert
        ),
        Err(crate::ssh::FailureReason::ResourceExhausted)
    ));
    assert!(dns_fixture("release").await["released"].as_u64().unwrap() >= 4);
    for node in &nodes {
        bounded(node.physical()).await.unwrap();
    }
    assert_eq!(run.shutdown_native().await, Err(Failure::CleanupTimedOut));
    // Actual TCP can start again only after all cancelled libc workers and
    // their native runtimes have completed their physical joins.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let peer = tokio::spawn(async move {
        let (mut io, _) = listener.accept().await.unwrap();
        let mut message = [0; 17];
        bounded(io.read_exact(&mut message)).await.unwrap();
        assert_eq!(&message, b"DNS-retired-once!");
        let mut byte = [0];
        assert_eq!(bounded(io.read(&mut byte)).await.unwrap(), 0);
    });
    let work: Work = Box::new(move |control| {
        Box::pin(async move {
            let mut io = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            io.write_all(b"DNS-retired-once!")
                .await
                .map_err(|_| Failure::DomainFailed)?;
            control.ready();
            control.cancelled().cancelled().await;
            Ok(())
        })
    });
    let node = fresh
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    next.close();
    bounded(node.physical()).await.unwrap();
    bounded(next.shutdown_native()).await.unwrap();
    bounded(peer).await.unwrap();
}
