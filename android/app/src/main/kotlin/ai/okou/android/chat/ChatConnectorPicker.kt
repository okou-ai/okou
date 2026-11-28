package ai.okou.android.chat

import ai.okou.android.ContentReadFailureLayout
import ai.okou.android.PaneReadAnnouncements
import ai.okou.android.R
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.connectors.ChatConnectorOptions
import ai.okou.android.connectors.ChatConnectorOverride
import ai.okou.android.connectors.ChatConnectorSavePhase
import ai.okou.android.connectors.ChatConnectorSummary
import ai.okou.android.connectors.ConnectorAccountPolicyMenu
import ai.okou.android.connectors.ConnectorAccountStatus
import ai.okou.android.connectors.ConnectorAccountTarget
import ai.okou.android.connectors.ConnectorButton
import ai.okou.android.connectors.ConnectorButtonTreatment
import ai.okou.android.connectors.ConnectorChevron
import ai.okou.android.connectors.ConnectorMark
import ai.okou.android.connectors.ConnectorNavigationRow
import ai.okou.android.connectors.ConnectorReadFailure
import ai.okou.android.connectors.ConnectorReadFailureContent
import ai.okou.android.connectors.ConnectorSavedAccount
import ai.okou.android.connectors.ConnectorSheet
import ai.okou.android.connectors.ConnectorSkeleton
import ai.okou.android.connectors.connectorBodyType
import ai.okou.android.connectors.connectorFeedbackType
import ai.okou.android.connectors.connectorSmallType
import ai.okou.android.connectors.label
import ai.okou.android.connectors.needsAttention
import ai.okou.android.connectors.notice
import ai.okou.android.connectors.rememberConnectorReadFeedback
import ai.okou.android.isShortSettingsPanelWindow
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.settings.DefaultModelSettings
import ai.okou.android.settings.ModelPickerSheet
import ai.okou.android.state.ComposerOptionsPage
import ai.okou.android.state.ComposerOptionsPresentation
import ai.okou.android.state.rememberComposerOptions
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatConnectorOptionsButton(
    options: ChatConnectorOptions?,
    composer: ChatComposerModel,
    composerState: ComposerState,
    target: ComposerTarget,
    editorFocused: Boolean,
    editorFocus: FocusRequester,
    manageConnectors: (ConnectorAccountTarget?) -> Unit,
    defaultModel: DefaultModelSettings? = null,
    conversationModel: ConversationModelControls? = null,
    conversationSnackbar: SnackbarHostState? = null,
    onOptionsFeedbackInOverlay: (Boolean) -> Unit = {},
    attachmentPickerActive: Boolean = false,
    pickAttachment: ((photos: Boolean) -> Unit)? = null,
    buttonFocus: FocusRequester = remember { FocusRequester() },
) {
    var presentation by rememberComposerOptions(target.key)
    val entryFocus = remember { FocusRequester() }
    val modelFocus = remember { FocusRequester() }
    val accountFocus = remember { FocusRequester() }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val imeVisible = WindowInsets.isImeVisible
    var restoreTrigger by remember { mutableStateOf(false) }
    var restoreEntry by remember { mutableStateOf<ComposerOptionsPage?>(null) }
    var restoredAccount by remember { mutableStateOf<String?>(null) }
    var sheetGeneration by remember { mutableIntStateOf(0) }
    val overviewScroll = rememberScrollState()
    val readAnnouncements = remember(options, target.key) { PaneReadAnnouncements() }
    val page = presentation.page
    val open = page != ComposerOptionsPage.Closed
    val feedbackInOptions =
        conversationSnackbar != null &&
            (page == ComposerOptionsPage.Model || page == ComposerOptionsPage.Options)
    val routeFeedback by rememberUpdatedState(onOptionsFeedbackInOverlay)
    if (feedbackInOptions) {
        DisposableEffect(Unit) {
            routeFeedback(true)
            onDispose { routeFeedback(false) }
        }
    }
    DisposableEffect(defaultModel, open) {
        if (open) defaultModel?.showComposerOptions(true)
        onDispose { if (open) defaultModel?.showComposerOptions(false) }
    }
    LaunchedEffect(page, restoreTrigger, attachmentPickerActive) {
        if (
            page == ComposerOptionsPage.Closed &&
                (restoreTrigger || presentation.restoreEditor) &&
                !attachmentPickerActive
        ) {
            withFrameNanos {}
            if (presentation.restoreEditor) {
                editorFocus.requestFocus()
                if (presentation.restoreKeyboard) keyboard?.show()
            } else buttonFocus.requestFocus()
            restoreTrigger = false
            presentation = ComposerOptionsPresentation()
        }
    }

    IconButton(
        onClick = {
            presentation =
                ComposerOptionsPresentation(ComposerOptionsPage.Options, editorFocused, imeVisible)
            focus.clearFocus()
            keyboard?.hide()
        },
        modifier = Modifier.focusRequester(buttonFocus).size(48.dp).testTag("chat-options-button"),
    ) {
        Icon(
            painterResource(R.drawable.ic_add),
            stringResource(R.string.chat_options_title),
            modifier = Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    if (page == ComposerOptionsPage.Closed) return

    val modelState = defaultModel?.state?.collectAsStateWithLifecycle()?.value
    val catalog = modelState?.options
    val override = composerState.journal?.newChatModel.takeIf { conversationModel == null }
    val confirmed = conversationModel?.confirmed
    val edits = conversationModel?.edits
    val shown = remember(confirmed, edits) { confirmed?.withModelEdits(edits) }
    val selection =
        remember(override, modelState, shown) {
            shown?.modelSelection() ?: override ?: modelState?.draftDefaults()
        }
    val selectedId = catalog?.resolve(selection?.model) ?: selection?.model
    val choice = catalog?.choices?.firstOrNull { it.id == selectedId }
    val showModel =
        modelState != null &&
            (catalog == null || selectedId != null || catalog.choices.any { it.canSelect })
    val modelChoices =
        if (confirmed != null || modelState?.record != null && composerState.journal != null)
            catalog?.choices
        else null
    val modelEnabled =
        showModel &&
            modelChoices != null &&
            (conversationModel != null || composerState.canEditDraftModel(target))

    val showingOverview = page == ComposerOptionsPage.Connectors
    val showingAccounts = page == ComposerOptionsPage.ConnectorAccounts
    val showingConnectors = showingOverview || showingAccounts
    val state =
        options?.state?.collectAsStateWithLifecycle()?.value?.takeIf { it.target == target.key }
    SideEffect {
        readAnnouncements.retain(
            listOfNotNull(state?.overview?.failureRound) +
                state?.details.orEmpty().values.mapNotNull { it.accounts.failureRound },
        )
    }
    val overview = state?.overview
    val overviewData = overview?.data
    val overviewConfirmed = overview?.confirmedAt != null
    val slug = presentation.connectorSlug
    val summary = overviewData?.find { it.entry.slug == slug }
    val detail = state?.details?.get(slug)
    val reading = detail?.accounts
    val rows = reading?.data?.accounts
    val hasReadContent =
        showingOverview && overviewData != null ||
            showingAccounts && summary != null && rows != null
    val coldFailure =
        when {
            showingOverview && overviewData == null -> overview?.failure
            showingAccounts && (rows == null || summary == null) ->
                reading?.failure ?: overview?.failure.takeUnless { overviewConfirmed }
            else -> null
        }
    val readNotice =
        when {
            showingOverview && overviewData != null -> overview.notice()
            showingAccounts && summary != null && rows != null -> reading.notice()
            else -> null
        }
    val readFeedback =
        key(page, slug.takeIf { showingAccounts }) {
            rememberConnectorReadFeedback(readNotice, readAnnouncements)
        }
    val save = state?.save
    val saving = save?.saving == true
    var openingOverview by remember(options, target) { mutableStateOf(false) }
    var openingAccounts by remember(options, target) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(options, target, showingConnectors, saving, state?.revision, lifecycle) {
        if (showingConnectors && !saving && options != null && state != null)
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                options.showOverview(target, openingOverview)
                openingOverview = false
            }
    }
    LaunchedEffect(
        options,
        target,
        showingAccounts,
        saving,
        summary,
        overviewConfirmed,
        state?.revision,
        lifecycle,
    ) {
        if (showingAccounts && !saving && options != null && summary != null && overviewConfirmed)
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                options.showAccounts(target, summary.entry.slug, openingAccounts)
                openingAccounts = false
            }
    }

    fun returnToConnectorOverview() {
        restoreEntry = ComposerOptionsPage.ConnectorAccounts
        presentation =
            presentation.copy(page = ComposerOptionsPage.Connectors, returnAccount = null)
    }

    fun back() {
        if (saving) return
        options?.dismissFailure(target)
        when (page) {
            ComposerOptionsPage.ConnectorAccounts -> returnToConnectorOverview()
            ComposerOptionsPage.Connectors,
            ComposerOptionsPage.Model -> {
                restoreEntry = page
                presentation =
                    presentation.copy(
                        page = ComposerOptionsPage.Options,
                        returnAccount = null,
                        connectorSlug = null,
                    )
            }
            else -> {
                presentation = presentation.copy(page = ComposerOptionsPage.Closed)
                restoreTrigger = true
            }
        }
    }

    if (page == ComposerOptionsPage.Model && selection != null) {
        ModelPickerSheet(
            title = stringResource(R.string.chat_options_model),
            choices = modelChoices,
            selectedId = selectedId,
            effort = choice?.let { selection.effortFor(it) },
            fast = selection.fast && choice?.fastMultiplier != null,
            catalogUnavailable = catalog == null && modelState?.catalogUnavailable == true,
            select = { id ->
                val selectedChoice = modelChoices?.firstOrNull { it.id == id && it.canSelect }
                if (id == null || selectedChoice != null) {
                    if (conversationModel != null) {
                        if (id != selectedId)
                            conversationModel.chats.saveConversationModel(
                                conversationModel.confirmed.id,
                                id,
                                null,
                                false,
                                selectingModel = true,
                            )
                    } else {
                        val next =
                            selectedChoice?.let {
                                selection.withModel(it, fast = id == selectedId && selection.fast)
                            } ?: selection.copy(model = null, fast = false)
                        composer.editDraftModel(target, next)
                    }
                }
            },
            selectEffort = { effort ->
                if (choice != null && effort in choice.efforts) {
                    if (conversationModel == null)
                        composer.editDraftModel(
                            target,
                            selection.withModel(choice, selection.fast, effort),
                        )
                    else if (effort != selection.effortFor(choice))
                        conversationModel.chats.saveConversationModel(
                            conversationModel.confirmed.id,
                            choice.id,
                            effort,
                            fast = false.takeIf { choice.fastMultiplier == null },
                        )
                }
            },
            selectFast = { enabled ->
                if (choice?.fastMultiplier != null) {
                    if (conversationModel == null)
                        composer.editDraftModel(target, selection.withModel(choice, fast = enabled))
                    else if (enabled != selection.fast)
                        conversationModel.chats.saveConversationModel(
                            conversationModel.confirmed.id,
                            choice.id,
                            null,
                            enabled,
                        )
                }
            },
            dismiss = ::back,
            snackbar = conversationSnackbar,
            footerHasAction = edits?.phase == ConversationModelSave.NeedsCheck,
            footer = {
                edits?.phase?.message?.let { message ->
                    ConnectorOptionFeedback(message, Modifier.padding(top = 8.dp))
                }
                if (edits?.phase == ConversationModelSave.NeedsCheck) {
                    TextButton(
                        onClick = {
                            conversationModel.chats.retryConversationModelCheck(
                                conversationModel.confirmed.id,
                            )
                        },
                    ) {
                        Text(stringResource(R.string.retry))
                    }
                }
            },
        )
        return
    }

    fun openDirectory(account: ConnectorAccountTarget?) {
        presentation = presentation.copy(returnAccount = account?.connectionId.orEmpty())
        manageConnectors(account)
    }

    val returnAccount = presentation.returnAccount
    val accountToFocus = returnAccount ?: restoredAccount
    val focusAccount = accountToFocus?.takeIf { id -> rows?.any { it.account.id == id } == true }
    val serviceFocus = remember { FocusRequester() }
    LaunchedEffect(showingAccounts, rows, returnAccount) {
        if (showingAccounts && rows != null && returnAccount != null) {
            withFrameNanos {}
            if (focusAccount != null) accountFocus.requestFocus()
            restoredAccount = returnAccount
            presentation = presentation.copy(returnAccount = null)
        }
    }
    LaunchedEffect(showingAccounts, overviewData, slug, saving) {
        if (showingAccounts && !saving && overviewData != null && summary == null)
            returnToConnectorOverview()
    }
    LaunchedEffect(showingOverview, overviewData, restoreEntry, returnAccount) {
        val returning =
            restoreEntry == ComposerOptionsPage.ConnectorAccounts || returnAccount != null
        if (showingOverview && overviewData != null && returning) {
            withFrameNanos {}
            if (summary != null && restoreEntry == ComposerOptionsPage.ConnectorAccounts)
                serviceFocus.requestFocus()
            else accountFocus.requestFocus()
            restoreEntry = null
            presentation = presentation.copy(returnAccount = null)
        }
    }

    val title =
        when (page) {
            ComposerOptionsPage.ConnectorAccounts ->
                summary?.entry?.name ?: stringResource(R.string.connector_title)
            ComposerOptionsPage.Connectors -> stringResource(R.string.connector_title)
            else -> stringResource(R.string.chat_options_title)
        }
    val footer: (@Composable () -> Unit)? =
        if (showingOverview) {
            {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                    ConnectorButton(
                        stringResource(R.string.chat_connector_manage),
                        onClick = { openDirectory(null) },
                        enabled = !saving,
                        modifier =
                            Modifier.focusRequester(accountFocus).testTag("chat-connector-manage"),
                        treatment = ConnectorButtonTreatment.Text,
                    )
                }
            }
        } else null
    key(sheetGeneration) {
        ConnectorSheet(
            title,
            dismiss = {
                // Material has already hidden the sheet. Start a fresh one for the parent page.
                if (showingConnectors && !saving) sheetGeneration++
                back()
            },
            dismissible = !saving,
            expandInShortWindow = true,
            back = if (showingConnectors || isShortSettingsPanelWindow()) ::back else null,
            actions = footer,
            feedback = readFeedback.takeIf { hasReadContent },
            actionFeedback = conversationSnackbar.takeIf { feedbackInOptions },
            inContentFeedbackMessage =
                if (hasReadContent) stringResource(R.string.connector_refresh_failed) else null,
            centerCompactContent =
                save == null &&
                    (coldFailure == ConnectorReadFailure.Network ||
                        coldFailure == ConnectorReadFailure.Sustained),
            retainedScroll = overviewScroll.takeIf { showingOverview },
        ) {
            if (!showingConnectors) {
                var positioned by remember { mutableStateOf(false) }
                LaunchedEffect(restoreEntry, positioned, modelEnabled) {
                    if (restoreEntry != null && positioned) {
                        if (restoreEntry == ComposerOptionsPage.Model && modelEnabled)
                            modelFocus.requestFocus()
                        else if (options != null) entryFocus.requestFocus()
                        restoreEntry = null
                    }
                }
                Column(
                    modifier = Modifier.onGloballyPositioned { positioned = true },
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (pickAttachment != null) {
                        ChatOptionsHeading(R.string.chat_attachments)
                        ConnectorOptionRow(
                            stringResource(R.string.chat_attachment_photos),
                            onClick = {
                                pickAttachment(true)
                                back()
                            },
                            modifier = Modifier.testTag("chat-options-photos"),
                            enabled = composerState.journal != null,
                            icon = R.drawable.ic_image,
                            chevron = false,
                        )
                        ConnectorOptionRow(
                            stringResource(R.string.chat_attachment_files),
                            onClick = {
                                pickAttachment(false)
                                back()
                            },
                            modifier = Modifier.testTag("chat-options-files"),
                            enabled = composerState.journal != null,
                            icon = R.drawable.ic_folder,
                            chevron = false,
                        )
                        if (showModel || options != null)
                            HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    }
                    if (showModel || options != null)
                        ChatOptionsHeading(R.string.chat_options_settings)
                    if (showModel) {
                        val value =
                            choice?.label
                                ?: selectedId?.let { id ->
                                    modelState.record?.confirmedLabel?.takeIf {
                                        override == null && confirmed == null
                                    } ?: id
                                }
                                ?: stringResource(R.string.settings_auto_model)
                        ConnectorOptionRow(
                            stringResource(R.string.chat_options_model),
                            onClick = {
                                presentation = presentation.copy(page = ComposerOptionsPage.Model)
                            },
                            modifier =
                                Modifier.focusRequester(modelFocus).testTag("chat-options-model"),
                            enabled = modelEnabled,
                            icon = R.drawable.ic_settings,
                            supportingText = value,
                        )
                    }
                    if (options != null)
                        ConnectorOptionRow(
                            stringResource(R.string.connector_title),
                            onClick = {
                                openingOverview = true
                                presentation =
                                    presentation.copy(
                                        page = ComposerOptionsPage.Connectors,
                                        connectorSlug = null,
                                    )
                            },
                            modifier =
                                Modifier.focusRequester(entryFocus)
                                    .testTag("chat-options-connectors"),
                        )
                }
            } else if (showingOverview) {
                if (save != null) ChatConnectorSaveFeedback(save.phase)
                when {
                    overviewData == null ->
                        ChatConnectorReadPlaceholder(
                            coldFailure,
                            R.string.connector_load_failed,
                        ) {
                            ChatConnectorOverviewSkeleton()
                        }
                    overviewData.isEmpty() -> ConnectorOptionFeedback(R.string.chat_connector_empty)
                    else ->
                        Column {
                            for (service in overviewData) {
                                val entry = service.entry
                                key(entry.slug) {
                                    ChatConnectorServiceRow(
                                        service,
                                        onClick = {
                                            options.dismissFailure(target)
                                            openingAccounts = true
                                            presentation =
                                                presentation.copy(
                                                    page = ComposerOptionsPage.ConnectorAccounts,
                                                    connectorSlug = entry.slug,
                                                )
                                        },
                                        modifier =
                                            if (entry.slug == slug)
                                                Modifier.focusRequester(serviceFocus)
                                            else Modifier,
                                        enabled = !saving,
                                    )
                                }
                            }
                        }
                }
            } else if (rows == null || summary == null) {
                if (save != null) ChatConnectorSaveFeedback(save.phase)
                ChatConnectorReadPlaceholder(
                    coldFailure,
                    R.string.connector_accounts_failed,
                ) {
                    ConnectorSkeleton(stringResource(R.string.connector_loading_accounts), rows = 2)
                }
            } else {
                val serviceSlug = summary.entry.slug
                val newChat = target.threadId == null
                val memberAccess = reading.data.memberAccess
                val draftChoices =
                    composerState.connectorOverrides(target).associateBy { it.connectionId }
                val pendingChoices = save?.pending.orEmpty().associateBy { it.connectionId }
                val canEdit =
                    !saving &&
                        (memberAccess || !newChat || composerState.canEditDraftConnectors(target))
                ConnectorOptionFeedback(
                    if (memberAccess) R.string.connector_access_scope
                    else R.string.chat_connector_scope,
                    Modifier.padding(horizontal = 8.dp),
                )
                if (rows.isEmpty()) ConnectorOptionFeedback(R.string.connector_empty_connected)
                val policies = detail.policies
                Column {
                    for (row in rows) {
                        key(row.account.id) {
                            val id = row.account.id
                            val pending = pendingChoices[id]
                            val chosen =
                                if (newChat) draftChoices[id]?.enabled
                                else if (pending != null) pending.enabled else row.override
                            val enabled = chosen ?: (row.account.defaultEnabled == true)
                            val choice = ChatConnectorOverride(serviceSlug, id, !enabled)
                            ChatConnectorRow(
                                row.account.copy(policy = policies.data?.get(id)),
                                enabled,
                                canEdit,
                                canManage = !saving,
                                memberAccess = memberAccess,
                                modifier =
                                    if (id == focusAccount) Modifier.focusRequester(accountFocus)
                                    else Modifier,
                                onToggle = {
                                    if (newChat) composer.editConnectorOverride(target, choice)
                                    else options.save(target, serviceSlug, listOf(choice))
                                },
                                onPolicy = { options.savePolicy(target, serviceSlug, id, it) },
                                onRepair = {
                                    openDirectory(ConnectorAccountTarget(serviceSlug, id))
                                },
                            )
                            if (save?.connectionId == id) {
                                ChatConnectorSaveFeedback(
                                    save.phase,
                                    Modifier.padding(start = 12.dp, top = 8.dp, end = 12.dp),
                                )
                            }
                        }
                    }
                }
                if (save != null && rows.none { it.account.id == save.connectionId })
                    ChatConnectorSaveFeedback(
                        save.phase,
                        Modifier.padding(horizontal = 12.dp),
                    )
                if (policies.failure != null)
                    ConnectorOptionFeedback(R.string.chat_connector_policies_failed)
                val resets = overviewData.flatMap { it.overrides() }
                val canReset =
                    if (newChat) draftChoices.values.any { it.enabled != null }
                    else resets.isNotEmpty()
                if (!memberAccess && canReset) {
                    ConnectorButton(
                        stringResource(R.string.chat_connector_restore_defaults),
                        onClick = {
                            if (newChat) composer.editConnectorOverride(target, null)
                            else options.save(target, serviceSlug, resets)
                        },
                        enabled = canEdit,
                        modifier = Modifier.testTag("chat-connector-reset"),
                        treatment = ConnectorButtonTreatment.Text,
                    )
                }
            }
        }
    }
}

@Composable
private fun ChatConnectorReadPlaceholder(
    failure: ConnectorReadFailure?,
    @StringRes unavailable: Int,
    skeleton: @Composable () -> Unit,
) {
    Box(Modifier.fillMaxWidth().heightIn(min = 160.dp), propagateMinConstraints = true) {
        if (failure == null) skeleton()
        else
            ConnectorReadFailureContent(
                failure,
                unavailable,
                Modifier,
                ContentReadFailureLayout.Panel,
            )
    }
}

@Composable
private fun ChatConnectorOverviewSkeleton() {
    if (!rememberContentReadSkeleton()) return
    val label = stringResource(R.string.connector_loading)
    Column(Modifier.fillMaxWidth().semantics { contentDescription = label }) {
        repeat(3) {
            ListItem(
                leadingContent = { ChatSkeletonBlock(Modifier.size(24.dp)) },
                trailingContent = { Box(Modifier.size(24.dp)) },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            ) {
                ChatSkeletonBlock(Modifier.size(width = 120.dp, height = 14.dp))
            }
        }
    }
}

@Composable
private fun ChatConnectorSaveFeedback(
    phase: ChatConnectorSavePhase,
    modifier: Modifier = Modifier,
) {
    ConnectorOptionFeedback(
        phase.message(),
        modifier,
        error = phase == ChatConnectorSavePhase.Failed,
    )
}

internal fun ChatConnectorSavePhase.message(): Int =
    when (this) {
        ChatConnectorSavePhase.Saving -> R.string.chat_connector_saving
        ChatConnectorSavePhase.Failed -> R.string.chat_connector_save_failed
    }

@Composable
private fun ChatConnectorServiceRow(
    service: ChatConnectorSummary,
    onClick: () -> Unit,
    modifier: Modifier,
    enabled: Boolean,
) {
    val count = service.accounts.size
    ConnectorNavigationRow(
        onClick = onClick,
        modifier = modifier.testTag("chat-connector-service-${service.entry.slug}"),
        enabled = enabled,
        leadingContent = { ConnectorMark(service.entry.icon, 24.dp) },
        trailingContent = {
            Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(24.dp))
        },
    ) {
        if (count <= 1) Text(service.entry.name)
        else {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(service.entry.name, Modifier.weight(2f))
                Text(
                    pluralStringResource(R.plurals.connector_accounts_count, count, count),
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.End,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun ChatOptionsHeading(label: Int) {
    Text(
        stringResource(label),
        modifier = Modifier.padding(start = 12.dp).semantics { heading() },
        style = connectorSmallType(),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun ChatConnectorRow(
    account: ConnectorSavedAccount,
    enabled: Boolean,
    canEdit: Boolean,
    canManage: Boolean,
    memberAccess: Boolean,
    modifier: Modifier,
    onToggle: () -> Unit,
    onPolicy: (ConnectorAccountPolicyRequestPolicy) -> Unit,
    onRepair: () -> Unit,
) {
    val needsRepair = account.status.needsAttention
    val showCheckbox = !memberAccess && !needsRepair
    val action =
        if (showCheckbox)
            Modifier.then(modifier)
                .testTag("chat-connector-selection-${account.id}")
                .toggleable(
                    value = enabled,
                    enabled = canEdit && account.status == ConnectorAccountStatus.Connected,
                    role = Role.Checkbox,
                    onValueChange = { onToggle() },
                )
        else if (memberAccess && !needsRepair && modifier != Modifier) modifier.focusable()
        else Modifier
    val label = account.label()
    val identity = account.identity?.takeIf { it != label }
    val selected = showCheckbox && enabled
    val colors = MaterialTheme.colorScheme
    val supporting = if (selected) colors.onSecondaryContainer else colors.onSurfaceVariant
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 72.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .then(action)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = connectorBodyType())
            identity?.let {
                Text(it, color = supporting, style = connectorFeedbackType())
            }
        }
        when {
            needsRepair ->
                TextButton(
                    onClick = onRepair,
                    enabled = canManage,
                    modifier = modifier.testTag("chat-connector-repair-${account.id}"),
                ) {
                    val label =
                        if (account.status == ConnectorAccountStatus.UpdatePermissions)
                            R.string.connector_update_permissions
                        else R.string.connector_reauthorize
                    Text(stringResource(label), style = connectorFeedbackType())
                }
            memberAccess ->
                account.policy?.let {
                    ConnectorAccountPolicyMenu(
                        account,
                        it,
                        canEdit,
                        onPolicy,
                        outlined = true,
                    )
                }
            showCheckbox -> Checkbox(checked = enabled, onCheckedChange = null, enabled = canEdit)
        }
    }
}

@Composable
private fun ConnectorOptionRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: Int = R.drawable.ic_extension,
    supportingText: String? = null,
    chevron: Boolean = true,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = if (supportingText == null) 56.dp else 72.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(icon),
            null,
            Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(Modifier.weight(1f)) {
            Text(title, style = connectorBodyType())
            supportingText?.let {
                Text(
                    it,
                    style = connectorFeedbackType(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (chevron) ConnectorChevron()
    }
}

@Composable
private fun ConnectorOptionFeedback(
    message: Int,
    modifier: Modifier = Modifier,
    error: Boolean = false,
) {
    Text(
        stringResource(message),
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color =
            if (error) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
        style = connectorFeedbackType(),
    )
}
