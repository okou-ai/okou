package ai.okou.android.settings

import ai.okou.android.BuildConfig
import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFailureLayout
import ai.okou.android.ContentReadProgress
import ai.okou.android.PaneFeedback
import ai.okou.android.PaneFeedbackError
import ai.okou.android.PaneFeedbackMessage
import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsSection
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.RecoveryBillingCreditBreakdownItemCategory
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.preferences.memberPreferenceSaveError
import ai.okou.android.rememberContentReadSkeleton
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
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLocale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
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
internal fun WorkspaceSettingsProgress(
    destination: SettingsDestination,
    model: WorkspaceSettingsModel,
) {
    val label =
        when (destination) {
            SettingsDestination.ModelAccounts -> R.string.settings_refreshing_model_accounts
            SettingsDestination.CreditBalance -> R.string.settings_refreshing_credit_balance
            else -> return
        }
    val state by model.uiState.collectAsStateWithLifecycle()
    val refreshing =
        when (destination) {
            SettingsDestination.ModelAccounts -> state.accounts.refreshing
            else -> state.usagePack.refreshing || state.workspaceCredits.refreshing
        }
    key(model, destination) {
        ContentReadProgress(label, visible = refreshing)
    }
}

@Composable
internal fun WorkspaceSettingsFeedback(
    model: WorkspaceSettingsModel,
    preferences: MemberPreferencesModel,
    snackbar: SnackbarHostState,
    destination: SettingsDestination,
) {
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    SideEffect { model.visible(destination.takeIf { active }) }
    DisposableEffect(model) {
        onDispose { model.visible(null) }
    }
    if (!active) return

    val state by model.uiState.collectAsStateWithLifecycle()
    val defaultModel by model.defaultModel.state.collectAsStateWithLifecycle()
    val tools = model.builtInTools
    val proactive = model.proactive
    val refreshError =
        when (destination) {
            SettingsDestination.ModelAccounts ->
                settingsRefreshError(
                    snackbar,
                    state.accounts.refreshFailure,
                    R.string.settings_accounts_update_failed,
                    model::dismissRefreshFailure,
                )
            SettingsDestination.CreditBalance ->
                settingsRefreshError(
                    snackbar,
                    state.creditRefreshFailure,
                    R.string.settings_credit_unavailable,
                    model::dismissRefreshFailure,
                )
            SettingsDestination.Overview ->
                settingsRefreshError(
                    snackbar,
                    defaultModel.settingsCatalogRefreshFailure,
                    R.string.settings_model_catalog_refresh_failed,
                    model.defaultModel::dismissCatalogFailure,
                )
            SettingsDestination.BuiltInTools ->
                tools?.let {
                    val toolsState by it.state.collectAsStateWithLifecycle()
                    settingsRefreshError(
                        snackbar,
                        toolsState.catalog.refreshFailure,
                        R.string.settings_tools_unavailable,
                        it::dismissCatalogFailure,
                    )
                }
            else -> null
        }
    val proactiveFailure =
        if (destination == SettingsDestination.ProactiveServices && proactive != null)
            proactive.saveFailures.collectAsStateWithLifecycle().value.firstOrNull()
        else null
    PaneFeedback(
        errors =
            listOf(
                refreshError,
                state.actionFailures.firstOrNull()?.let { receipt ->
                    PaneFeedbackError(receipt.order) {
                        PaneFeedbackMessage(
                            snackbar,
                            receipt,
                            stringResource(receipt.value.message),
                        ) {
                            model.dismissActionFailure(receipt)
                        }
                    }
                },
                defaultModel.saveFeedback?.let { receipt ->
                    PaneFeedbackError(receipt.order) {
                        PaneFeedbackMessage(
                            snackbar,
                            receipt,
                            stringResource(R.string.settings_model_save_rolled_back),
                        ) {
                            model.defaultModel.dismissSaveFailure(receipt)
                        }
                    }
                },
                proactiveFailure?.let { receipt ->
                    PaneFeedbackError(receipt.order) {
                        PaneFeedbackMessage(
                            snackbar,
                            receipt,
                            stringResource(receipt.value.message),
                        ) {
                            proactive?.dismissSaveFailure(receipt)
                        }
                    }
                },
                memberPreferenceSaveError(preferences, snackbar),
            ),
    )
}

private val SettingsNotice.message: Int
    get() =
        when (this) {
            SettingsNotice.ModelAccountSwitchFailed -> R.string.settings_account_switch_failed
            SettingsNotice.EmailSubscriptionFailed -> R.string.settings_email_save_failed
            SettingsNotice.ImageModelSaveFailed -> R.string.settings_tool_image_save_failed
            SettingsNotice.ToolSaveFailed -> R.string.settings_preferences_save_rolled_back
            SettingsNotice.ToolSaveUnconfirmed -> R.string.settings_tool_save_failed
        }

private val ProactiveSetting.message: Int
    get() =
        when (this) {
            ProactiveSetting.MorningBrief -> R.string.settings_morning_brief_save_failed
            ProactiveSetting.Suggestions -> R.string.settings_suggestions_save_failed
        }

internal fun settingsRefreshError(
    snackbar: SnackbarHostState,
    failure: SettingsRefreshFailure?,
    @StringRes message: Int,
    dismiss: (SettingsRefreshFailure) -> Unit,
): PaneFeedbackError? = failure?.let {
    PaneFeedbackError(it.order) {
        PaneFeedbackMessage(snackbar, it, stringResource(message)) { dismiss(it) }
    }
}

@Composable
internal fun WorkspaceSettingsDataPage(
    destination: SettingsDestination,
    workspace: String,
    model: WorkspaceSettingsModel,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    when (destination) {
        SettingsDestination.ModelAccounts -> ModelAccounts(workspace, state, model::activate)
        SettingsDestination.CreditBalance -> CreditBalance(workspace, state)
        else -> Unit
    }
}

@Composable
internal fun SettingsWebAction(label: String, section: String) {
    TextButton(
        onClick = settingsWebClick(section),
        colors =
            ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
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
internal fun SettingsDetailStatus(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(
        text,
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = color,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
internal fun SettingsWriteStatus(
    text: String,
    messages: List<String>,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    val style = MaterialTheme.typography.bodyMedium
    val textMeasurer = rememberTextMeasurer(cacheSize = messages.size)
    SettingsDetailStatus(
        text,
        modifier.fillMaxWidth().layout { measurable, constraints ->
            val textConstraints = Constraints(maxWidth = constraints.maxWidth)
            val reservedHeight = messages.maxOf {
                textMeasurer.measure(it, style, constraints = textConstraints).size.height
            }
            val content = measurable.measure(constraints)
            val height = constraints.constrainHeight(maxOf(content.height, reservedHeight))
            layout(content.width, height) { content.placeRelative(0, 0) }
        },
        color = color,
    )
}

@Composable
internal fun SettingsReadError(
    failureLayout: ContentReadFailureLayout = ContentReadFailureLayout.Section,
) {
    ContentReadFailure(
        R.string.chat_list_first_load_failed,
        Modifier.fillMaxWidth(),
        failureLayout,
    )
}

@Composable
internal fun SettingsPlaceholder(
    loadingLabel: String? = null,
    layoutReference: (@Composable () -> Unit)? = null,
) {
    val visible = rememberContentReadSkeleton()
    val semantics =
        if (visible && loadingLabel != null)
            Modifier.semantics { contentDescription = loadingLabel }
        else Modifier
    Box(Modifier.alpha(if (visible) 1f else 0f).then(semantics)) {
        SettingsGroup {
            Box(contentAlignment = Alignment.CenterStart) {
                if (layoutReference != null) {
                    Box(Modifier.alpha(0f).clearAndSetSemantics { hideFromAccessibility() }) {
                        layoutReference()
                    }
                }
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (width in listOf(144.dp, 94.dp)) {
                        Box(
                            Modifier.width(width)
                                .height(14.dp)
                                .background(
                                    MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(8.dp),
                                ),
                        )
                    }
                }
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
    val scope =
        if (accounts?.isEmpty() == true) R.string.settings_accounts_scope_empty
        else R.string.settings_accounts_scope
    SettingsDetailStatus(stringResource(scope, workspace))
    when {
        accounts == null && state.accounts.unavailable -> SettingsReadError()
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
                                val switch = state.switching[provider]
                                ModelAccountRow(
                                    account,
                                    provider,
                                    index + 1,
                                    switch?.takeIf { it.accountId == account.id }?.phase,
                                    switch != null,
                                    activateAccount,
                                )
                            }
                        }
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
    switchPhase: AccountSwitchPhase?,
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
            switchPhase == AccountSwitchPhase.Unconfirmed ->
                stringResource(R.string.settings_account_switch_unconfirmed)
            switchPhase != null -> stringResource(R.string.settings_account_switching)
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
                enabled = !account.needsReconnect,
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
                    stringResource(R.string.settings_provider_credit_balance, provider.name, value),
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
            seconds != null && seconds >= 60 && seconds % 60 == 0.0 ->
                stringResource(R.string.settings_minute_quota, (seconds / 60).toInt())
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
                trackColor = colors.secondaryContainer,
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
) {
    val member = state.usagePack.value
    val shared = state.workspaceCredits.value
    SettingsDetailStatus(stringResource(R.string.settings_credit_scope, workspace))
    SettingsSection(stringResource(R.string.settings_credit_member)) {
        if (member != null) {
            CreditCard(
                member.totalCredits,
                listOf(
                    stringResource(R.string.settings_credit_purchased) to member.purchasedCredits,
                    stringResource(R.string.settings_credit_bonus) to member.bonusCredits,
                ),
            )
        } else CreditReadState(state.usagePack)
    }
    if (state.showWorkspaceCredits) {
        SettingsSection(stringResource(R.string.settings_credit_workspace)) {
            if (shared != null) {
                val byCategory =
                    shared.creditBreakdown
                        .groupingBy { it.category }
                        .fold(0.0) { credits, item -> credits + item.credits }
                CreditCard(
                    shared.credits,
                    byCategory.map { (category, credits) ->
                        val label =
                            when (category) {
                                RecoveryBillingCreditBreakdownItemCategory.PLAN ->
                                    R.string.settings_credit_plan
                                RecoveryBillingCreditBreakdownItemCategory.FREE ->
                                    R.string.settings_credit_free
                                RecoveryBillingCreditBreakdownItemCategory.PROMOTIONAL ->
                                    R.string.settings_credit_bonus
                                RecoveryBillingCreditBreakdownItemCategory.PAYASYOUGO ->
                                    R.string.settings_credit_top_up
                            }
                        stringResource(label) to credits
                    },
                )
            } else CreditReadState(state.workspaceCredits)
        }
    }
    SettingsWebAction(stringResource(R.string.settings_credit_web), "usage")
}

@Composable
private fun CreditReadState(state: SettingsRead<*>) {
    if (state.initialFailure) {
        SettingsReadError()
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
