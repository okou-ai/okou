package ai.okou.android.settings

import ai.okou.android.BuildConfig
import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsSection
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.RecoveryBillingCreditBreakdownItemCategory
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.state.SettingsDestination
import android.icu.util.Calendar
import android.widget.Toast
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLocale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import java.text.DateFormat
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.time.Instant
import okhttp3.HttpUrl.Companion.toHttpUrl

@Composable
internal fun WorkspaceSettingsDataPage(
    destination: SettingsDestination,
    workspace: String,
    model: WorkspaceSettingsModel,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    DisposableEffect(model, destination, active) {
        model.visible(destination.takeIf { active })
        onDispose { model.visible(null) }
    }
    when (destination) {
        SettingsDestination.ModelAccounts -> ModelAccounts(workspace, state, model::activate)
        SettingsDestination.CreditBalance ->
            CreditBalance(workspace, state, model.showWorkspaceCredits)
        else -> Unit
    }
}

@Composable
internal fun SettingsWebAction(label: String, section: String) {
    TextButton(
        onClick = settingsWebClick(section),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun settingsWebClick(section: String): () -> Unit {
    val browser = LocalUriHandler.current
    val context = LocalContext.current
    return {
        val url =
            BuildConfig.WEB_ORIGIN.toHttpUrl()
                .newBuilder()
                .addQueryParameter("settings", section)
                .build()
        try {
            browser.openUri(url.toString())
        } catch (_: IllegalArgumentException) {
            Toast.makeText(context, R.string.artifact_browser_unavailable, Toast.LENGTH_LONG).show()
        }
    }
}

@Composable
private fun SettingsDetailStatus(text: String) {
    Text(
        text,
        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun SettingsPageIntro(workspace: String, @StringRes scope: Int, @StringRes status: Int?) {
    val text =
        if (status == null) stringResource(scope, workspace)
        else stringResource(R.string.settings_workspace_status, workspace, stringResource(status))
    SettingsDetailStatus(text)
}

@Composable
private fun SettingsPlaceholder() {
    SettingsGroup {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            for (width in listOf(144.dp, 94.dp)) {
                Box(
                    Modifier.width(width)
                        .height(16.dp)
                        .background(
                            MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(4.dp),
                        )
                )
            }
        }
    }
}

@Composable
private fun ModelAccounts(
    workspace: String,
    state: WorkspaceSettingsState,
    activateAccount: (String) -> Unit,
) {
    val accounts = state.accounts.value
    val status =
        when {
            state.offline && accounts?.isEmpty() == true ->
                R.string.settings_accounts_offline_connect
            state.offline -> R.string.settings_accounts_offline
            state.accounts.unavailable && accounts != null ->
                R.string.settings_accounts_update_failed
            else -> null
        }
    val scope =
        if (accounts?.isEmpty() == true) R.string.settings_accounts_scope_empty
        else R.string.settings_accounts_scope
    SettingsPageIntro(workspace, scope, status)
    when {
        accounts == null && (state.accounts.unavailable || state.offline) ->
            SettingsDetailStatus(stringResource(R.string.settings_accounts_unavailable))
        accounts == null ->
            ModelAccountProvider.entries.forEach { provider ->
                SettingsSection(provider.name) { SettingsPlaceholder() }
            }
        accounts.isEmpty() -> {
            SettingsGroup {
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(min = 72.dp)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                ) {
                    Text(
                        stringResource(R.string.settings_accounts_empty),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    SettingsDetailStatus(stringResource(R.string.settings_accounts_empty_help))
                }
            }
            SettingsWebAction(stringResource(R.string.settings_accounts_web_connect), "model")
        }
        else -> {
            for (provider in ModelAccountProvider.entries) {
                val group = accounts.filter { it.provider == provider }
                SettingsSection(provider.name) {
                    SettingsGroup {
                        if (group.isEmpty()) {
                            Text(
                                stringResource(R.string.settings_account_not_connected),
                                Modifier.padding(16.dp).heightIn(min = 24.dp),
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        }
                        group.forEachIndexed { index, account ->
                            key(account.id) {
                                if (index > 0) HorizontalDivider()
                                ModelAccountRow(
                                    account,
                                    provider,
                                    index + 1,
                                    state.switching[provider] == account.id,
                                    state.offline,
                                    provider in state.switching,
                                    activateAccount,
                                )
                            }
                        }
                    }
                    if (provider in state.switchFailures) {
                        SettingsDetailStatus(
                            stringResource(R.string.settings_account_switch_failed)
                        )
                    }
                }
            }
            SettingsWebAction(stringResource(R.string.settings_accounts_web_manage), "model")
        }
    }
}

@Composable
private fun ModelAccountRow(
    account: RecoverySubscriptionsSubscriptionsItem,
    provider: ModelAccountProvider,
    index: Int,
    switching: Boolean,
    offline: Boolean,
    groupSwitching: Boolean,
    activateAccount: (String) -> Unit,
) {
    val name =
        account.accountEmail?.takeIf(String::isNotBlank)
            ?: account.workspaceName?.takeIf(String::isNotBlank)
            ?: stringResource(R.string.settings_model_account_fallback, index)
    val selection =
        when {
            account.isActive == true -> stringResource(R.string.settings_account_current)
            account.needsReconnect -> stringResource(R.string.settings_account_reconnect)
            switching -> stringResource(R.string.settings_account_switching)
            else -> stringResource(R.string.settings_account_select)
        }
    val isActive = account.isActive == true
    val showStacked = settingsDetailsStacked()
    val selectionStyle = MaterialTheme.typography.bodyMedium
    val selectionWeight = if (isActive) FontWeight.SemiBold else FontWeight.Normal
    Row(
        Modifier.fillMaxWidth()
            .semantics { if (groupSwitching) disabled() }
            .clickable(
                enabled = !offline && !account.needsReconnect,
                role = Role.Button,
                onClick = { if (!groupSwitching) activateAccount(account.id) },
            )
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyLarge)
            account.planType?.trim()?.takeIf(String::isNotEmpty)?.let {
                Text(
                    it.replaceFirstChar { letter -> letter.titlecase() },
                    style = selectionStyle,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (showStacked) Text(selection, style = selectionStyle, fontWeight = selectionWeight)
        }
        if (!showStacked) {
            Text(selection, style = selectionStyle, fontWeight = selectionWeight)
        }
    }

    Column(
        Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (account.needsReconnect) {
            SettingsWebAction(stringResource(R.string.settings_accounts_web_reconnect), "model")
        } else {
            val quotas = account.quotas()
            when {
                quotas.isEmpty() ->
                    SettingsDetailStatus(stringResource(R.string.settings_quota_unavailable))
                showStacked -> quotas.forEach { QuotaView(it, Modifier.fillMaxWidth()) }
                else ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        for (quota in quotas) QuotaView(quota, Modifier.weight(1f))
                    }
            }
            val providerCredits = account.subscriptionCredits
            if (providerCredits is CanonicalOptional.Present) {
                val credits = providerCredits.value
                val value =
                    when {
                        credits?.unlimited == true ->
                            stringResource(R.string.settings_credits_unlimited)
                        credits?.balance == null ->
                            stringResource(R.string.settings_credits_unavailable_value)
                        credits.balance > 0 && credits.balance < 0.01 ->
                            stringResource(R.string.settings_credits_less_than, formatBalance(0.01))
                        else -> formatBalance(credits.balance)
                    }
                SettingsDetailStatus(
                    stringResource(R.string.settings_provider_credit_balance, provider.name, value)
                )
            }
        }
    }
}

@Composable
private fun settingsDetailsStacked(): Boolean =
    currentWindowSizeDp().width < 360 || LocalDensity.current.fontScale > 1.3f

@Composable
private fun QuotaView(quota: ModelAccountQuota, modifier: Modifier) {
    val typography = MaterialTheme.typography
    val colors = MaterialTheme.colorScheme
    val locale = LocalLocale.current.platformLocale
    val seconds = quota.windowSeconds
    val label =
        when {
            seconds == 604_800.0 || seconds == null && quota.period == QuotaPeriod.Week ->
                stringResource(R.string.settings_weekly_quota)
            seconds != null && seconds >= 86_400 && seconds % 86_400 == 0.0 ->
                stringResource(R.string.settings_day_quota, (seconds / 86_400).toInt())
            seconds != null && seconds >= 3_600 && seconds % 3_600 == 0.0 ->
                stringResource(R.string.settings_hour_quota, (seconds / 3_600).toInt())
            seconds == null && quota.period == QuotaPeriod.Short ->
                stringResource(R.string.settings_hour_quota, 5)
            else -> stringResource(R.string.settings_quota)
        }
    val remaining = quota.remaining
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, Modifier.weight(1f), style = typography.bodyMedium)
            if (remaining != null) {
                val percent =
                    NumberFormat.getPercentInstance(locale)
                        .apply { maximumFractionDigits = 1 }
                        .format(remaining / 100)
                Text(
                    percent,
                    style = typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        if (remaining != null) {
            LinearProgressIndicator(
                progress = { (remaining / 100).toFloat() },
                modifier =
                    Modifier.fillMaxWidth().height(4.dp).semantics { contentDescription = label },
                color = colors.primary,
                trackColor = colors.outlineVariant,
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
        }
        if (quota.resetAt != null) {
            Text(
                resetLabel(quota.resetAt, locale),
                style = typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                color = colors.onSurfaceVariant,
            )
        } else if (remaining == null) {
            SettingsDetailStatus(stringResource(R.string.settings_quota_unavailable))
        }
    }
}

@Composable
private fun resetLabel(value: Instant, locale: Locale): String {
    val resetAt = Date(value.toEpochMilliseconds())
    val calendar = Calendar.getInstance(locale)
    val today = calendar.get(Calendar.JULIAN_DAY)
    calendar.time = resetAt
    val days = calendar.get(Calendar.JULIAN_DAY) - today
    val time = DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(resetAt)
    return when {
        days == 0 -> stringResource(R.string.settings_quota_resets_today, time)
        days in 1..6 ->
            stringResource(
                R.string.settings_quota_resets,
                SimpleDateFormat("EEE", locale).format(resetAt),
                time,
            )
        else ->
            stringResource(
                R.string.settings_quota_resets,
                DateFormat.getDateInstance(DateFormat.SHORT, locale).format(resetAt),
                time,
            )
    }
}

@Composable
private fun CreditBalance(
    workspace: String,
    state: WorkspaceSettingsState,
    showWorkspaceCredits: Boolean,
) {
    val member = state.usagePack.value
    val shared = state.workspaceCredits.value
    val status =
        when {
            state.offline && (member != null || shared != null) -> R.string.settings_credit_offline
            state.usagePack.unavailable && member != null ||
                state.workspaceCredits.unavailable && shared != null ->
                R.string.settings_credit_update_failed
            else -> null
        }
    SettingsPageIntro(workspace, R.string.settings_credit_scope, status)
    SettingsSection(stringResource(R.string.settings_credit_member)) {
        if (member != null) {
            CreditCard(
                member.totalCredits,
                listOf(
                    stringResource(R.string.settings_credit_purchased) to member.purchasedCredits,
                    stringResource(R.string.settings_credit_bonus) to member.bonusCredits,
                ),
            )
        } else CreditReadState(state.offline || state.usagePack.unavailable)
    }
    if (showWorkspaceCredits) {
        SettingsSection(stringResource(R.string.settings_credit_workspace)) {
            if (shared != null) {
                CreditCard(
                    shared.credits,
                    shared.creditBreakdown.map { item ->
                        val label =
                            when (item.category) {
                                RecoveryBillingCreditBreakdownItemCategory.PLAN ->
                                    R.string.settings_credit_plan
                                RecoveryBillingCreditBreakdownItemCategory.FREE ->
                                    R.string.settings_credit_free
                                RecoveryBillingCreditBreakdownItemCategory.PROMOTIONAL ->
                                    R.string.settings_credit_bonus
                                RecoveryBillingCreditBreakdownItemCategory.PAYASYOUGO ->
                                    R.string.settings_credit_top_up
                            }
                        stringResource(label) to item.credits
                    },
                )
            } else CreditReadState(state.offline || state.workspaceCredits.unavailable)
        }
    }
    SettingsWebAction(stringResource(R.string.settings_credit_web), "usage")
}

@Composable
private fun CreditReadState(unavailable: Boolean) {
    if (unavailable) {
        SettingsGroup {
            Box(Modifier.padding(16.dp)) {
                SettingsDetailStatus(stringResource(R.string.settings_credit_unavailable))
            }
        }
    } else SettingsPlaceholder()
}

@Composable
private fun CreditCard(balance: Number, breakdown: List<Pair<String, Number>>) {
    val typography = MaterialTheme.typography
    SettingsGroup {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    formatBalance(balance),
                    Modifier.weight(1f, fill = false),
                    style =
                        typography.headlineSmall.copy(
                            fontSize = 24.sp,
                            lineHeight = 32.sp,
                            fontFeatureSettings = "tnum",
                        ),
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    stringResource(R.string.settings_credit_unit),
                    Modifier.padding(bottom = 2.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = typography.bodyMedium,
                )
            }
            breakdown.forEach { (label, value) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(label, Modifier.weight(1f), style = typography.bodyMedium)
                    Text(
                        formatBalance(value),
                        style = typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                    )
                }
            }
        }
    }
}

@Composable
private fun formatBalance(value: Number): String =
    NumberFormat.getNumberInstance(LocalLocale.current.platformLocale)
        .apply { maximumFractionDigits = 2 }
        .format(value)
