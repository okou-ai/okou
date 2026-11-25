package ai.okou.android.settings

import ai.okou.android.ContentReadProgress
import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.SettingsTrigger
import ai.okou.android.WorkspaceFeedbackHost
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState

@Composable
internal fun EmailSubscriptionSetting(
    model: EmailSubscriptionSettings?,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
    openAccount: () -> Unit,
) {
    val title = stringResource(R.string.settings_email_updates)
    SettingsTrigger(
        enabled = model != null,
        content = { dismiss ->
            if (model != null) {
                EmailSubscriptionSheet(title, model, snackbar, onFeedbackInOverlay, dismiss) {
                    dismiss()
                    openAccount()
                }
            }
        },
    ) { modifier, open ->
        SettingsRow(
            title,
            leading = { SettingsIcon(R.drawable.ic_mail) },
            modifier = modifier,
            onClick = open,
            enabled = model != null,
        )
    }
}

@Composable
private fun EmailSubscriptionSheet(
    title: String,
    model: EmailSubscriptionSettings,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
    dismiss: () -> Unit,
    openAccount: () -> Unit,
) {
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    val state by model.state.collectAsStateWithLifecycle()
    val routeFeedback by rememberUpdatedState(onFeedbackInOverlay)
    DisposableEffect(model, active) {
        model.visible(active)
        onDispose { model.visible(false) }
    }
    DisposableEffect(Unit) {
        routeFeedback(true)
        onDispose { routeFeedback(false) }
    }
    SettingsSheet(
        title = title,
        onDismiss = dismiss,
        modifier = Modifier.animateContentSize(alignment = Alignment.BottomCenter),
        titleInset = 8.dp,
        progress = {
            if (state.read.refreshing) {
                ContentReadProgress(
                    R.string.settings_email_refreshing,
                    background = MaterialTheme.colorScheme.surface,
                )
            }
        },
        actions =
            if (snackbar.currentSnackbarData != null) {
                { WorkspaceFeedbackHost(snackbar, Modifier) }
            } else null,
    ) {
        val indentation = Modifier.padding(horizontal = 8.dp)
        SettingsDetailStatus(stringResource(R.string.settings_email_scope), indentation)
        val confirmed = state.read.value
        when {
            state.read.initialFailure ->
                SettingsDetailStatus(
                    stringResource(R.string.settings_email_load_failed),
                    indentation,
                )
            confirmed == null ->
                SettingsPlaceholder(stringResource(R.string.settings_email_refreshing))
            else -> {
                SettingsGroup {
                    SettingsSwitchRow(
                        stringResource(R.string.settings_email_receive),
                        leading = { SettingsIcon(R.drawable.ic_mail) },
                        checked = state.checked,
                        onCheckedChange = if (state.canChange) model::subscribe else null,
                        supportingText = confirmed.email,
                    )
                }
                if (!confirmed.canReceive) {
                    SettingsDetailStatus(
                        stringResource(R.string.settings_email_unavailable),
                        indentation,
                    )
                    TextButton(
                        onClick = openAccount,
                        colors =
                            ButtonDefaults.textButtonColors(
                                contentColor = MaterialTheme.colorScheme.onSurface,
                            ),
                    ) {
                        Text(stringResource(R.string.settings_email_check_address))
                    }
                } else if (state.read.unavailable) {
                    SettingsDetailStatus(
                        stringResource(R.string.settings_email_refresh_failed),
                        indentation,
                    )
                }
            }
        }
    }
}
