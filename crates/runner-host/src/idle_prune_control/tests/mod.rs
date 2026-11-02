use super::*;

#[tokio::test]
async fn prune_idle_control_round_trip_is_generation_and_peer_fenced() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let listener = PruneIdleListener::bind(&home, dir.path(), identity).unwrap();
    let path = listener.path.clone();
    let replaced = RunnerProcessIdentity::new(identity.runner_id(), 2).unwrap();
    assert!(
        request(&home, dir.path(), replaced, std::process::id())
            .await
            .is_err()
    );
    assert!(
        request(&home, dir.path(), identity, u32::MAX)
            .await
            .is_err()
    );
    // Consume the connection rejected by the client peer check.
    drop(listener.accept().await.unwrap());
    let server = tokio::spawn(async move {
        let mut stream = listener.accept().await.unwrap();
        read_request(&mut stream, identity).await.unwrap();
        write_response(
            &mut stream,
            &Ok(PruneIdleReport {
                selected: 3,
                completed: 3,
                uncertain: 0,
            }),
        )
        .await
        .unwrap();
    });
    let report = request(&home, dir.path(), identity, std::process::id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.completed, 3);
    server.await.unwrap();
    assert!(!path.exists());
}

#[tokio::test]
async fn prune_idle_control_rejects_wrong_generation_and_oversized_requests() {
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
    let wrong = RunnerProcessIdentity::new(identity.runner_id(), 2).unwrap();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    write_frame(&mut client, &wrong).await.unwrap();
    assert_eq!(
        read_request(&mut server, identity)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    client.write_u32((FRAME_LIMIT + 1) as u32).await.unwrap();
    assert_eq!(
        read_request(&mut server, identity)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}
