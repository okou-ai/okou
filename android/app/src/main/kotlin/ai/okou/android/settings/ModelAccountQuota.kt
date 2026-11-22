package ai.okou.android.settings

import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem

internal enum class QuotaPeriod {
    Short,
    Week,
    Unknown,
}

internal data class ModelAccountQuota(
    val period: QuotaPeriod,
    val remaining: Double?,
    val resetAt: String?,
    val windowSeconds: Double? = null,
)

private fun remaining(available: Double?, used: Double?): Double? =
    (available ?: used?.let { 100 - it })?.takeIf { it.isFinite() }?.coerceIn(0.0, 100.0)

internal fun RecoverySubscriptionsSubscriptionsItem.quotas(): List<ModelAccountQuota> {
    val week = subscriptionUsage?.weekly
    val short = subscriptionUsage?.fiveHour
    val weekRemaining = remaining(week?.remainingPercent, week?.usedPercent)
    val quotas = buildList {
        if (short != null) {
            val remaining = remaining(short.remainingPercent, short.usedPercent)
            if (remaining != null || short.resetAt != null || weekRemaining == 0.0) {
                add(
                    ModelAccountQuota(
                        QuotaPeriod.Short,
                        if (weekRemaining == 0.0) 0.0 else remaining,
                        short.resetAt?.takeIf(String::isNotBlank) ?: week?.resetAt,
                        short.windowSeconds,
                    )
                )
            }
        }
        if (week != null && (weekRemaining != null || week.resetAt != null)) {
            add(
                ModelAccountQuota(QuotaPeriod.Week, weekRemaining, week.resetAt, week.windowSeconds)
            )
        }
    }
    if (quotas.isNotEmpty()) return quotas
    val reset = subscriptionNextResetAt?.takeIf(String::isNotBlank) ?: return emptyList()
    val period =
        when (subscriptionResetPeriod?.lowercase()) {
            "weekly" -> QuotaPeriod.Week
            "5-hour",
            "5h",
            "five-hour" -> QuotaPeriod.Short
            else -> QuotaPeriod.Unknown
        }
    return listOf(ModelAccountQuota(period, null, reset))
}
