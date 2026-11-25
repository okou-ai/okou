package ai.okou.android.api

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

/**
 * The caller handles each attempt and returns an error when the read failed. A null result means
 * the caller finished or abandoned the read. Return the last error when retrying must stop.
 */
internal suspend fun <E : Throwable> retryBoundedRead(
    canRead: () -> Boolean,
    attempt: suspend () -> E?,
): E? {
    var retries = 0
    if (!canRead()) return null
    while (true) {
        val error = attempt() ?: return null
        if (error is CancellationException) throw error
        val wait = error.boundedReadRetryDelayMillis(retries) ?: return error
        delay(wait)
        currentCoroutineContext().ensureActive()
        if (!canRead()) return null
        retries++
    }
}

internal fun Throwable.boundedReadRetryDelayMillis(retries: Int): Long? {
    val defaultDelay = finiteReadRetryDelays.getOrNull(retries) ?: return null
    return when (this) {
        is ApiFailure.Network -> defaultDelay
        is ApiFailure.Http ->
            if (status == 408 || status == 429 || status in 500..599) {
                retryAfterSeconds
                    ?.takeIf { it >= 0L }
                    ?.coerceAtMost(Long.MAX_VALUE / 1_000)
                    ?.times(1_000) ?: defaultDelay
            } else null
        else -> null
    }
}
