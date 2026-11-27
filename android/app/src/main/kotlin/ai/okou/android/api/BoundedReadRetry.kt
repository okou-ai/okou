package ai.okou.android.api

import java.io.IOException
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
        val wait = error.boundedApiRetryDelayMillis(retries) ?: return error
        delay(wait)
        currentCoroutineContext().ensureActive()
        if (!canRead()) return null
        retries++
    }
}

/** Timing after the operation owner has decided that another attempt is eligible. */
internal fun boundedRetryDelayMillis(retries: Int, failure: Throwable? = null): Long? {
    val defaultDelay = finiteReadRetryDelays.getOrNull(retries) ?: return null
    val seconds =
        when (failure) {
            is ApiFailure.Http -> failure.retryAfterSeconds
            is IOException -> retryAfter(failure.httpRejection()?.retryAfter)
            else -> null
        }
    return seconds?.takeIf { it >= 0L }?.coerceAtMost(Long.MAX_VALUE / 1_000)?.times(1_000)
        ?: defaultDelay
}

/** Timing for transient API failures on reads and writes that are safe to repeat. */
internal fun Throwable.boundedApiRetryDelayMillis(retries: Int): Long? =
    when (this) {
        is ApiFailure.Network -> boundedRetryDelayMillis(retries, this)
        is ApiFailure.Http ->
            if (status == 408 || status == 429 || status in 500..599)
                boundedRetryDelayMillis(retries, this)
            else null
        else -> null
    }
