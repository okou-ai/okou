package ai.okou.android.connectors

import ai.okou.android.R
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
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
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val expiration = policy.expiresAt
    val now by
        produceState(Clock.System.now(), expiration, outlined) {
            if (outlined && expiration != null) {
                value = Clock.System.now()
                while (value < expiration) {
                    delay(minOf(1.minutes, expiration - value))
                    value = Clock.System.now()
                }
            }
        }
    val allowed = policy.enabled && (!outlined || expiration == null || expiration > now)
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
                val remaining = expiration - Clock.System.now()
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
    val semantics = modifier.semantics { contentDescription = description }
    Box {
        if (outlined) {
            Column(Modifier.widthIn(max = 164.dp)) {
                if (expiration != null && duration != null)
                    Text(
                        if (allowed)
                            stringResource(R.string.chat_connector_policy_remaining, duration)
                        else duration,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = connectorFeedbackType(),
                    )
                OutlinedButton(
                    onClick = { expanded = true },
                    enabled = enabled,
                    modifier = semantics.heightIn(min = 56.dp),
                    shape = MaterialTheme.shapes.extraSmall,
                    contentPadding = PaddingValues(horizontal = 12.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (expiration == null) label else status,
                            Modifier.weight(1f, fill = false),
                        )
                        Icon(painterResource(R.drawable.ic_expand_more), null, Modifier.size(16.dp))
                    }
                }
            }
        } else {
            TextButton(
                onClick = { expanded = true },
                enabled = enabled,
                modifier = semantics,
            ) {
                Text(label)
                Icon(painterResource(R.drawable.ic_expand_more), null, Modifier.size(16.dp))
            }
        }
        DropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            for (choice in policyChoices) {
                if (choice == ConnectorAccountPolicyRequestPolicy.DENY) HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(stringResource(choice.menuLabel())) },
                    onClick = {
                        expanded = false
                        update(choice)
                    },
                )
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
