pub(super) const TEMPLATE_KEY_PREFIX: &str = "runner-templates/";

pub(super) fn key_for_template_hash(hash: &str) -> String {
    format!("{TEMPLATE_KEY_PREFIX}{hash}.tar.zst")
}
