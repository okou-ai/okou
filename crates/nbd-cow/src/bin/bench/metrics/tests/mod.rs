use super::*;

#[test]
fn float_to_u64_rejects_invalid_values() {
    assert_eq!(float_to_u64(42.9, "test").unwrap(), 42);
    assert!(float_to_u64(-1.0, "test").is_err());
    assert!(float_to_u64(f64::INFINITY, "test").is_err());
    assert!(float_to_u64(u64::MAX as f64, "test").is_err());
}
