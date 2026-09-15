export function removeAcquisitionParameters(params: URLSearchParams): void {
  for (const key of Array.from(params.keys())) {
    if (
      /^(?:utm_|(?:vm0|okou)_(?:source|campaign_id|ad_group_id|experiment|variant)|ga_|gclid$|gbraid$|wbraid$|dclid$|fbclid$|msclkid$|irclickid$|irgwc$|impact_|source_type$|referrer_domain$|landing_|lp_variant$|_gl$)/iu.test(
        key,
      )
    ) {
      params.delete(key);
    }
  }
}
