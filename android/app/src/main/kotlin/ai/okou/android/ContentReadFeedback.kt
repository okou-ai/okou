package ai.okou.android

import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember

internal class ReadFailureAnnouncement {
    private var scope: Any? = null
    private var round: Any? = null

    fun update(scope: Any, round: Any?): Boolean {
        val shouldAnnounce = round != null && (this.scope != scope || this.round != round)
        this.scope = scope
        this.round = round
        return shouldAnnounce
    }

    fun reset() {
        scope = null
        round = null
    }
}

@Composable
internal fun rememberReadFailureFeedback(
    scope: Any,
    failureRound: Any?,
    message: String?,
    announcement: ReadFailureAnnouncement = remember { ReadFailureAnnouncement() },
): SnackbarHostState {
    val snackbar = remember(announcement, scope) { SnackbarHostState() }
    LaunchedEffect(snackbar, failureRound) {
        if (announcement.update(scope, failureRound) && message != null) {
            snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
        }
    }
    WorkspaceFeedbackTimeout(snackbar)
    return snackbar
}
