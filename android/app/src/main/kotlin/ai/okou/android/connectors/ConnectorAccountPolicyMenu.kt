package ai.okou.android.connectors

import ai.okou.android.R
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlin.time.Clock
import kotlin.time.DurationUnit

@Composable
internal fun ConnectorAccountPolicyMenu(
    account: ConnectorSavedAccount,
    policy: ConnectorMemberPolicy,
    enabled: Boolean,
    update: (ConnectorAccountPolicyRequestPolicy) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val status =
        stringResource(
            if (policy.enabled) R.string.connector_access_allow else R.string.connector_access_deny,
        )
    val expiration = policy.expiresAt
    val duration =
        when {
            expiration == null && policy.enabled -> stringResource(R.string.connector_access_always)
            expiration == null -> null
            !policy.enabled -> stringResource(R.string.connector_access_expired)
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
    Box {
        TextButton(
            onClick = { expanded = true },
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = description },
        ) {
            Text(label)
            Icon(painterResource(R.drawable.ic_expand_more), null, Modifier.size(16.dp))
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
