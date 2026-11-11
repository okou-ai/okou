package ai.okou.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
fun SettingsScreen(
    state: AppearanceUiState,
    selectMode: (AppearanceMode) -> Unit,
    retry: () -> Unit,
) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 760.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                stringResource(R.string.appearance),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                stringResource(R.string.appearance_description),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Column(Modifier.fillMaxWidth().selectableGroup()) {
                AppearanceMode.entries.forEach { mode ->
                    val label =
                        stringResource(
                            when (mode) {
                                AppearanceMode.System -> R.string.appearance_system
                                AppearanceMode.Light -> R.string.appearance_light
                                AppearanceMode.Dark -> R.string.appearance_dark
                            }
                        )
                    Row(
                        Modifier.fillMaxWidth()
                            .sizeIn(minHeight = 56.dp)
                            .selectable(
                                selected = state.mode == mode,
                                enabled = state.canSelect,
                                role = Role.RadioButton,
                                onClick = { selectMode(mode) },
                            )
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = state.mode == mode,
                            onClick = null,
                            enabled = state.canSelect,
                            colors =
                                RadioButtonDefaults.colors(
                                    selectedColor = MaterialTheme.colorScheme.onSurface
                                ),
                        )
                        Text(label, Modifier.padding(start = 16.dp).weight(1f))
                    }
                }
            }
            AppearanceFeedback(state.status, retry)
            HorizontalDivider()
            Text(
                stringResource(R.string.on_this_device),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                stringResource(R.string.appearance_local),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AppearanceFeedback(status: AppearanceStatus, retry: () -> Unit) {
    val message =
        when (status) {
            AppearanceStatus.Ready -> return
            AppearanceStatus.Loading -> R.string.appearance_loading
            is AppearanceStatus.Saving,
            is AppearanceStatus.AwaitingConfirmation -> R.string.appearance_saving
            AppearanceStatus.ReadFailed -> R.string.appearance_read_failed
            is AppearanceStatus.WriteFailed -> R.string.appearance_write_failed
        }
    val failed = status == AppearanceStatus.ReadFailed || status is AppearanceStatus.WriteFailed
    Column(
        Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (!failed) LinearProgressIndicator(Modifier.fillMaxWidth())
        Text(
            stringResource(message),
            color =
                if (failed) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (failed) TextButton(onClick = retry) { Text(stringResource(R.string.retry)) }
    }
}
