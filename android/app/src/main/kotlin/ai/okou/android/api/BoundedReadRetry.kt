package ai.okou.android.api

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

internal val continuousRetryDelays = listOf(3_000L, 3_000L, 6_000L, 12_000L, 24_000L, 48_000L)

internal fun Throwable.retryAfterSeconds(): Long? =
    when (this) {
        is ApiFailure.Http -> retryAfterSeconds
        is IOException -> retryAfter(httpRejection()?.retryAfter)
        else -> null
    }

internal fun retryAfterDelayMillis(seconds: Long?): Long? =
    seconds?.takeIf { it >= 0L }?.coerceAtMost(Long.MAX_VALUE / 1_000)?.times(1_000)

internal fun continuousRetryDelayMillis(retries: Int, retryAfterSeconds: Long? = null): Long =
    retryAfterDelayMillis(retryAfterSeconds)
        ?: continuousRetryDelays[retries.coerceAtMost(continuousRetryDelays.lastIndex)]

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
    return retryAfterDelayMillis(failure?.retryAfterSeconds()) ?: defaultDelay
}

/** Timing for transient API failures on reads and writes that are safe to repeat. */
internal fun Throwable.boundedApiRetryDelayMillis(retries: Int): Long? =
    if (isTransientApiFailure()) boundedRetryDelayMillis(retries, this) else null

internal fun Throwable.isTransientApiFailure(): Boolean =
    when (this) {
        is ApiFailure.Network -> true
        is ApiFailure.Http -> status == 408 || status == 429 || status in 500..599
        else -> false
    }
