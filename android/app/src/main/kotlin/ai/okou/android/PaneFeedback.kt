package ai.okou.android

import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import java.util.concurrent.atomic.AtomicLong

private val feedbackOrder = AtomicLong()

internal fun nextPaneFeedbackOrder(): Long = feedbackOrder.incrementAndGet()

internal class FeedbackReceipt<out T>(val value: T) {
    val order = nextPaneFeedbackOrder()
}

internal class PaneFeedbackError(val order: Long, val present: @Composable () -> Unit)

/** The caller owns pending feedback and decides when it belongs to the visible pane. */
@Composable
internal fun PaneFeedback(
    errors: List<PaneFeedbackError?>,
    undo: (@Composable () -> Unit)? = null,
    result: (@Composable () -> Unit)? = null,
) {
    val firstError = errors.filterNotNull().minByOrNull { it.order }
    when {
        firstError != null -> key(firstError.order) { firstError.present() }
        undo != null -> undo()
        else -> result?.invoke()
    }
}

@Composable
internal fun PaneFeedbackMessage(
    snackbar: SnackbarHostState,
    receipt: Any,
    message: String,
    onDismissed: () -> Unit,
) {
    val acknowledge = rememberUpdatedState(onDismissed)
    LaunchedEffect(snackbar, receipt, message) {
        snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
        acknowledge.value()
    }
}
