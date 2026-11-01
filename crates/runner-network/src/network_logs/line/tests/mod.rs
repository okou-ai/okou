use tokio::io::BufReader;

use super::*;

#[tokio::test]
async fn matches_complete_utf8_trim_and_size_across_read_partitions() {
    let whitespace = " \t\r\u{000b}\u{000c}\u{0085}\u{00a0}\u{1680}\u{2000}\u{2003}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}";
    let cases = [
        String::new(),
        "\n".into(),
        "{}\r\n[]\n0".into(),
        format!("{whitespace}[0,1]{whitespace}\n{{}}"),
        format!(
            "{}\"é🌍\"{}\r\n1",
            whitespace.repeat(100),
            whitespace.repeat(100)
        ),
        format!("{{{}\"key\":0}}\n0", " ".repeat(200)),
        format!("{}\n0", whitespace.repeat(100)),
    ];
    for input in cases {
        for capacity in 1..=9 {
            for limit in [1, 2, 4, 8, 16, 64] {
                let mut reader = BufReader::with_capacity(capacity, input.as_bytes());
                let mut line = BoundedLogLine::new(limit);
                for original in input.split_inclusive('\n') {
                    assert_eq!(line.read(&mut reader).await.unwrap(), original.len());
                    assert_eq!(line.terminated(), original.ends_with('\n'));
                    let trimmed = original.trim();
                    let expected = if trimmed.len() > limit {
                        LineContent::Oversized(trimmed.len())
                    } else {
                        LineContent::Value(trimmed)
                    };
                    assert_eq!(
                        line.content(),
                        expected,
                        "capacity={capacity}, limit={limit}"
                    );
                }
                assert_eq!(line.read(&mut reader).await.unwrap(), 0);
            }
        }
    }
}

#[tokio::test]
async fn invalid_utf8_is_rejected_even_after_retention_overflow_or_whitespace() {
    for invalid in [
        b"\xc2".as_slice(),
        b"\xf0\x9f\x8c".as_slice(),
        b"\xe0\x80\x80".as_slice(),
        b"\xed\xa0\x80".as_slice(),
        b"\xff".as_slice(),
    ] {
        for prefix in *b" x" {
            let mut input = vec![prefix; 100];
            input.extend_from_slice(invalid);
            let first_len = input.len() + 1;
            input.extend_from_slice(b"\n{}\n");
            for capacity in 1..=9 {
                let mut reader = BufReader::with_capacity(capacity, input.as_slice());
                let mut line = BoundedLogLine::new(2);
                assert_eq!(line.read(&mut reader).await.unwrap(), first_len);
                assert_eq!(line.content(), LineContent::InvalidUtf8);
                assert_eq!(line.read(&mut reader).await.unwrap(), 3);
                assert_eq!(line.content(), LineContent::Value("{}"));
            }
        }
    }
}
