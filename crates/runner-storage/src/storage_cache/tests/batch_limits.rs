use super::*;

const BYTE_LIMIT: usize = 15 * 1024 * 1024;

fn byte_boundary_archives(combined_bytes: usize) -> Vec<Vec<u8>> {
    [BYTE_LIMIT / 2, combined_bytes - BYTE_LIMIT / 2]
        .into_iter()
        .enumerate()
        .map(|(index, size)| {
            let mut body = tarball_with_contents(format!("archive {index}\n").as_bytes());
            // Pad the gzip stream so the opaque archive transfer hits the exact
            // byte boundary without relying on compression ratios.
            body.resize(size, 0);
            body
        })
        .collect()
}

fn assert_staged_batches(
    sandbox: &MockSandbox,
    plan: &StoragePlan,
    bodies: &[Vec<u8>],
    expected_batch_sizes: &[usize],
) {
    let mut expected = bodies
        .iter()
        .enumerate()
        .map(|(index, body)| (guest_archive_path(&format!("batch-{index}"), "v1"), body))
        .collect::<HashMap<_, _>>();
    let batches = sandbox.write_files_calls();
    assert_eq!(
        batches
            .iter()
            .map(|batch| batch.files.len())
            .collect::<Vec<_>>(),
        expected_batch_sizes
    );
    for batch in batches {
        assert!(!batch.files.is_empty());
        assert!(batch.files.len() <= 64);
        assert!(
            batch
                .files
                .iter()
                .map(|file| file.content.len())
                .sum::<usize>()
                <= BYTE_LIMIT
        );
        for file in batch.files {
            let body = expected
                .remove(&file.path)
                .expect("each archive must be staged exactly once");
            assert_eq!(&file.content, body);
        }
    }
    assert!(expected.is_empty(), "every archive must reach the guest");
    for index in 0..bodies.len() {
        let source = format!(
            "file://{}",
            guest_archive_path(&format!("batch-{index}"), "v1")
        );
        assert_eq!(storage_archive_url(plan, index), Some(source.as_str()));
    }
}

#[tokio::test]
async fn warm_batches_split_at_the_file_limit() {
    for (count, expected_batch_sizes) in [(63, vec![63]), (64, vec![64]), (65, vec![64, 1])] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("warm-file-boundary");
        let mut telemetry = new_telemetry();
        let bodies = vec![tarball_bytes(); count];
        let entries = bodies
            .iter()
            .enumerate()
            .map(|(index, body)| {
                let name = format!("batch-{index}");
                write_cached_archive(&home, &name, "v1", body);
                storage_entry(
                    format!("/mnt/batch-{index}"),
                    format!("https://r2.example.com/{index}.tar.gz"),
                    &name,
                    "v1",
                )
            })
            .collect();
        let mut plan = plan_from_entries(entries, Vec::new(), None);

        assert!(
            populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                None,
                None,
            )
            .await
            .unwrap()
            .is_none()
        );

        assert_staged_batches(&sandbox, &plan, &bodies, &expected_batch_sizes);
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(
            &ops,
            STORAGE_CACHE_STAGE_BATCH_WRITE,
            expected_batch_sizes.len(),
        );
        assert_op_count(&ops, "storage_cache_hit", count);
    }
}

#[tokio::test]
async fn warm_batches_preserve_exact_byte_boundaries() {
    for combined_bytes in [BYTE_LIMIT - 1, BYTE_LIMIT, BYTE_LIMIT + 1] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("warm-byte-boundary");
        let mut telemetry = new_telemetry();
        let bodies = byte_boundary_archives(combined_bytes);
        let entries = bodies
            .iter()
            .enumerate()
            .map(|(index, body)| {
                let name = format!("batch-{index}");
                write_cached_archive(&home, &name, "v1", body);
                storage_entry(
                    format!("/mnt/batch-{index}"),
                    format!("https://r2.example.com/{index}.tar.gz"),
                    &name,
                    "v1",
                )
            })
            .collect();
        let mut plan = plan_from_entries(entries, Vec::new(), None);

        assert!(
            populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                None,
                None,
            )
            .await
            .unwrap()
            .is_none()
        );

        let expected_batch_sizes = if combined_bytes > BYTE_LIMIT {
            vec![1, 1]
        } else {
            vec![2]
        };
        assert_staged_batches(&sandbox, &plan, &bodies, &expected_batch_sizes);
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(
            &ops,
            STORAGE_CACHE_STAGE_BATCH_WRITE,
            expected_batch_sizes.len(),
        );
        assert_op_count(&ops, "storage_cache_hit", bodies.len());
    }
}

#[tokio::test]
async fn fresh_batches_preserve_exact_byte_boundaries() {
    for combined_bytes in [BYTE_LIMIT - 1, BYTE_LIMIT, BYTE_LIMIT + 1] {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = MockServer::start_async().await;
        let sandbox = MockSandbox::new("fresh-byte-boundary");
        let bodies = byte_boundary_archives(combined_bytes);
        let mut gets = Vec::new();
        let mut entries = Vec::new();
        for (index, body) in bodies.iter().enumerate() {
            let path = format!("/batch-{index}.tar.gz");
            gets.push(
                server
                    .mock_async(|when, then| {
                        when.method(GET).path(&path).header_missing("range");
                        then.status(200).body(body.clone());
                    })
                    .await,
            );
            entries.push(storage_entry_with_archive_size(
                format!("/mnt/batch-{index}"),
                server.url(&path),
                &format!("batch-{index}"),
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

        assert!(
            populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await
            .unwrap()
            .is_none()
        );

        let expected_batch_sizes = if combined_bytes > BYTE_LIMIT {
            vec![1, 1]
        } else {
            vec![2]
        };
        assert_staged_batches(&sandbox, &plan, &bodies, &expected_batch_sizes);
        for (index, body) in bodies.iter().enumerate() {
            gets[index].assert_calls_async(1).await;
            assert_eq!(
                fs::read(
                    home.storage_cache_dir(&format!("batch-{index}"), "v1")
                        .join("archive.tar.gz")
                )
                .await
                .unwrap(),
                *body
            );
        }
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(
            &ops,
            STORAGE_CACHE_STAGE_BATCH_WRITE,
            expected_batch_sizes.len(),
        );
        assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_STAGED, bodies.len());
        assert_op_count(&ops, "storage_cache_hit", bodies.len());
    }
}
