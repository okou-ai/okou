package ai.okou.android

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.TimeMark
import kotlinx.coroutines.delay

internal const val ContentReadFeedbackDelayMillis = 250L
private const val ContentReadFreshnessMillis = 10 * 60_000L

internal fun contentReadStaleDelayMillis(confirmedAt: Long, nowMillis: Long): Long =
    (ContentReadFreshnessMillis + 1 - (nowMillis - confirmedAt)).coerceAtLeast(0L)

@Composable
internal fun rememberContentReadSkeleton(
    hasContent: Boolean = false,
    awaitingRead: Boolean = true,
    readScope: Any? = null,
): Boolean =
    rememberContentReadFeedbackAfter(
        ContentReadFeedbackDelayMillis.takeIf { awaitingRead && !hasContent },
        readScope,
    )

@Composable
internal fun rememberContentReadSkeleton(startedAt: TimeMark?): Boolean {
    val remaining =
        remember(startedAt) {
            startedAt?.let {
                (ContentReadFeedbackDelayMillis.milliseconds - it.elapsedNow())
                    .inWholeMilliseconds
                    .coerceAtLeast(0)
            }
        }
    return rememberContentReadFeedbackAfter(remaining, readScope = startedAt)
}

/**
 * A null delay ends the round. Scheduled work can defer the timer while keeping visible feedback.
 */
@Composable
internal fun rememberContentReadFeedbackAfter(
    delayMillis: Long?,
    readScope: Any? = null,
    start: Boolean = true,
): Boolean {
    if (delayMillis == null) return false
    if (delayMillis == 0L) return true
    var visible by remember(readScope, delayMillis) { mutableStateOf(false) }
    if (start && !visible) {
        LaunchedEffect(readScope, delayMillis) {
            delay(delayMillis)
            visible = true
        }
    }
    return visible
}
