package ai.okou.android.artifacts

import ai.okou.android.OkouActionButton
import ai.okou.android.R
import ai.okou.android.SettingsRadioRow
import ai.okou.android.SettingsSheet
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

internal class ArtifactLinkActions(
    val state: ArtifactLinkState,
    val panelOpen: Boolean,
    val refresh: () -> Unit,
    val copy: () -> Unit,
    val share: () -> Unit,
    val manage: () -> Unit,
    val openWebsiteLink: (() -> Unit)?,
)

private enum class LinkPanel {
    Share,
    Manage,
}

@Composable
internal fun ArtifactLinkControls(
    source: ArtifactLinkSource?,
    title: String,
    model: ArtifactCatalogModel,
    snackbar: SnackbarHostState,
    content: @Composable (ArtifactLinkActions?) -> Unit,
) {
    val editor = remember(model, source) { source?.let(model::linkEditor) }
    val state = editor?.state?.collectAsStateWithLifecycle()?.value
    var panel by remember(editor) { mutableStateOf<LinkPanel?>(null) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val resources = LocalResources.current
    fun copy(link: ArtifactLink) {
        scope.launch {
            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, link.address.toString())))
            snackbar.showSnackbar(
                resources.getString(
                    if (link.audience == ArtifactAudience.PRIVATE)
                        R.string.artifact_private_link_copied
                    else R.string.artifact_link_copied,
                ),
                duration = SnackbarDuration.Indefinite,
            )
        }
    }

    content(
        if (editor == null || state == null) null
        else
            ArtifactLinkActions(
                state,
                panelOpen = panel != null,
                refresh = editor::refresh,
                copy = { editor.state.value.usable?.let(::copy) },
                share = { panel = LinkPanel.Share },
                manage = { panel = LinkPanel.Manage },
                openWebsiteLink =
                    if (source is ArtifactLinkSource.File) null
                    else {
                        {
                            editor.refresh()
                            panel = LinkPanel.Share
                        }
                    },
            ),
    )
    val activePanel = panel
    if (activePanel != null && editor != null && state != null) {
        ArtifactLinkPanel(
            activePanel,
            title,
            state,
            select = editor::select,
            save = editor::save,
            refresh = editor::refresh,
            copy = ::copy,
            dismiss = { panel = null },
        )
    }
}

@Composable
internal fun ArtifactOverflowMenu(
    @StringRes label: Int,
    links: ArtifactLinkActions?,
    modifier: Modifier = Modifier,
    focus: FocusRequester = remember { FocusRequester() },
    previewItems: List<WorkspaceMenuItem> = emptyList(),
    iconColor: Color = Color.Unspecified,
) {
    var expanded by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by remember { mutableStateOf(false) }
    val panelOpen = links?.panelOpen == true
    LaunchedEffect(expanded, panelOpen) {
        if (!expanded && !panelOpen && restoreFocus) {
            restoreFocus = false
            focus.requestFocus()
        }
    }
    Box(modifier) {
        IconButton(
            colors = IconButtonDefaults.iconButtonColors(contentColor = iconColor),
            onClick = {
                restoreFocus = focused
                links?.refresh?.invoke()
                expanded = true
            },
            modifier = Modifier.focusRequester(focus).onFocusChanged { focused = it.isFocused },
        ) {
            Icon(
                painterResource(R.drawable.ic_more_vert),
                stringResource(label),
                Modifier.size(24.dp),
            )
        }
        if (expanded) {
            val items = previewItems + (links?.menuItems() ?: emptyList())
            WorkspaceMenu(
                items.map { item ->
                    item.copy(
                        onClick = {
                            expanded = false
                            item.onClick()
                        },
                    )
                },
                close = { expanded = false },
            )
        }
    }
}

@Composable
private fun ArtifactLinkActions.menuItems(): List<WorkspaceMenuItem> {
    val link = state.usable
    if (link != null)
        return buildList {
            add(
                WorkspaceMenuItem(
                    stringResource(R.string.artifact_copy_link),
                    R.drawable.ic_content_copy,
                    onClick = copy,
                ),
            )
            if (link.audience != ArtifactAudience.PRIVATE)
                add(
                    WorkspaceMenuItem(
                        stringResource(R.string.artifact_share_link),
                        R.drawable.ic_share,
                        onClick = share,
                    ),
                )
            if (link.canManage)
                add(
                    WorkspaceMenuItem(
                        stringResource(R.string.artifact_manage_access),
                        R.drawable.ic_settings,
                        onClick = manage,
                    ),
                )
        }
    val feedback =
        when (state.phase) {
            ArtifactLinkPhase.Idle,
            ArtifactLinkPhase.Loading -> R.string.artifact_link_loading
            ArtifactLinkPhase.Unavailable -> R.string.artifact_link_unavailable
            ArtifactLinkPhase.ReadFailed,
            ArtifactLinkPhase.VerificationFailed -> R.string.artifact_link_load_failed
            else -> R.string.artifact_link_verifying
        }
    return listOf(
        WorkspaceMenuItem(stringResource(feedback), enabled = false, onClick = {}),
    )
}

@Composable
private fun ArtifactLinkPanel(
    panel: LinkPanel,
    artifactTitle: String,
    state: ArtifactLinkState,
    select: (ArtifactAudience) -> Unit,
    save: () -> Unit,
    refresh: () -> Unit,
    copy: (ArtifactLink) -> Unit,
    dismiss: () -> Unit,
) {
    val confirmed = state.confirmed
    val usable = state.usable
    val context = LocalContext.current
    var handoffFailed by remember { mutableStateOf(false) }
    val manage = panel == LinkPanel.Manage
    val retry =
        state.phase == ArtifactLinkPhase.ReadFailed ||
            state.phase == ArtifactLinkPhase.VerificationFailed
    val privateLink = usable?.audience == ArtifactAudience.PRIVATE
    val normalAction =
        if (manage) R.string.instructions_save
        else if (privateLink) R.string.artifact_copy_link else R.string.artifact_share_link
    val action =
        when (state.phase) {
            ArtifactLinkPhase.Unavailable -> null
            ArtifactLinkPhase.Loading -> R.string.artifact_link_loading
            ArtifactLinkPhase.Saving -> R.string.settings_saving
            ArtifactLinkPhase.Verifying -> R.string.chat_project_checking
            ArtifactLinkPhase.ReadFailed -> R.string.retry
            ArtifactLinkPhase.VerificationFailed -> R.string.chat_rename_check_result
            else -> normalAction
        }
    val shareTitle = usable?.let { audienceLabel(it.audience, it.organization) }
    val message =
        when {
            handoffFailed -> R.string.artifact_link_handoff_failed
            state.phase == ArtifactLinkPhase.Unavailable -> R.string.artifact_link_unavailable
            state.phase == ArtifactLinkPhase.ReadFailed -> R.string.artifact_link_load_failed
            state.phase == ArtifactLinkPhase.Verifying -> R.string.artifact_link_verifying
            state.phase == ArtifactLinkPhase.VerificationFailed ->
                R.string.artifact_link_verify_failed
            state.phase == ArtifactLinkPhase.SaveFailed -> R.string.artifact_link_save_failed
            else -> null
        }
    fun submit() {
        if (retry) {
            refresh()
        } else if (manage) {
            save()
        } else if (usable != null) {
            if (privateLink) {
                copy(usable)
                dismiss()
                return
            }
            val intent =
                Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, usable.address.toString())
                    putExtra(Intent.EXTRA_TITLE, shareTitle)
                }
            handoffFailed =
                try {
                    context.startActivity(Intent.createChooser(intent, null))
                    dismiss()
                    false
                } catch (_: ActivityNotFoundException) {
                    true
                } catch (_: SecurityException) {
                    true
                }
        }
    }
    SettingsSheet(
        title =
            stringResource(
                if (manage) R.string.artifact_manage_access else R.string.artifact_share_link,
            ),
        onDismiss = dismiss,
        modifier =
            Modifier.testTag(
                if (manage) "artifact_manage_access_panel" else "artifact_share_link_panel",
            ),
        fullScreenInShortWindow = true,
        showBack = true,
        dismissible = !state.busy,
        actions = {
            if (action != null) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                    OkouActionButton(
                        stringResource(action),
                        onClick = ::submit,
                        enabled = retry || if (manage) state.canSave else usable != null,
                        modifier = Modifier.widthIn(min = 88.dp),
                        layoutLabels =
                            if (manage && state.busy)
                                listOf(stringResource(R.string.instructions_save))
                            else emptyList(),
                        retainDisabledFocus = state.busy,
                    )
                }
            }
        },
    ) {
        val version =
            when (val selected = confirmed?.version) {
                ArtifactLinkVersion.CurrentSite ->
                    stringResource(R.string.artifact_link_current_version)
                is ArtifactLinkVersion.Deployment ->
                    selected.number?.let { stringResource(R.string.artifact_link_version, it) }
                        ?: stringResource(R.string.artifact_link_selected_version)
                null -> null
            }
        ArtifactLinkNote(
            if (version == null) artifactTitle
            else stringResource(R.string.artifact_metadata, artifactTitle, version),
        )
        if (confirmed != null) {
            ArtifactLinkNote(
                stringResource(
                    R.string.artifact_link_current_access,
                    audienceLabel(confirmed.audience, confirmed.organization),
                ),
            )
            if (manage && confirmed.canManage) {
                ArtifactLinkNote(stringResource(R.string.artifact_link_who_can_view))
                Column(Modifier.fillMaxWidth().selectableGroup()) {
                    ArtifactAudience.entries.forEach { audience ->
                        SettingsRadioRow(
                            stringResource(audience.label()),
                            selected = state.draft == audience,
                            enabled = state.canEdit,
                            supportingText =
                                when (audience) {
                                    ArtifactAudience.PRIVATE ->
                                        stringResource(R.string.artifact_private_link_hint)
                                    ArtifactAudience.ORGANIZATION ->
                                        confirmed.organization?.let {
                                            stringResource(
                                                R.string.artifact_workspace_link_hint,
                                                it,
                                            )
                                        }
                                    ArtifactAudience.PUBLIC ->
                                        stringResource(R.string.artifact_public_link_hint)
                                },
                            onClick = { select(audience) },
                        )
                    }
                }
            }
            if (!manage && usable != null) {
                Surface(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Text(
                        usable.address.toString(),
                        Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (privateLink)
                    ArtifactLinkNote(stringResource(R.string.artifact_private_link_hint))
            }
        }
        Box(Modifier.fillMaxWidth()) {
            if (manage && confirmed != null) {
                for (label in
                    listOf(
                        R.string.artifact_link_verify_failed,
                        R.string.artifact_link_save_failed,
                    )) {
                    Text(
                        stringResource(label),
                        Modifier.padding(horizontal = 8.dp).alpha(0f).clearAndSetSemantics {},
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            if (message != null) {
                ArtifactLinkNote(
                    stringResource(message),
                    error = state.phase != ArtifactLinkPhase.Verifying,
                )
            }
        }
    }
}

@Composable
private fun ArtifactLinkNote(text: String, error: Boolean = false) {
    Text(
        text,
        Modifier.padding(horizontal = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium,
        color =
            if (error) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun audienceLabel(audience: ArtifactAudience, organization: String?): String {
    val label = stringResource(audience.label())
    return if (audience == ArtifactAudience.ORGANIZATION && !organization.isNullOrBlank())
        stringResource(R.string.artifact_metadata, label, organization)
    else label
}

@StringRes
private fun ArtifactAudience.label() =
    when (this) {
        ArtifactAudience.PRIVATE -> R.string.artifact_link_private
        ArtifactAudience.ORGANIZATION -> R.string.artifact_link_workspace
        ArtifactAudience.PUBLIC -> R.string.artifact_link_public
    }
