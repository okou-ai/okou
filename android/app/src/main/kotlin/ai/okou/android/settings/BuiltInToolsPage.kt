package ai.okou.android.settings

import ai.okou.android.ContentReadProgress
import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsChoiceSheet
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsPickerRow
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.api.generated.imageToolOptions
import ai.okou.android.api.generated.publicImageToolOptions
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun BuiltInToolsPage(
    workspace: String,
    model: BuiltInToolsSettings,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    LifecycleResumeEffect(model) {
        model.show()
        onPauseOrDispose { model.hidePage() }
    }
    Text(
        stringResource(R.string.settings_tool_scope, workspace),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    SettingsSection(stringResource(R.string.settings_common_tools)) {
        SettingsGroup {
            ToolSwitch(
                webSearchTool,
                stringResource(R.string.settings_tool_web_search),
                R.drawable.ic_search,
                state,
                model,
            )
        }
    }
    SettingsSection(stringResource(R.string.settings_data_tools)) {
        val families = state.catalog.value
        val locale = LocalConfiguration.current.locales[0].toLanguageTag()
        if (families == null) {
            if (state.catalog.initialFailure) SettingsReadError()
            else SettingsPlaceholder(stringResource(R.string.settings_data_tools))
        } else {
            Box(Modifier.fillMaxWidth()) {
                if (families.isNotEmpty())
                    SettingsGroup {
                        families.forEachIndexed { index, family ->
                            key(family.id) {
                                if (index > 0) HorizontalDivider()
                                ToolSwitch(
                                    family.id,
                                    family.title[locale] ?: family.title["en-US"] ?: family.id,
                                    familyIcon(family.id),
                                    state,
                                    model,
                                )
                            }
                        }
                    }
                // An empty confirmed catalog has no rows to give this overlay height.
                ContentReadProgress(
                    R.string.settings_data_tools,
                    visible = state.catalog.refreshing,
                    modifier =
                        Modifier.matchParentSize()
                            .wrapContentHeight(Alignment.Top, unbounded = true),
                )
            }
        }
    }
    SettingsSection(stringResource(R.string.settings_tool_image_generation)) {
        SettingsGroup {
            ToolSwitch(
                imageGenerationTool,
                stringResource(R.string.settings_tool_image_generation),
                R.drawable.ic_image,
                state,
                model,
            )
            HorizontalDivider()
            ImageModelPicker(state, model, snackbar, onFeedbackInOverlay)
        }
    }
    if (state.preferencesUnavailable && state.disabled == null)
        ToolStatus(stringResource(R.string.settings_tools_unavailable))
}

private fun familyIcon(id: String): Int =
    when (id) {
        "keywords-rankings" -> R.drawable.ic_search
        "ad-creatives" -> R.drawable.ic_image
        "company-contacts",
        "creators-partners" -> R.drawable.ic_contacts
        "places-weather" -> R.drawable.ic_location_on
        else -> R.drawable.ic_description
    }

@Composable
private fun ToolSwitch(
    id: String,
    title: String,
    icon: Int,
    state: BuiltInToolsState,
    model: BuiltInToolsSettings,
) {
    SettingsSwitchRow(
        title,
        leading = { SettingsIcon(icon) },
        checked = state.enabled(id),
        onCheckedChange = { model.toggle(id, it) },
    )
    if (id in state.savingTools) LinearProgressIndicator(Modifier.fillMaxWidth())
}

@Composable
private fun ImageModelPicker(
    state: BuiltInToolsState,
    model: BuiltInToolsSettings,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
) {
    val title = stringResource(R.string.settings_tool_image_model)
    val selectedModel = state.displayedImage
    val selected = imageToolOptions.firstOrNull { it.id == selectedModel }
    val imageEnabled = state.enabled(imageGenerationTool) == true
    val enabled = selectedModel != null && imageEnabled && imageGenerationTool !in state.savingTools
    Box {
        // Turning off the tool ends the picker. The next enable starts from the row.
        key(imageEnabled) {
            SettingsPickerRow(
                title,
                value = selected?.title ?: selectedModel,
                leading = { SettingsIcon(R.drawable.ic_memory) },
                enabled = enabled,
                modifier = if (enabled) Modifier else Modifier.alpha(0.38f),
            ) { dismiss ->
                val routeFeedback by rememberUpdatedState(onFeedbackInOverlay)
                DisposableEffect(Unit) {
                    routeFeedback(true)
                    onDispose { routeFeedback(false) }
                }
                // Keep an older saved model available until its replacement is confirmed.
                val legacy = imageToolOptions.firstOrNull {
                    (it.id == state.confirmedImage || it.id == selectedModel) &&
                        it !in publicImageToolOptions
                }
                val options =
                    if (legacy == null) publicImageToolOptions else publicImageToolOptions + legacy
                SettingsChoiceSheet(
                    title,
                    dismiss,
                    options,
                    options.indexOf(selected),
                    { it.id },
                    snackbar = snackbar,
                ) { option, position ->
                    SettingsChoiceRow(
                        option.title,
                        selected = option.id == selected?.id,
                        enabled = true,
                        onClick = {
                            dismiss()
                            model.chooseImage(option.id)
                        },
                        modifier = position,
                        trailing = { foreground ->
                            Text(
                                option.price,
                                color = foreground,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        },
                    )
                }
            }
        }
        if (state.pendingImage != null) {
            val saving = stringResource(R.string.settings_saving)
            LinearProgressIndicator(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().semantics {
                    contentDescription = saving
                },
            )
        }
    }
    if (state.imageUnavailable && imageEnabled)
        ToolStatus(stringResource(R.string.settings_tools_unavailable))
}

@Composable
private fun ToolStatus(message: String) {
    Text(
        message,
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics {
            liveRegion = LiveRegionMode.Polite
        },
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}
