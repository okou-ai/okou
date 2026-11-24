package ai.okou.android

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay

internal const val ContentReadFeedbackDelayMillis = 250L
private const val ContentReadFreshnessMillis = 10 * 60_000L

internal fun contentReadStaleDelayMillis(confirmedAt: Long, nowMillis: Long): Long =
    (ContentReadFreshnessMillis + 1 - (nowMillis - confirmedAt)).coerceAtLeast(0L)

@Composable
internal fun rememberContentReadSkeleton(
    hasContent: Boolean = false,
    awaitingRead: Boolean = true,
): Boolean =
    rememberContentReadFeedbackAfter(
        ContentReadFeedbackDelayMillis.takeIf { awaitingRead && !hasContent },
    )

/**
 * A null delay hides feedback, zero shows it immediately, and a positive delay can be cancelled.
 */
@Composable
internal fun rememberContentReadFeedbackAfter(delayMillis: Long?): Boolean {
    if (delayMillis == null) return false
    if (delayMillis == 0L) return true
    var visible by remember(delayMillis) { mutableStateOf(false) }
    LaunchedEffect(delayMillis) {
        delay(delayMillis)
        visible = true
    }
    return visible
}
