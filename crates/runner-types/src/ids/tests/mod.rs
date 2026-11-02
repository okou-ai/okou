use super::*;

#[test]
fn serde_transparent_roundtrip() {
    let id = RunId::new_v4();
    let json = serde_json::to_string(&id).unwrap();
    // Must serialize as a bare UUID string, not {"0":"..."}
    assert!(json.starts_with('"'), "expected bare string: {json}");
    let parsed: RunId = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, id);
}

#[test]
fn display_matches_uuid() {
    let uuid = Uuid::new_v4();
    let id = RunId::from(uuid);
    assert_eq!(id.to_string(), uuid.to_string());
}

#[test]
fn from_str_roundtrip() {
    let id = RunId::new_v4();
    let parsed: RunId = id.to_string().parse().unwrap();
    assert_eq!(parsed, id);
}

#[test]
fn from_str_invalid() {
    assert!("not-a-uuid".parse::<RunId>().is_err());
}
