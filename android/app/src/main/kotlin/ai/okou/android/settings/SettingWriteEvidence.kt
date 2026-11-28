package ai.okou.android.settings

import ai.okou.android.api.ApiFailure

internal fun Exception.definitivelyRejectedWrite(): Boolean =
    this is ApiFailure.Unauthenticated ||
        this is ApiFailure.Http && status in 400..499 && status != 408

internal fun Exception.canRetryRejectedSettingWrite(): Boolean =
    this is ApiFailure.Network && connectionFailed || this is ApiFailure.Http && status == 429
