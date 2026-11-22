package ai.okou.android.chat

import ai.okou.android.R
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun WorkspaceRealtimeLifecycle(model: ChatUpdatesModel) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        fun update() = model.foreground(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose {
            lifecycle.removeObserver(observer)
            model.foreground(false)
        }
    }
}

@Composable
fun RealtimeNotice(model: ChatUpdatesModel) {
    val phase by model.phase.collectAsStateWithLifecycle()
    RealtimeNotice(model, phase)
}

@Composable
internal fun RealtimeNotice(model: ChatUpdatesModel, phase: RealtimePhase) {
    if (phase == RealtimePhase.Connecting || phase == RealtimePhase.Unavailable) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
            Text(
                stringResource(
                    if (phase == RealtimePhase.Connecting) R.string.realtime_connecting
                    else R.string.realtime_unavailable
                ),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodySmall,
            )
            if (phase == RealtimePhase.Unavailable) {
                TextButton(
                    onClick = model::retry,
                    colors =
                        ButtonDefaults.textButtonColors(
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ),
                ) {
                    Text(stringResource(R.string.retry))
                }
            }
        }
    }
}
