use super::*;
use std::sync::mpsc;

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed};

const TEST_SERVER_WAIT_TIMEOUT: Duration = Duration::from_secs(1);
const PROPERTY_CASES: u32 = 256;
const PROPERTY_SEED: u64 = 0xD05E_3041_9000_0001;

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn response_for_query_with_answers(query: &[u8], answer_count: u16) -> Vec<u8> {
    let mut response = Vec::new();
    response.extend_from_slice(query.get(..2).unwrap());
    response.extend_from_slice(&0x8180_u16.to_be_bytes());
    response.extend_from_slice(&1_u16.to_be_bytes());
    response.extend_from_slice(&answer_count.to_be_bytes());
    response.extend_from_slice(&0_u16.to_be_bytes());
    response.extend_from_slice(&0_u16.to_be_bytes());
    response.extend_from_slice(query.get(12..).unwrap());
    response
}

fn append_answer(response: &mut Vec<u8>, owner: &[u8], record_type: u16, class: u16, data: &[u8]) {
    response.extend_from_slice(owner);
    response.extend_from_slice(&record_type.to_be_bytes());
    response.extend_from_slice(&class.to_be_bytes());
    response.extend_from_slice(&0_u32.to_be_bytes());
    response.extend_from_slice(&u16::try_from(data.len()).unwrap().to_be_bytes());
    response.extend_from_slice(data);
}

fn response_for_query_with_owner(query: &[u8], owner: &[u8], answer: Ipv4Addr) -> Vec<u8> {
    let mut response = response_for_query_with_answers(query, 1);
    append_answer(
        &mut response,
        owner,
        DNS_TYPE_A,
        DNS_CLASS_IN,
        &answer.octets(),
    );
    response
}

fn response_for_query(query: &[u8], answer: Ipv4Addr) -> Vec<u8> {
    response_for_query_with_owner(query, &[0xc0, 0x0c], answer)
}

fn question_name(query: &[u8]) -> &[u8] {
    query.get(12..query.len() - 4).unwrap()
}

fn pointer_to(offset: usize) -> [u8; 2] {
    (0xc000_u16 | u16::try_from(offset).unwrap()).to_be_bytes()
}

fn write_u16(packet: &mut [u8], offset: usize, value: u16) {
    packet
        .get_mut(offset..offset + 2)
        .unwrap()
        .copy_from_slice(&value.to_be_bytes());
}

fn validate_readiness_response(response: &[u8]) -> Result<(), DnsReadinessError> {
    validate_dns_response(response, 0x1234, DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4)
}

#[test]
fn query_uses_readiness_name_and_a_record() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();

    assert_eq!(query.get(..2).unwrap(), &0x1234_u16.to_be_bytes());
    assert_eq!(
        query.get(2..4).unwrap(),
        &DNS_QUERY_FLAGS_RECURSION_DESIRED.to_be_bytes()
    );
    assert!(
        query
            .windows("vm0-readiness".len())
            .any(|part| part == b"vm0-readiness")
    );
    assert_eq!(query.get(query.len() - 4..).unwrap(), &[0, 1, 0, 1]);
}

#[test]
fn response_validation_accepts_expected_compressed_a_record() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let response = response_for_query(&query, DNS_READINESS_IPV4);

    validate_readiness_response(&response).unwrap();
}

#[test]
fn response_validation_accepts_case_insensitive_uncompressed_names() {
    let query = build_dns_query(0x1234, "VM0-READINESS.INVALID").unwrap();
    let response = response_for_query_with_owner(&query, question_name(&query), DNS_READINESS_IPV4);

    validate_readiness_response(&response).unwrap();
}

#[test]
fn response_validation_accepts_nested_backward_pointer() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let mut response = response_for_query_with_answers(&query, 2);
    let first_owner_offset = response.len();
    append_answer(&mut response, &[0xc0, 0x0c], 16, DNS_CLASS_IN, &[]);
    append_answer(
        &mut response,
        &pointer_to(first_owner_offset),
        DNS_TYPE_A,
        DNS_CLASS_IN,
        &DNS_READINESS_IPV4.octets(),
    );

    validate_readiness_response(&response).unwrap();
}

#[test]
fn response_validation_rejects_wrong_transaction() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let response = response_for_query(&query, DNS_READINESS_IPV4);

    assert!(
        validate_dns_response(
            &response,
            0x4321,
            DNS_READINESS_HOSTNAME,
            DNS_READINESS_IPV4
        )
        .is_err()
    );
}

#[test]
fn response_validation_rejects_wrong_answer() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let response = response_for_query(&query, Ipv4Addr::new(192, 0, 2, 2));

    assert!(validate_readiness_response(&response).is_err());
}

#[test]
fn response_validation_rejects_mismatched_question_fields() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    // Keep the answer owner independent so a question-name change cannot also
    // invalidate the answer and hide a missing question-name check.
    let response = response_for_query_with_owner(&query, question_name(&query), DNS_READINESS_IPV4);
    validate_readiness_response(&response).unwrap();

    let mut wrong_name = response.clone();
    *wrong_name.get_mut(13).unwrap() = b'x';
    assert!(validate_readiness_response(&wrong_name).is_err());

    let mut wrong_type = response.clone();
    write_u16(&mut wrong_type, query.len() - 4, 28);
    assert!(validate_readiness_response(&wrong_type).is_err());

    let mut wrong_class = response;
    write_u16(&mut wrong_class, query.len() - 2, 3);
    assert!(validate_readiness_response(&wrong_class).is_err());
}

#[test]
fn response_validation_rejects_mismatched_answer_owner() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let other_query = build_dns_query(0x1234, "other.invalid").unwrap();
    let response =
        response_for_query_with_owner(&query, question_name(&other_query), DNS_READINESS_IPV4);

    assert!(validate_readiness_response(&response).is_err());
}

#[test]
fn response_validation_rejects_invalid_headers_counts_and_record_length() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let response = response_for_query(&query, DNS_READINESS_IPV4);

    for flags in [0x0180, 0x8980, 0x8380, 0x8182] {
        let mut invalid = response.clone();
        write_u16(&mut invalid, 2, flags);
        assert!(validate_readiness_response(&invalid).is_err());
    }

    for (offset, count) in [(4, 0), (4, 2), (6, 0), (6, 2)] {
        let mut invalid = response.clone();
        write_u16(&mut invalid, offset, count);
        assert!(validate_readiness_response(&invalid).is_err());
    }

    let mut invalid_length = response;
    write_u16(&mut invalid_length, query.len() + 10, 5);
    assert!(validate_readiness_response(&invalid_length).is_err());
}

#[test]
fn response_validation_rejects_malformed_names_and_pointers() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();

    let mut question_self_pointer = response_for_query(&query, DNS_READINESS_IPV4);
    question_self_pointer
        .get_mut(12..14)
        .unwrap()
        .copy_from_slice(&pointer_to(12));
    assert!(validate_readiness_response(&question_self_pointer).is_err());

    for owner in [pointer_to(query.len()), pointer_to(511), [0x40, 0x00]] {
        let response = response_for_query_with_owner(&query, &owner, DNS_READINESS_IPV4);
        assert!(validate_readiness_response(&response).is_err());
    }

    let answer_offset = query.len();
    let mut label_cycle = vec![1, b'a'];
    label_cycle.extend_from_slice(&pointer_to(answer_offset));
    let response = response_for_query_with_owner(&query, &label_cycle, DNS_READINESS_IPV4);
    assert!(validate_readiness_response(&response).is_err());

    let mut truncated_pointer = response_for_query(&query, DNS_READINESS_IPV4);
    truncated_pointer.truncate(query.len() + 1);
    assert!(validate_readiness_response(&truncated_pointer).is_err());

    let long_label = "a".repeat(63);
    let overlong_hostname = std::iter::repeat_n(long_label.as_str(), 4)
        .collect::<Vec<_>>()
        .join(".");
    let overlong_query = build_dns_query(0x1234, &overlong_hostname).unwrap();
    let overlong_response = response_for_query(&overlong_query, DNS_READINESS_IPV4);
    assert!(
        validate_dns_response(
            &overlong_response,
            0x1234,
            &overlong_hostname,
            DNS_READINESS_IPV4
        )
        .is_err()
    );
}

#[test]
fn response_validation_rejects_every_strict_truncation() {
    let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
    let response = response_for_query(&query, DNS_READINESS_IPV4);

    for length in 0..response.len() {
        assert!(
            validate_readiness_response(response.get(..length).unwrap()).is_err(),
            "accepted response truncated to {length} bytes"
        );
    }
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn response_validation_never_panics_for_bounded_bytes(
        response in proptest::collection::vec(any::<u8>(), 0..=DNS_RESPONSE_MAX_BYTES),
    ) {
        let _ = validate_readiness_response(&response);
    }

    #[test]
    fn response_validation_never_panics_for_single_byte_mutations(
        index in any::<usize>(),
        value in any::<u8>(),
    ) {
        let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
        let mut response = response_for_query(&query, DNS_READINESS_IPV4);
        let response_len = response.len();
        *response.get_mut(index % response_len).unwrap() = value;

        let _ = validate_readiness_response(&response);
    }
}

#[test]
fn endpoint_probe_rejects_controlled_invalid_response() {
    let server = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
    server
        .set_read_timeout(Some(TEST_SERVER_WAIT_TIMEOUT))
        .unwrap();
    let destination = match server.local_addr().unwrap() {
        std::net::SocketAddr::V4(address) => address,
        std::net::SocketAddr::V6(_) => panic!("test server should use IPv4"),
    };
    let server_thread = std::thread::spawn(move || -> io::Result<()> {
        let mut query = [0_u8; DNS_RESPONSE_MAX_BYTES];
        let (size, peer) = server.recv_from(&mut query)?;
        let mut response = response_for_query(&query[..size], DNS_READINESS_IPV4);
        write_u16(&mut response, size - 4, 28);
        server.send_to(&response, peer)?;
        Ok(())
    });

    let result = probe_dns_endpoint(
        destination,
        Duration::from_millis(30),
        DNS_READINESS_HOSTNAME,
    );
    let server_result = server_thread
        .join()
        .unwrap_or_else(|_| panic!("invalid-response DNS test server at {destination} panicked"));

    server_result.unwrap_or_else(|error| {
        panic!("invalid-response DNS test server at {destination} failed: {error}")
    });
    assert!(result.is_err());
}

#[test]
fn endpoint_probe_accepts_controlled_local_response() {
    let server = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
    server
        .set_read_timeout(Some(TEST_SERVER_WAIT_TIMEOUT))
        .unwrap();
    let destination = match server.local_addr().unwrap() {
        std::net::SocketAddr::V4(address) => address,
        std::net::SocketAddr::V6(_) => panic!("test server should use IPv4"),
    };
    let server_thread = std::thread::spawn(move || -> io::Result<()> {
        let mut query = [0_u8; DNS_RESPONSE_MAX_BYTES];
        let (size, peer) = server.recv_from(&mut query)?;
        let response = response_for_query(&query[..size], DNS_READINESS_IPV4);
        server.send_to(&response, peer)?;
        Ok(())
    });

    let result = probe_dns_endpoint(
        destination,
        TEST_SERVER_WAIT_TIMEOUT,
        DNS_READINESS_HOSTNAME,
    );
    let server_result = server_thread.join().unwrap_or_else(|_| {
        panic!("controlled-response DNS test server at {destination} panicked")
    });

    server_result.unwrap_or_else(|error| {
            panic!(
                "controlled-response DNS test server at {destination} did not receive and answer a query within {TEST_SERVER_WAIT_TIMEOUT:?}: {error}"
            )
        });
    result.unwrap();
}

#[test]
fn endpoint_probe_times_out_without_response() {
    let server = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
    server
        .set_read_timeout(Some(TEST_SERVER_WAIT_TIMEOUT))
        .unwrap();
    let destination = match server.local_addr().unwrap() {
        std::net::SocketAddr::V4(address) => address,
        std::net::SocketAddr::V6(_) => panic!("test server should use IPv4"),
    };
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let server_thread = std::thread::spawn(move || {
        let mut query = [0_u8; DNS_RESPONSE_MAX_BYTES];
        let received = server.recv_from(&mut query);
        if received.is_ok() {
            let _ = received_tx.send(());
            let _ = release_rx.recv_timeout(TEST_SERVER_WAIT_TIMEOUT);
        }
        received.map(|_| ())
    });

    let result = probe_dns_endpoint(
        destination,
        Duration::from_millis(30),
        DNS_READINESS_HOSTNAME,
    );

    let received = received_rx.recv_timeout(TEST_SERVER_WAIT_TIMEOUT);
    let _ = release_tx.send(());
    let server_result = server_thread
        .join()
        .unwrap_or_else(|_| panic!("no-response DNS test server at {destination} panicked"));

    if let Err(error) = received {
        panic!(
            "no-response DNS test server at {destination} did not observe a query within {TEST_SERVER_WAIT_TIMEOUT:?}: observation={error}; server={server_result:?}"
        );
    }
    server_result.unwrap_or_else(|error| {
        panic!("no-response DNS test server at {destination} failed: {error}")
    });
    let error = result.unwrap_err();
    assert_eq!(error.stage_name(), DnsReadinessStage::Timeout);
}
