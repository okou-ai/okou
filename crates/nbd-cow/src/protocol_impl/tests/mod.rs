use super::*;

#[test]
fn round_trip_request() {
    let req = NbdRequest {
        command: Command::Write,
        handle: 0xDEAD_BEEF_CAFE_BABE,
        offset: 4096,
        length: 512,
    };

    let buf = serialize_request(&req);
    let parsed = parse_request(&buf).unwrap();
    assert_eq!(parsed.command, req.command);
    assert_eq!(parsed.handle, req.handle);
    assert_eq!(parsed.offset, req.offset);
    assert_eq!(parsed.length, req.length);
}

#[test]
fn parse_request_ignores_trailing_bytes() {
    let req = NbdRequest {
        command: Command::Trim,
        handle: 0xCAFE_BABE_DEAD_BEEF,
        offset: 16_384,
        length: 4096,
    };

    let mut buf = serialize_request(&req).to_vec();
    buf.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);

    let parsed = parse_request(&buf).unwrap();
    assert_eq!(parsed.command, req.command);
    assert_eq!(parsed.handle, req.handle);
    assert_eq!(parsed.offset, req.offset);
    assert_eq!(parsed.length, req.length);
}

#[test]
fn round_trip_reply() {
    let reply = NbdReply {
        error: 0,
        handle: 0x1234_5678_9ABC_DEF0,
    };

    let buf = serialize_reply(&reply);

    assert_eq!(
        u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]),
        REPLY_MAGIC
    );
    assert_eq!(u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]), 0);
    assert_eq!(
        u64::from_be_bytes([
            buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
        ]),
        0x1234_5678_9ABC_DEF0
    );
}

#[test]
fn parse_all_commands() {
    for (cmd, val) in [
        (Command::Read, 0u16),
        (Command::Write, 1),
        (Command::Disconnect, 2),
        (Command::Flush, 3),
        (Command::Trim, 4),
    ] {
        let req = NbdRequest {
            command: cmd,
            handle: 1,
            offset: 0,
            length: 0,
        };
        let buf = serialize_request(&req);
        let parsed = parse_request(&buf).unwrap();
        assert_eq!(parsed.command, cmd);
        assert_eq!(parsed.command as u16, val);
    }
}

#[test]
fn invalid_magic() {
    let mut buf = [0u8; REQUEST_HEADER_SIZE];
    buf[0..4].copy_from_slice(&0xBAD_0000u32.to_be_bytes());

    let err = parse_request(&buf).unwrap_err();
    assert!(matches!(err, ProtocolError::InvalidRequestMagic(_)));
}

#[test]
fn unknown_command() {
    let req = NbdRequest {
        command: Command::Read,
        handle: 0,
        offset: 0,
        length: 0,
    };
    let mut buf = serialize_request(&req);
    // Overwrite command with invalid value
    buf[6..8].copy_from_slice(&99u16.to_be_bytes());

    let err = parse_request(&buf).unwrap_err();
    assert!(matches!(err, ProtocolError::UnknownCommand(99)));
}

#[test]
fn buffer_too_short() {
    let buf = [0u8; 10];
    let err = parse_request(&buf).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::BufferTooShort {
            expected: 28,
            actual: 10
        }
    ));
}

#[test]
fn empty_buffer() {
    let err = parse_request(&[]).unwrap_err();
    assert!(matches!(
        err,
        ProtocolError::BufferTooShort {
            expected: 28,
            actual: 0
        }
    ));
}

#[test]
fn error_display_invalid_magic() {
    let err = ProtocolError::InvalidRequestMagic(0xBAD);
    let msg = err.to_string();
    assert!(msg.contains("invalid request magic"), "got: {msg}");
}

#[test]
fn error_display_unknown_command() {
    let err = ProtocolError::UnknownCommand(99);
    let msg = err.to_string();
    assert!(msg.contains("unknown NBD command"), "got: {msg}");
    assert!(msg.contains("99"), "got: {msg}");
}

#[test]
fn error_display_buffer_too_short() {
    let err = ProtocolError::BufferTooShort {
        expected: 28,
        actual: 10,
    };
    let msg = err.to_string();
    assert!(msg.contains("28") && msg.contains("10"), "got: {msg}");
}

#[test]
fn round_trip_reply_with_error() {
    let reply = NbdReply {
        error: 5, // EIO
        handle: 0xAAAA_BBBB_CCCC_DDDD,
    };
    let buf = serialize_reply(&reply);
    assert_eq!(
        u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]),
        REPLY_MAGIC
    );
    assert_eq!(u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]), 5);
    assert_eq!(
        u64::from_be_bytes([
            buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]
        ]),
        0xAAAA_BBBB_CCCC_DDDD
    );
}

#[test]
fn parse_request_ignores_flags() {
    let req = NbdRequest {
        command: Command::Write,
        handle: 42,
        offset: 8192,
        length: 1024,
    };
    let mut buf = serialize_request(&req);
    write_u16(&mut buf, REQUEST_FLAGS_OFFSET, 0x0001);

    let parsed = parse_request(&buf).unwrap();
    assert_eq!(parsed.command, Command::Write);
    assert_eq!(parsed.handle, 42);
    assert_eq!(parsed.offset, 8192);
    assert_eq!(parsed.length, 1024);
}

#[test]
fn command_from_u16_boundary_values() {
    assert!(Command::from_u16(0).is_ok());
    assert!(Command::from_u16(4).is_ok());
    assert!(Command::from_u16(5).is_err());
    assert!(Command::from_u16(u16::MAX).is_err());
}
