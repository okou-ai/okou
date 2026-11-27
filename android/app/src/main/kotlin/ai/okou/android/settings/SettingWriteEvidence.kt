package ai.okou.android.settings

import ai.okou.android.api.ApiFailure

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
