use super::*;

#[test]
fn round_trip_keeps_launch_stop_and_private_metadata_separate() {
    let handle = TaskHandle::generate();
    let mut bytes = Vec::new();
    write_request(&mut bytes, &TaskRequest::Launch {}).unwrap();
    assert!(matches!(
        read_request(&mut bytes.as_slice()).unwrap(),
        TaskRequest::Launch {}
    ));
    bytes.clear();
    write_request(
        &mut bytes,
        &TaskRequest::Stop {
            handle: handle.clone(),
        },
    )
    .unwrap();
    assert!(
        matches!(read_request(&mut bytes.as_slice()).unwrap(), TaskRequest::Stop { handle: actual } if actual == handle)
    );
    bytes.clear();
    let task = TaskStartup { handle, pid: 123 };
    write_reply(&mut bytes, &TaskReply::Ready { task: task.clone() }).unwrap();
    assert!(
        matches!(read_reply(&mut bytes.as_slice()).unwrap(), TaskReply::Ready { task: actual } if actual == task)
    );
    bytes.clear();
    write_reply(&mut bytes, &TaskReply::Stopped {}).unwrap();
    assert!(matches!(
        read_reply(&mut bytes.as_slice()).unwrap(),
        TaskReply::Stopped {}
    ));
}

#[test]
fn unsupported_versions_are_rejected_for_otherwise_valid_requests() {
    let mut frame = Vec::new();
    write_request(&mut frame, &TaskRequest::Launch {}).unwrap();
    assert_eq!(frame[4], 1);
    assert!(matches!(
        read_request(&mut frame.as_slice()).unwrap(),
        TaskRequest::Launch {}
    ));

    frame[4] = 2;
    let error = read_request(&mut frame.as_slice()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(error.to_string(), "unsupported task protocol version");
}

#[test]
fn invalid_sizes_payloads_and_oversized_replies_are_rejected() {
    for size in [0_u32, 1, MAX_FRAME as u32 + 1, u32::MAX] {
        assert_eq!(
            read_request(&mut size.to_be_bytes().as_slice())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
    for payload in [
        "{",
        r#"{"op":"launch","path":"/runtime"}"#,
        r#"{"op":"stop","handle":"1"}"#,
        r#"{"op":"unknown"}"#,
    ] {
        let mut frame = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
        frame.push(VERSION);
        frame.extend_from_slice(payload.as_bytes());
        assert!(read_request(&mut frame.as_slice()).is_err());
    }
    assert!(
        write_reply(
            &mut Vec::new(),
            &TaskReply::Rejected {
                diagnostic: "x".repeat(MAX_FRAME)
            }
        )
        .is_err()
    );
}
