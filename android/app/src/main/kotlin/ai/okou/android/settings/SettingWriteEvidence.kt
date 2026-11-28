package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.boundedApiRetryDelayMillis
import ai.okou.android.api.boundedRetryDelayMillis
import kotlinx.coroutines.delay

internal enum class SettingReadback {
    ConfirmsLatest,
    ConfirmsAttempt,
    Unconfirmed,
}

/** A read that only matches the latest choice may predate the attempted write. */
internal fun <T> settingReadback(
    attempted: T,
    latest: T,
    matches: (T) -> Boolean,
): SettingReadback =
    when {
        !matches(attempted) -> SettingReadback.Unconfirmed
        matches(latest) -> SettingReadback.ConfirmsLatest
        else -> SettingReadback.ConfirmsAttempt
    }

internal fun Exception.definitivelyRejectedWrite(): Boolean =
    this is ApiFailure.Unauthenticated ||
        this is ApiFailure.Http && status in 400..499 && status != 408

internal fun Exception.canRetryRejectedSettingWrite(): Boolean =
    this is ApiFailure.Network && connectionFailed || this is ApiFailure.Http && status == 429

/** Read failures and observations that do not confirm the write share one retry budget. */
internal suspend fun verifySettingWrite(read: suspend () -> Boolean): Boolean {
    var retries = 0
    while (true) {
        val wait =
            try {
                if (read()) return true
                boundedRetryDelayMillis(retries) ?: return false
            } catch (error: ApiFailure) {
                error.boundedApiRetryDelayMillis(retries) ?: throw error
            }
        retries++
        delay(wait)
    }
}
