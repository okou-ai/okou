use super::*;
use serde_json::json;

#[test]
fn input_probe_cancellation_cannot_be_converted_into_ineligible_success() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    let manifest:Manifest=serde_json::from_value(json!({
        "storageMounts":[{"mountPath":root.path().join("input"),"archiveUrl":"file:///tmp/pending.tar.gz"}],
        "archiveReadiness":{"id":"5d342f8e-4a56-4b67-b890-4561c2d3e456","sources":["file:///tmp/pending.tar.gz"]}
    })).unwrap();
    let first_input_probe = runtime.ancestors().count() + 3;
    let mut probes = 0;
    let error = eligible(&manifest, Some(&runtime), || {
        probes += 1;
        if probes == first_input_probe {
            Err(io::Error::new(io::ErrorKind::TimedOut, "query deadline"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(!runtime.exists());
    assert!(!root.path().join("input").exists());
}
