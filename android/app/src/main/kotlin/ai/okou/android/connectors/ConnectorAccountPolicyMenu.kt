package ai.okou.android.connectors

import ai.okou.android.R
import ai.okou.android.SettingsTrigger
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.okouFormInputStyle
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.roundToInt
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.time.DurationUnit
import kotlinx.coroutines.delay

@Composable
internal fun ConnectorAccountPolicyMenu(
    account: ConnectorSavedAccount,
    policy: ConnectorMemberPolicy,
    enabled: Boolean,
    update: (ConnectorAccountPolicyRequestPolicy) -> Unit,
    outlined: Boolean = false,
) {
    val expiration = policy.expiresAt
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val now by
        produceState(Clock.System.now(), expiration, lifecycle) {
            if (expiration != null) {
                lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                    value = Clock.System.now()
                    while (value < expiration) {
                        delay(minOf(1.minutes, expiration - value))
                        value = Clock.System.now()
                    }
                }
            }
        }
    val allowed = policy.enabled && (expiration == null || expiration > now)
    val status =
        stringResource(
            if (allowed) R.string.connector_access_allow else R.string.connector_access_deny,
        )
    val duration =
        when {
            expiration == null && allowed -> stringResource(R.string.connector_access_always)
            expiration == null -> null
            !allowed -> stringResource(R.string.connector_access_expired)
            outlined -> {
                val minutes = (expiration - now).inWholeMinutes.coerceAtLeast(1)
                val format =
                    MeasureFormat.getInstance(
                        LocalConfiguration.current.locales[0],
                        MeasureFormat.FormatWidth.WIDE,
                    )
                if (minutes < 60) format.formatMeasures(Measure(minutes, MeasureUnit.MINUTE))
                else
                    format.formatMeasures(
                        Measure(minutes / 60, MeasureUnit.HOUR),
                        Measure(minutes % 60, MeasureUnit.MINUTE),
                    )
            }
            else -> {
                val remaining = expiration - now
                val hours = remaining.toDouble(DurationUnit.HOURS).roundToInt()
                when {
                    hours < 1 -> stringResource(R.string.connector_access_under_hour)
                    hours > 24 ->
                        stringResource(
                            R.string.connector_access_days,
                            remaining.toDouble(DurationUnit.DAYS).roundToInt(),
                        )
                    else -> stringResource(R.string.connector_access_hours, hours)
                }
            }
        }
    val label = if (duration == null) status else "$status $duration"
    val description = stringResource(R.string.connector_access_label, account.label(), label)
    val semantics = Modifier.semantics { contentDescription = description }
    Box {
        SettingsTrigger(
            enabled = enabled,
            content = { dismiss ->
                WorkspaceMenu(
                    items =
                        policyChoices.map { choice ->
                            WorkspaceMenuItem(stringResource(choice.menuLabel())) {
                                dismiss()
                                update(choice)
                            }
                        },
                    close = dismiss,
                    separatorBefore = policyChoices.lastIndex,
                )
            },
        ) { trigger, open ->
            if (!outlined) {
                TextButton(onClick = open, enabled = enabled, modifier = trigger.then(semantics)) {
                    Text(label)
                    Icon(painterResource(R.drawable.ic_expand_more), null, Modifier.size(16.dp))
                }
                return@SettingsTrigger
            }
            val colors = MaterialTheme.colorScheme
            var focused by remember { mutableStateOf(false) }
            Column(Modifier.width(144.dp)) {
                if (expiration != null && duration != null)
                    Text(
                        if (allowed)
                            stringResource(R.string.chat_connector_policy_remaining, duration)
                        else duration,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = connectorFeedbackType(),
                    )
                OutlinedButton(
                    onClick = open,
                    enabled = enabled,
                    modifier =
                        trigger
                            .then(semantics)
                            .fillMaxWidth()
                            .heightIn(min = OutlinedTextFieldDefaults.MinHeight)
                            .onFocusChanged { focused = it.isFocused },
                    shape = OutlinedTextFieldDefaults.shape,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface),
                    border =
                        when {
                            !enabled -> BorderStroke(1.dp, colors.onSurface.copy(alpha = 0.12f))
                            focused -> BorderStroke(2.dp, colors.primary)
                            else -> BorderStroke(1.dp, colors.outline)
                        },
                    contentPadding = OutlinedTextFieldDefaults.contentPaddingWithoutLabel(),
                ) {
                    Text(
                        if (expiration == null) label else status,
                        Modifier.weight(1f),
                        style = okouFormInputStyle(),
                    )
                    Spacer(Modifier.size(8.dp))
                    Icon(
                        painterResource(R.drawable.ic_expand_more),
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = if (enabled) colors.onSurfaceVariant else LocalContentColor.current,
                    )
                }
            }
        }
    }
}

private val policyChoices =
    listOf(
        ConnectorAccountPolicyRequestPolicy.ALLOW_ALWAYS,
        ConnectorAccountPolicyRequestPolicy.ALLOW_1H,
        ConnectorAccountPolicyRequestPolicy.ALLOW_24H,
        ConnectorAccountPolicyRequestPolicy.ALLOW_7D,
        ConnectorAccountPolicyRequestPolicy.DENY,
    )

private fun ConnectorAccountPolicyRequestPolicy.menuLabel() =
    when (this) {
        ConnectorAccountPolicyRequestPolicy.ALLOW_ALWAYS -> R.string.connector_access_allow_always
        ConnectorAccountPolicyRequestPolicy.ALLOW_1H -> R.string.connector_access_allow_hour
        ConnectorAccountPolicyRequestPolicy.ALLOW_24H -> R.string.connector_access_allow_day
        ConnectorAccountPolicyRequestPolicy.ALLOW_7D -> R.string.connector_access_allow_week
        ConnectorAccountPolicyRequestPolicy.DENY -> R.string.connector_access_deny
    }
