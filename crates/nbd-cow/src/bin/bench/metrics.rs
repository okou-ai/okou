pub(crate) fn float_to_u64(value: f64, field: &str) -> Result<u64, String> {
    if value.is_finite() && value >= 0.0 && value < u64::MAX as f64 {
        Ok(value as u64)
    } else {
        Err(format!("{field} is outside u64 range"))
    }
}

#[cfg(test)]
mod tests;
