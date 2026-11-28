package ai.okou.android

import androidx.annotation.StringRes
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.res.stringResource
import java.util.concurrent.atomic.AtomicLong

private val feedbackOrder = AtomicLong()

internal fun nextPaneFeedbackOrder(): Long = feedbackOrder.incrementAndGet()

internal class FeedbackReceipt<out T>(val value: T) {
    val order = nextPaneFeedbackOrder()
}

internal class PaneFeedbackError(val order: Long, val present: @Composable () -> Unit)

internal class PaneReadAnnouncements {
    private val dismissed = mutableStateOf(emptySet<Long>())

    fun contains(order: Long): Boolean = order in dismissed.value

    fun dismiss(order: Long) {
        dismissed.value += order
    }

    fun retain(active: Collection<Long>) {
        dismissed.value = dismissed.value.intersect(active)
    }

    @Composable
    fun RetireOnExit(orders: List<Long>) {
        val current = rememberUpdatedState(orders)
        DisposableEffect(this) { onDispose { dismissed.value += current.value } }
    }
}

@Composable
internal fun paneReadError(
    order: Long,
    @StringRes message: Int,
    announcements: PaneReadAnnouncements,
    snackbar: SnackbarHostState,
): PaneFeedbackError? {
    if (announcements.contains(order)) return null
    val text = stringResource(message)
    return PaneFeedbackError(order) {
        PaneFeedbackMessage(snackbar, order, text) { announcements.dismiss(order) }
    }
}

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
