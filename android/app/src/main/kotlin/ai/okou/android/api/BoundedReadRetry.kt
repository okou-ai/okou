package ai.okou.android.api

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

private const val ReadRetries = 2
private const val ReadRetryDelayMillis = 3_000L

/**
 * The caller handles each attempt and returns an error when the read failed. A null result means
 * the caller finished or abandoned the read. Return the last error when retrying must stop.
 */
internal suspend fun <E : Throwable> retryBoundedRead(
    canRead: () -> Boolean,
    attempt: suspend () -> E?,
): E? {
    var remaining = ReadRetries
    if (!canRead()) return null
    while (true) {
        val error = attempt() ?: return null
        if (error is CancellationException) throw error
        val wait = error.boundedReadDelayMillis()
        if (remaining == 0 || wait == null) return error
        delay(wait)
        if (!canRead()) return null
        remaining--
    }
}

private fun Throwable.boundedReadDelayMillis(): Long? =
    when (this) {
        is ApiFailure.Network -> ReadRetryDelayMillis
        is ApiFailure.Http ->
            if (status == 408 || status == 429 || status in 500..599) {
                val seconds = (retryAfterSeconds ?: 0L).coerceIn(0L, Long.MAX_VALUE / 1_000)
                maxOf(ReadRetryDelayMillis, seconds * 1_000)
            } else null
        else -> null
    }
