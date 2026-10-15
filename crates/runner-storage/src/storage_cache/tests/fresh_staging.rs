use super::*;

#[tokio::test]
async fn fresh_batch_retains_all_capacity_until_success_or_failure() {
    let bodies = [
        tarball_with_contents(b"first fresh archive\n"),
        tarball_with_contents(b"second fresh archive\n"),
    ];
    for fail_write in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = MockServer::start_async().await;
        let sandbox = Arc::new(MockSandbox::new("fresh-batch"));
        let gate = MockLifecycleGate::new();
        sandbox.set_write_file_lifecycle_gate(gate.clone());
        if fail_write {
            sandbox.push_write_file_result(Err(sandbox_write_file_error("fresh batch failed")));
        }
        let mut gets = Vec::new();
        let mut entries = Vec::new();
        for (index, body) in bodies.iter().enumerate() {
            let path = format!("/fresh-{index}.tar.gz");
            gets.push(
                server
                    .mock_async(|when, then| {
                        when.method(GET).path(&path).header_missing("range");
                        then.status(200).body(body.clone());
                    })
                    .await,
            );
            entries.push(storage_entry_with_archive_size(
                format!("/mnt/fresh-{index}"),
                server.url(&path),
                &format!("fresh-{index}"),
                "v1",
                Some(body.len() as u64),
            ));
        }
        let mut plan = plan_from_entries(entries, Vec::new(), None);
        let mut telemetry = new_telemetry();
        let admission = FreshArchiveDeliveryAdmission::new();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &CancellationToken::new(),
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let task = tokio::spawn({
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox);
            async move {
                let result = populate_cache_with_fresh_delivery(
                    &mut plan,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                    Some(&mut delivery),
                    None,
                )
                .await;
                (result, plan, telemetry)
            }
        });

        gate.wait_entered(1, Duration::from_secs(5))
            .await
            .expect("both fresh archives should reach the guest batch");
        assert!(!task.is_finished());
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT - bodies.len()
        );
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), bodies.len());
        for (index, body) in bodies.iter().enumerate() {
            let name = format!("fresh-{index}");
            let path = guest_archive_path(&name, "v1");
            let staged = batches[0]
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap();
            assert_eq!(&staged.content, body);
            assert_eq!(
                fs::read(home.storage_cache_dir(&name, "v1").join("archive.tar.gz"))
                    .await
                    .unwrap(),
                *body
            );
            gets[index].assert_calls_async(1).await;
        }

        gate.release_one();
        let (result, plan, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("the completed guest write should settle fresh staging")
            .unwrap();
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, !fail_write);
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_STAGED,
            if fail_write { 0 } else { bodies.len() },
        );
        if fail_write {
            let error = result
                .err()
                .expect("guest batch failure must fail preparation");
            assert!(error.to_string().contains("fresh batch failed"));
            assert_op_error(
                &ops,
                STORAGE_CACHE_STAGE_BATCH_WRITE,
                STORAGE_CACHE_STAGE_FAILED,
            );
            assert_no_op(&ops, "storage_cache_hit");
        } else {
            assert!(result.unwrap().is_none());
            assert_op_count(&ops, "storage_cache_hit", bodies.len());
        }
        for index in 0..bodies.len() {
            let expected = if fail_write {
                server.url(format!("/fresh-{index}.tar.gz"))
            } else {
                format!(
                    "file://{}",
                    guest_archive_path(&format!("fresh-{index}"), "v1")
                )
            };
            assert_eq!(storage_archive_url(&plan, index), Some(expected.as_str()));
        }
    }
}

#[tokio::test]
async fn fresh_batches_split_at_the_byte_limit_and_stop_on_later_failure() {
    let body = tarball_with_compression(
        &vec![b'x'; CACHE_MAX_SIZE as usize - 4096],
        flate2::Compression::none(),
    );
    assert!(body.len() <= CACHE_MAX_SIZE as usize);
    assert!(body.len() * 2 > GUEST_STAGE_BATCH_MAX_BYTES);
    for fail_second in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path_includes("/large-")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let mut plan = plan_from_entries(
            (0..2)
                .map(|index| {
                    storage_entry_with_archive_size(
                        format!("/mnt/large-{index}"),
                        server.url(format!("/large-{index}.tar.gz")),
                        &format!("large-{index}"),
                        "v1",
                        Some(body.len() as u64),
                    )
                })
                .collect(),
            Vec::new(),
            None,
        );
        let sandbox = Arc::new(MockSandbox::new("fresh-byte-limit"));
        let gate = MockLifecycleGate::new();
        sandbox.set_write_file_lifecycle_gate(gate.clone());
        if fail_second {
            sandbox.push_write_file_result(Ok(()));
            sandbox
                .push_write_file_result(Err(sandbox_write_file_error("later fresh batch failed")));
        }
        let admission = FreshArchiveDeliveryAdmission::new();
        let mut telemetry = new_telemetry();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &CancellationToken::new(),
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let task = tokio::spawn({
            let sandbox = Arc::clone(&sandbox);
            let home = home.clone();
            async move {
                let result = populate_cache_with_fresh_delivery(
                    &mut plan,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                    Some(&mut delivery),
                    None,
                )
                .await;
                (result, plan, telemetry)
            }
        });

        for entered in 1..=2 {
            gate.wait_entered(entered as u64, Duration::from_secs(5))
                .await
                .expect("each large archive should reach its own guest batch");
            assert!(!task.is_finished());
            assert_eq!(
                admission.permits.available_permits(),
                FRESH_DELIVERY_RUNNER_LIMIT - (3 - entered)
            );
            let batches = sandbox.write_files_calls();
            assert_eq!(batches.len(), entered);
            assert!(batches.iter().all(|batch| batch.files.len() == 1));
            gate.release_one();
        }
        let (result, plan, telemetry) = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("the last batch should settle preparation")
            .unwrap();
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        get.assert_calls_async(2).await;
        let batches = sandbox.write_files_calls();
        assert_ne!(batches[0].files[0].path, batches[1].files[0].path);
        for index in 0..2 {
            let name = format!("large-{index}");
            let path = guest_archive_path(&name, "v1");
            let staged = batches
                .iter()
                .flat_map(|batch| &batch.files)
                .find(|file| file.path == path)
                .unwrap();
            assert_eq!(staged.content, body);
            assert_eq!(
                fs::read(home.storage_cache_dir(&name, "v1").join("archive.tar.gz"))
                    .await
                    .unwrap(),
                body
            );
            let expected = if fail_second {
                server.url(format!("/large-{index}.tar.gz"))
            } else {
                format!("file://{path}")
            };
            assert_eq!(storage_archive_url(&plan, index), Some(expected.as_str()));
        }
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, 2);
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_STAGED,
            if fail_second { 1 } else { 2 },
        );
        if fail_second {
            let error = result
                .err()
                .expect("the second batch failure must stop preparation");
            assert!(error.to_string().contains("later fresh batch failed"));
            assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
            assert_no_op(&ops, "storage_cache_hit");
        } else {
            assert!(result.unwrap().is_none());
            assert_op_count(&ops, "storage_cache_hit", 2);
        }
    }
}
