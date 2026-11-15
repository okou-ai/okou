package ai.okou.android.updates

import ai.okou.android.R
import android.text.format.Formatter
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
fun UpdateHost(
    state: UpdateUiState,
    check: () -> Unit,
    download: () -> Unit,
    cancel: () -> Unit,
    defer: () -> Unit,
    install: () -> Unit,
    canInstall: Boolean,
    content: @Composable (openUpdates: () -> Unit) -> Unit,
) {
    var details by remember { mutableStateOf(false) }
    val controls: @Composable () -> Unit = {
        UpdateActions(state, check, download, cancel, install, canInstall)
    }
    if (state.required) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
                Column(
                    Modifier.widthIn(max = 560.dp).fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    Column(
                        Modifier.weight(1f).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        Image(painterResource(R.drawable.okou_mark), null, Modifier.size(56.dp))
                        Text(
                            stringResource(R.string.updates_required),
                            style = MaterialTheme.typography.headlineMedium,
                            modifier = Modifier.semantics { heading() },
                        )
                        Text(stringResource(R.string.updates_required_description))
                        UpdateDetails(state, canInstall, showNotes = false)
                    }
                    controls()
                }
            }
        }
    } else {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            if (state.announce) {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                        Text(
                            stringResource(R.string.updates_available, state.release!!.version),
                            Modifier.fillMaxWidth(),
                        )
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            ActionText(stringResource(R.string.updates_view), { details = true })
                            if (
                                state.transfer != UpdateTransfer.Downloading &&
                                    state.transfer != UpdateTransfer.Ready
                            )
                                ActionText(stringResource(R.string.updates_later), defer)
                        }
                    }
                }
            }
            Box(Modifier.weight(1f)) { content { details = true } }
        }
    }
    if (details && !state.required) {
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text(stringResource(R.string.updates_title)) },
            text = {
                Column(
                    Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    UpdateDetails(state, canInstall)
                }
            },
            confirmButton = controls,
            dismissButton = {
                ActionText(
                    stringResource(R.string.updates_later),
                    {
                        details = false
                        defer()
                    },
                )
            },
        )
    }
}

@Composable
fun AppUpdateSettings(state: UpdateUiState, open: () -> Unit, check: () -> Unit) {
    Text(
        stringResource(R.string.updates_title),
        style = MaterialTheme.typography.titleLarge,
        modifier = Modifier.semantics { heading() },
    )
    Text(
        stringResource(R.string.updates_installed, state.installedVersion),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (state.available) {
        ActionText(stringResource(R.string.updates_available, state.release!!.version), open)
    } else {
        if (state.check == UpdateCheck.Checked) Text(stringResource(R.string.updates_current))
        if (state.check == UpdateCheck.Failed)
            Text(
                stringResource(R.string.updates_error_check),
                color = MaterialTheme.colorScheme.error,
            )
    }
    ActionText(
        stringResource(
            if (state.check == UpdateCheck.Checking) R.string.updates_checking
            else R.string.updates_check
        ),
        check,
        state.check != UpdateCheck.Checking,
    )
}

@Composable
private fun UpdateDetails(state: UpdateUiState, canInstall: Boolean, showNotes: Boolean = true) {
    Text(stringResource(R.string.updates_installed, state.installedVersion))
    state.release?.let { release ->
        Text(
            stringResource(R.string.updates_target, release.version),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            Formatter.formatShortFileSize(LocalContext.current, release.size),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (showNotes && release.notes.isNotBlank()) Text(release.notes)
        if ((state.available || state.required) && !state.suitable)
            Text(
                stringResource(
                    if (release.minimumSdk > state.sdk) R.string.updates_android_unsupported
                    else R.string.updates_unavailable
                ),
                color = MaterialTheme.colorScheme.error,
            )
    }
    if (state.check == UpdateCheck.Checking) Text(stringResource(R.string.updates_checking))
    if (state.check == UpdateCheck.Checked && !state.available && !state.required)
        Text(stringResource(R.string.updates_current))
    if (state.transfer == UpdateTransfer.Downloading) {
        val fraction =
            (state.downloadedBytes.toFloat() / checkNotNull(state.release).size).coerceIn(0f, 1f)
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(stringResource(R.string.updates_downloading, (fraction * 100).toInt()))
    }
    if (state.transfer == UpdateTransfer.Ready && !canInstall)
        Text(stringResource(R.string.updates_permission))
    state.problem?.let { problem ->
        val message =
            when (problem) {
                UpdateProblem.Check -> R.string.updates_error_check
                UpdateProblem.Download -> R.string.updates_error_download
                UpdateProblem.Integrity -> R.string.updates_error_integrity
                UpdateProblem.Identity -> R.string.updates_error_identity
                UpdateProblem.Storage -> R.string.updates_error_storage
                UpdateProblem.Interrupted -> R.string.updates_error_interrupted
                UpdateProblem.Install -> R.string.updates_error_install
            }
        Text(
            stringResource(message),
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

@Composable
private fun UpdateActions(
    state: UpdateUiState,
    check: () -> Unit,
    download: () -> Unit,
    cancel: () -> Unit,
    install: () -> Unit,
    canInstall: Boolean,
) {
    when {
        state.transfer == UpdateTransfer.Downloading ->
            ActionText(stringResource(R.string.updates_cancel), cancel)
        state.suitable && state.transfer == UpdateTransfer.Ready ->
            Button(onClick = install) {
                Text(
                    stringResource(
                        if (canInstall) R.string.updates_install else R.string.updates_allow_install
                    )
                )
            }
        state.suitable ->
            Button(onClick = download) { Text(stringResource(R.string.updates_download)) }
        else ->
            Button(onClick = check, enabled = state.check != UpdateCheck.Checking) {
                Text(stringResource(R.string.updates_check))
            }
    }
    if (state.problem != null && state.suitable && state.transfer != UpdateTransfer.Downloading)
        ActionText(
            stringResource(R.string.updates_check),
            check,
            state.check != UpdateCheck.Checking,
        )
}

@Composable
private fun ActionText(label: String, action: () -> Unit, enabled: Boolean = true) {
    TextButton(
        onClick = action,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(label)
    }
}
