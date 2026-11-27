package ai.okou.android.settings

import ai.okou.android.ContentReadFailureLayout
import ai.okou.android.ContentReadProgress
import ai.okou.android.PaneFeedback
import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.SettingsTrigger
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
import androidx.compose.runtime.remember
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
    openAccount: () -> Unit,
) {
    val title = stringResource(R.string.settings_email_updates)
    SettingsTrigger(
        enabled = model != null,
        content = { dismiss ->
            if (model != null) {
                EmailSubscriptionSheet(title, model, dismiss, openAccount)
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
    dismiss: () -> Unit,
    openAccount: () -> Unit,
) {
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    val state by model.state.collectAsStateWithLifecycle()
    val snackbar = remember(model) { SnackbarHostState() }
    PaneFeedback(
        listOf(
            settingsRefreshError(
                snackbar,
                state.read.refreshFailure,
                R.string.settings_email_refresh_failed,
                model::dismissRefreshFailure,
            ),
        ),
    )
    fun close() {
        model.setPanelOpen(false)
        dismiss()
    }
    DisposableEffect(model) {
        model.setPanelOpen(true)
        onDispose { model.setPanelOpen(false) }
    }
    DisposableEffect(model, active) {
        model.visible(active)
        onDispose { model.visible(false) }
    }
    SettingsSheet(
        title = title,
        onDismiss = ::close,
        modifier = Modifier.animateContentSize(alignment = Alignment.BottomCenter),
        titleInset = 8.dp,
        snackbar = snackbar,
        progress = {
            ContentReadProgress(R.string.settings_email_refreshing, visible = state.read.refreshing)
        },
    ) {
        val indentation = Modifier.padding(horizontal = 8.dp)
        SettingsDetailStatus(stringResource(R.string.settings_email_scope), indentation)
        val confirmed = state.read.value
        when {
            state.read.initialFailure -> SettingsReadError(ContentReadFailureLayout.Panel)
            confirmed == null -> {
                SettingsPlaceholder(stringResource(R.string.settings_email_refreshing)) {
                    EmailSubscriptionSwitch(checked = null, email = "", onCheckedChange = null)
                }
            }
            else -> {
                SettingsGroup {
                    EmailSubscriptionSwitch(
                        checked = state.checked,
                        email = confirmed.email,
                        onCheckedChange = if (state.canChange) model::subscribe else null,
                    )
                }
            }
        }
        EmailSubscriptionFeedback(state, indentation)
        val colors = MaterialTheme.colorScheme
        if (confirmed != null) {
            if (!confirmed.canReceive) {
                SettingsDetailStatus(
                    stringResource(R.string.settings_email_unavailable),
                    indentation,
                )
                TextButton(
                    onClick = {
                        close()
                        openAccount()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
                ) {
                    Text(stringResource(R.string.settings_email_check_address))
                }
            }
        }
    }
}

@Composable
private fun EmailSubscriptionSwitch(
    checked: Boolean?,
    email: String?,
    onCheckedChange: ((Boolean) -> Unit)?,
) {
    SettingsSwitchRow(
        stringResource(R.string.settings_email_receive),
        leading = { SettingsIcon(R.drawable.ic_mail) },
        checked = checked,
        onCheckedChange = onCheckedChange,
        supportingText = email,
    )
}

@Composable
private fun EmailSubscriptionFeedback(state: EmailSubscriptionState, modifier: Modifier) {
    val saving = stringResource(R.string.settings_email_saving)
    val failed = stringResource(R.string.settings_email_save_failed)
    val status =
        when {
            state.updateFailed -> failed
            state.desired != null -> saving
            else -> ""
        }
    val colors = MaterialTheme.colorScheme
    SettingsWriteStatus(
        status,
        listOf(saving, failed),
        modifier,
        color = if (state.updateFailed) colors.error else colors.onSurfaceVariant,
    )
}
