use super::*;

#[test]
fn pending_admission_tracks_independent_rfb_and_kdc_ssh_dependencies() {
    let rfb = Uuid::new_v4();
    let kdc = Uuid::new_v4();
    for (selector, expected) in [
        (Some(rfb), [false, true, false]),
        (Some(kdc), [false, false, true]),
        (Some(Uuid::new_v4()), [false, false, false]),
        (None, [false, true, true]),
    ] {
        let registry = Arc::new(Mutex::new(Entries::default()));
        let tokens: [_; 3] = std::array::from_fn(|_| CancellationToken::new());
        let admissions: Vec<_> = tokens
            .iter()
            .map(|token| {
                Admission::new(Arc::clone(&registry), Uuid::new_v4(), token.clone()).unwrap()
            })
            .collect();
        admissions[0].bind(Transport::Direct, None).unwrap();
        admissions[1]
            .bind(
                Transport::Ssh {
                    connection: rfb,
                    generation: 7,
                },
                None,
            )
            .unwrap();
        admissions[2]
            .bind(
                Transport::Direct,
                Some(Binding {
                    revision: 1,
                    kdc: Some(Transport::Ssh {
                        connection: kdc,
                        generation: 11,
                    }),
                }),
            )
            .unwrap();
        for _ in 0..2 {
            registry.lock().unwrap().invalidate(selector, true);
        }
        for (token, expected) in tokens.iter().zip(expected) {
            assert_eq!(token.is_cancelled(), expected);
        }
    }
}
