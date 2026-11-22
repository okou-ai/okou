package ai.okou.android.settings

import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import kotlin.time.Instant

internal enum class QuotaPeriod {
    Short,
    Week,
    Unknown,
}

internal data class ModelAccountQuota(
    val period: QuotaPeriod,
    val remaining: Double?,
    val resetAt: Instant?,
    val windowSeconds: Double? = null,
)

private fun remaining(available: Double?, used: Double?): Double? =
    (available ?: used?.let { 100 - it })?.takeIf { it.isFinite() }?.coerceIn(0.0, 100.0)

private fun parseReset(value: String?): Instant? =
    value?.let { runCatching { Instant.parse(it) }.getOrNull() }

internal fun RecoverySubscriptionsSubscriptionsItem.quotas(): List<ModelAccountQuota> {
    val week = subscriptionUsage?.weekly
    val short = subscriptionUsage?.fiveHour
    val weekRemaining = remaining(week?.remainingPercent, week?.usedPercent)
    val weekReset = parseReset(week?.resetAt)
    val quotas = buildList {
        if (short != null) {
            val remaining = remaining(short.remainingPercent, short.usedPercent)
            val reset = parseReset(short.resetAt) ?: weekReset
            if (remaining != null || reset != null || weekRemaining == 0.0) {
                add(
                    ModelAccountQuota(
                        QuotaPeriod.Short,
                        if (weekRemaining == 0.0) 0.0 else remaining,
                        reset,
                        short.windowSeconds,
                    )
                )
            }
        }
        if (week != null && (weekRemaining != null || weekReset != null)) {
            add(ModelAccountQuota(QuotaPeriod.Week, weekRemaining, weekReset, week.windowSeconds))
        }
    }
    if (quotas.isNotEmpty()) return quotas
    val reset = parseReset(subscriptionNextResetAt) ?: return emptyList()
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
