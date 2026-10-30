use super::super::*;
use super::shared::{
    ExecStartLayout, ExecStartLayoutRequest, set_byte_at, write_u16_at, write_u32_at,
};
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseResult};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xEC5A_7A27_2026_0728;
const MAX_GENERATED_TEXT_CHARS: usize = 12;
const MAX_GENERATED_ENV_VARS: usize = 4;
const MAX_GENERATED_EXPECTED_EXITS: usize = 8;
const MAX_GENERATED_STDIN_BYTES: usize = 64;
const MAX_ARBITRARY_PAYLOAD_BYTES: usize = 512;

#[derive(Debug, Clone)]
struct OwnedExecStart {
    lifecycle: ExecLifecyclePolicy,
    role: ExecProcessRole,
    timeout: ExecTimeoutPolicy,
    command: String,
    env: Vec<(String, String)>,
    sudo: bool,
    label: String,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
    expected_exit_codes: Vec<i32>,
    control: ExecControlPolicy,
    stdin_bytes: Option<Vec<u8>>,
}

impl OwnedExecStart {
    fn env_refs(&self) -> Vec<(&str, &str)> {
        self.env
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let env = self.env_refs();
        encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
            lifecycle: self.lifecycle,
            role: self.role,
            timeout: self.timeout,
            command: &self.command,
            env: &env,
            sudo: self.sudo,
            label: &self.label,
            stdout: self.stdout,
            stderr: self.stderr,
            expected_exit_codes: &self.expected_exit_codes,
            control: self.control,
            stdin_bytes: self.stdin_bytes.as_deref(),
        })
    }

    fn layout(&self) -> ExecStartLayout {
        let env = self.env_refs();
        ExecStartLayout::new(ExecStartLayoutRequest {
            timeout: self.timeout,
            command: &self.command,
            env: &env,
            label: &self.label,
            stdout: self.stdout,
            stderr: self.stderr,
            expected_exit_codes: &self.expected_exit_codes,
            control: self.control,
            stdin_bytes: self.stdin_bytes.as_deref(),
        })
    }

    fn assert_decoded(&self, decoded: &DecodedExecStart<'_>) -> TestCaseResult {
        let env = self.env_refs();
        prop_assert_eq!(decoded.lifecycle, self.lifecycle);
        prop_assert_eq!(decoded.role, self.role);
        prop_assert_eq!(decoded.timeout, self.timeout);
        prop_assert_eq!(decoded.command, self.command.as_str());
        prop_assert_eq!(decoded.env.as_slice(), env.as_slice());
        prop_assert_eq!(decoded.sudo, self.sudo);
        prop_assert_eq!(decoded.label, self.label.as_str());
        prop_assert_eq!(decoded.stdout, self.stdout);
        prop_assert_eq!(decoded.stderr, self.stderr);
        prop_assert_eq!(
            decoded.expected_exit_codes.as_slice(),
            self.expected_exit_codes.as_slice()
        );
        prop_assert_eq!(decoded.control, self.control);
        prop_assert_eq!(decoded.stdin_bytes, self.stdin_bytes.as_deref());
        Ok(())
    }

    fn invalid_mutations(&self, payload: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
        let layout = self.layout();
        let mut mutations = vec![
            (
                "invalid lifecycle tag",
                with_byte(payload, layout.lifecycle_offset, u8::MAX),
            ),
            (
                "invalid process role tag",
                with_byte(payload, layout.role_offset, u8::MAX),
            ),
            (
                "invalid timeout tag",
                with_byte(payload, layout.timeout_policy_offset, u8::MAX),
            ),
            (
                "unknown exec flag",
                with_byte(payload, layout.flags_offset, 0x80),
            ),
            (
                "command length beyond remaining payload",
                with_u32(payload, layout.command_len_offset, u32::MAX),
            ),
            (
                "invalid command UTF-8",
                with_invalid_command_utf8(payload, &layout),
            ),
            (
                "environment count above limit",
                with_u32(
                    payload,
                    layout.env_count_offset,
                    (MAX_EXEC_ENV_VARS as u32) + 1,
                ),
            ),
            (
                "label length beyond remaining payload",
                with_u16(payload, layout.label_len_offset, u16::MAX),
            ),
            (
                "invalid stdout policy tag",
                with_byte(payload, layout.stdout_policy.tag_offset, u8::MAX),
            ),
            (
                "invalid stderr policy tag",
                with_byte(payload, layout.stderr_policy.tag_offset, u8::MAX),
            ),
            (
                "expected exit count above limit",
                with_u16(
                    payload,
                    layout.expected_exit_count_offset,
                    (MAX_EXEC_EXPECTED_EXIT_CODES as u16) + 1,
                ),
            ),
            (
                "invalid control tag",
                with_byte(payload, layout.control.tag_offset, u8::MAX),
            ),
            (
                "invalid stdin tag",
                with_byte(payload, layout.stdin.tag_offset, u8::MAX),
            ),
        ];

        if let Some(timeout_value_offset) = layout.timeout_value_offset {
            mutations.push((
                "zero duration timeout",
                with_u32(payload, timeout_value_offset, 0),
            ));
        }
        if let Some(chunk_limit_offset) = layout.stdout_policy.chunk_limit_offset {
            mutations.push((
                "zero stdout chunk limit",
                with_u32(payload, chunk_limit_offset, 0),
            ));
        }
        if let Some(chunk_limit_offset) = layout.stderr_policy.chunk_limit_offset {
            mutations.push((
                "zero stderr chunk limit",
                with_u32(payload, chunk_limit_offset, 0),
            ));
        }
        if let Some(control_flags_offset) = layout.control.flags_offset {
            mutations.push((
                "unknown control flag",
                with_byte(payload, control_flags_offset, 0x80),
            ));
        }
        if let Some(stdin_len_offset) = layout.stdin.len_offset {
            mutations.push((
                "stdin length above limit",
                with_u32(payload, stdin_len_offset, (MAX_EXEC_STDIN_BYTES as u32) + 1),
            ));
        }

        let mut trailing = payload.to_vec();
        trailing.push(0);
        mutations.push(("trailing byte", trailing));

        mutations
    }
}

fn with_byte(payload: &[u8], offset: usize, value: u8) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    set_byte_at(&mut mutation, offset, value);
    mutation
}

fn with_u16(payload: &[u8], offset: usize, value: u16) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    write_u16_at(&mut mutation, offset, value);
    mutation
}

fn with_u32(payload: &[u8], offset: usize, value: u32) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    write_u32_at(&mut mutation, offset, value);
    mutation
}

fn with_invalid_command_utf8(payload: &[u8], layout: &ExecStartLayout) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    mutation.insert(layout.command_offset, u8::MAX);
    write_u32_at(&mut mutation, layout.command_len_offset, 1);
    mutation
}

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(
        prop_oneof![
            4 => proptest::char::range(' ', '~'),
            1 => Just('界'),
            1 => any::<char>(),
        ],
        0..=MAX_GENERATED_TEXT_CHARS,
    )
    .prop_map(|chars| chars.into_iter().collect())
}

fn u32_edge_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![Just(0), Just(1), Just(u32::MAX), any::<u32>()]
}

fn nonzero_u32_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![Just(1), Just(u32::MAX), 1..u32::MAX]
}

fn process_contract_strategy()
-> impl Strategy<Value = (ExecProcessRole, ExecLifecyclePolicy, ExecControlPolicy)> {
    prop_oneof![
        Just((
            ExecProcessRole::Workload,
            ExecLifecyclePolicy::OneShot,
            ExecControlPolicy::Disabled,
        )),
        Just((
            ExecProcessRole::Workload,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Disabled,
        )),
        any::<ExecControlNonce>().prop_map(|control_nonce| (
            ExecProcessRole::Workload,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Enabled {
                control_nonce,
                sink: false,
            },
        )),
        any::<ExecControlNonce>().prop_map(|control_nonce| (
            ExecProcessRole::Agent,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Enabled {
                control_nonce,
                sink: true,
            },
        )),
        Just((
            ExecProcessRole::SessionHistoryIdentityVerifier,
            ExecLifecyclePolicy::OneShot,
            ExecControlPolicy::Disabled,
        )),
    ]
}

fn timeout_strategy() -> impl Strategy<Value = ExecTimeoutPolicy> {
    prop_oneof![
        nonzero_u32_strategy().prop_map(|timeout_ms| ExecTimeoutPolicy::Duration { timeout_ms }),
        Just(ExecTimeoutPolicy::None),
    ]
}

fn output_policy_strategy() -> impl Strategy<Value = ExecOutputPolicy> {
    prop_oneof![
        Just(ExecOutputPolicy::Discard),
        u32_edge_strategy().prop_map(|limit_bytes| ExecOutputPolicy::Capture { limit_bytes }),
        (u32_edge_strategy(), nonzero_u32_strategy()).prop_map(
            |(limit_bytes, chunk_limit_bytes)| ExecOutputPolicy::Stream {
                limit_bytes,
                chunk_limit_bytes,
            }
        ),
        (
            u32_edge_strategy(),
            u32_edge_strategy(),
            nonzero_u32_strategy(),
        )
            .prop_map(
                |(capture_limit_bytes, stream_limit_bytes, chunk_limit_bytes)| {
                    ExecOutputPolicy::CaptureAndStream {
                        capture_limit_bytes,
                        stream_limit_bytes,
                        chunk_limit_bytes,
                    }
                }
            ),
    ]
}

fn expected_exit_strategy() -> impl Strategy<Value = i32> {
    prop_oneof![
        Just(i32::MIN),
        Just(-1),
        Just(0),
        Just(1),
        Just(i32::MAX),
        any::<i32>(),
    ]
}

fn exec_start_strategy() -> impl Strategy<Value = OwnedExecStart> {
    (
        process_contract_strategy(),
        timeout_strategy(),
        text_strategy(),
        proptest::collection::vec(
            (text_strategy(), text_strategy()),
            0..=MAX_GENERATED_ENV_VARS,
        ),
        any::<bool>(),
        text_strategy(),
        output_policy_strategy(),
        output_policy_strategy(),
        proptest::collection::vec(expected_exit_strategy(), 0..=MAX_GENERATED_EXPECTED_EXITS),
        proptest::option::of(proptest::collection::vec(
            any::<u8>(),
            0..=MAX_GENERATED_STDIN_BYTES,
        )),
    )
        .prop_map(
            |(
                (role, lifecycle, control),
                timeout,
                command,
                env,
                sudo,
                label,
                stdout,
                stderr,
                expected_exit_codes,
                stdin_bytes,
            )| OwnedExecStart {
                lifecycle,
                role,
                timeout,
                command,
                env,
                sudo,
                label,
                stdout,
                stderr,
                expected_exit_codes,
                control,
                stdin_bytes,
            },
        )
}

fn arbitrary_or_valid_payload_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES),
        1 => exec_start_strategy().prop_map(|request| request.encode().unwrap()),
    ]
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_exec_start_requests_roundtrip_and_reject_strict_prefixes(
        request in exec_start_strategy(),
    ) {
        let payload = request.encode();
        prop_assert!(payload.is_ok(), "generated request failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_exec_start(&payload);
        prop_assert!(decoded.is_ok(), "encoded request failed to decode: {decoded:?}");
        request.assert_decoded(&decoded.unwrap())?;

        for prefix_len in 0..payload.len() {
            prop_assert!(
                decode_exec_start(&payload[..prefix_len]).is_err(),
                "accepted strict prefix ending at {prefix_len} of {} bytes",
                payload.len(),
            );
        }
    }

    #[test]
    fn arbitrary_exec_start_payloads_never_panic_and_respect_limits(
        payload in arbitrary_or_valid_payload_strategy(),
    ) {
        if let Ok(decoded) = decode_exec_start(&payload) {
            prop_assert!(decoded.env.len() <= MAX_EXEC_ENV_VARS);
            prop_assert!(
                decoded.expected_exit_codes.len() <= MAX_EXEC_EXPECTED_EXIT_CODES
            );
            prop_assert!(
                decoded.stdin_bytes.is_none_or(|bytes| bytes.len() <= MAX_EXEC_STDIN_BYTES)
            );

            let reencoded = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
                lifecycle: decoded.lifecycle,
                role: decoded.role,
                timeout: decoded.timeout,
                command: decoded.command,
                env: &decoded.env,
                sudo: decoded.sudo,
                label: decoded.label,
                stdout: decoded.stdout,
                stderr: decoded.stderr,
                expected_exit_codes: &decoded.expected_exit_codes,
                control: decoded.control,
                stdin_bytes: decoded.stdin_bytes,
            });
            prop_assert!(reencoded.is_ok(), "decoded request failed to re-encode: {reencoded:?}");
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn generated_invalid_exec_start_mutations_are_rejected(
        request in exec_start_strategy(),
    ) {
        let payload = request.encode();
        prop_assert!(payload.is_ok(), "generated request failed to encode: {payload:?}");
        let payload = payload.unwrap();

        for (name, mutation) in request.invalid_mutations(&payload) {
            prop_assert!(
                decode_exec_start(&mutation).is_err(),
                "accepted {name} mutation: {mutation:?}",
            );
        }
    }
}

#[test]
fn exec_start_roundtrips_collection_limits_and_unicode() {
    let env = vec![("变量", "值"); MAX_EXEC_ENV_VARS];
    let expected_exit_codes = (0..MAX_EXEC_EXPECTED_EXIT_CODES)
        .map(|index| if index % 2 == 0 { i32::MIN } else { i32::MAX })
        .collect::<Vec<_>>();
    let payload = encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::Supervised,
        role: ExecProcessRole::Workload,
        timeout: ExecTimeoutPolicy::None,
        command: "打印“你好”",
        env: &env,
        sudo: true,
        label: "边界",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 0 },
        stderr: ExecOutputPolicy::Stream {
            limit_bytes: u32::MAX,
            chunk_limit_bytes: 1,
        },
        expected_exit_codes: &expected_exit_codes,
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    })
    .unwrap();

    let decoded = decode_exec_start(&payload).unwrap();
    assert_eq!(
        decoded,
        DecodedExecStart {
            lifecycle: ExecLifecyclePolicy::Supervised,
            role: ExecProcessRole::Workload,
            timeout: ExecTimeoutPolicy::None,
            command: "打印“你好”",
            env,
            sudo: true,
            label: "边界",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 0 },
            stderr: ExecOutputPolicy::Stream {
                limit_bytes: u32::MAX,
                chunk_limit_bytes: 1,
            },
            expected_exit_codes,
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        }
    );
}
