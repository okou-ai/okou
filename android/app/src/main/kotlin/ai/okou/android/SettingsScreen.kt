package ai.okou.android

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun SettingsPage(scroll: ScrollState, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().imePadding()) {
        HorizontalDivider()
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.widthIn(max = 768.dp)
                    .fillMaxWidth()
                    .verticalScroll(scroll)
                    .padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                content()
            }
        }
    }
}

@Composable
internal fun SettingsScreen(
    state: AppearanceUiState,
    selectMode: (AppearanceMode) -> Unit,
    retry: () -> Unit,
    appUpdates: @Composable (() -> Unit)? = null,
    workspacePreferences: @Composable () -> Unit = {},
    workspace: @Composable () -> Unit = {},
    account: @Composable () -> Unit = {},
) {
    SettingsSection(stringResource(R.string.on_this_device)) {
        SettingsGroup {
            val title = stringResource(R.string.appearance)
            SettingsPickerRow(
                title,
                value = stringResource(appearanceLabel(state.mode)),
                leading = { SettingsIcon(R.drawable.ic_settings_appearance) },
                enabled = state.canSelect,
            ) { dismiss ->
                SettingsSheet(title, dismiss) {
                    SettingsRadioOptions(
                        options = AppearanceMode.entries,
                        selected = state.mode,
                        label = ::appearanceLabel,
                        enabled = state.canSelect,
                    ) { target ->
                        dismiss()
                        selectMode(target)
                    }
                    Text(
                        stringResource(R.string.appearance_local),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            if (appUpdates != null) {
                HorizontalDivider()
                appUpdates()
            }
        }
        AppearanceFeedback(state.status, retry)
    }
    workspacePreferences()
    workspace()
    account()
}

private fun appearanceLabel(mode: AppearanceMode): Int =
    when (mode) {
        AppearanceMode.System -> R.string.appearance_system
        AppearanceMode.Light -> R.string.appearance_light
        AppearanceMode.Dark -> R.string.appearance_dark
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
        if (!failed) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        Text(
            stringResource(message),
            color =
                if (failed) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (failed) {
            TextButton(
                onClick = retry,
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
