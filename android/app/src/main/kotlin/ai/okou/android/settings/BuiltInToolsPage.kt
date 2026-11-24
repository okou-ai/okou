package ai.okou.android.settings

import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsPickerRow
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSheetScroll
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.api.generated.imageToolOptions
import ai.okou.android.api.generated.publicImageToolOptions
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun BuiltInToolsPage(workspace: String, model: BuiltInToolsSettings) {
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
            if (state.catalog.initialFailure)
                ToolStatus(stringResource(R.string.settings_tools_unavailable))
            else SettingsPlaceholder(stringResource(R.string.settings_data_tools))
        } else {
            if (state.catalog.refreshing) LinearProgressIndicator(Modifier.fillMaxWidth())
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
            ImageModelPicker(state, model)
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
private fun ImageModelPicker(state: BuiltInToolsState, model: BuiltInToolsSettings) {
    val title = stringResource(R.string.settings_tool_image_model)
    val selectedModel = state.displayedImage
    val selected = imageToolOptions.firstOrNull { it.id == selectedModel }
    SettingsPickerRow(
        title,
        value = selected?.title ?: selectedModel,
        leading = { SettingsIcon(R.drawable.ic_memory) },
        enabled =
            selectedModel != null &&
                state.enabled(imageGenerationTool) == true &&
                imageGenerationTool !in state.savingTools &&
                !state.savingImage,
    ) { dismiss ->
        val options =
            if (selected != null && selected !in publicImageToolOptions)
                publicImageToolOptions + selected
            else publicImageToolOptions
        val index = options.indexOf(selected).coerceAtLeast(0)
        SettingsSheet(title, dismiss, scroll = SettingsSheetScroll.None) {
            val initialId = remember { selected?.id }
            val focus = remember { FocusRequester() }
            val input = LocalInputModeManager.current
            var positioned by remember { mutableStateOf(false) }
            LaunchedEffect(positioned) {
                if (positioned && input.inputMode == InputMode.Keyboard) focus.requestFocus()
            }
            LazyColumn(
                Modifier.fillMaxWidth().selectableGroup(),
                state = rememberLazyListState(index),
            ) {
                items(options, key = { it.id }) { option ->
                    SettingsChoiceRow(
                        option.title,
                        selected = option.id == selected?.id,
                        enabled = true,
                        onClick = {
                            dismiss()
                            model.chooseImage(option.id)
                        },
                        modifier =
                            if (option.id == initialId)
                                Modifier.focusRequester(focus).onGloballyPositioned {
                                    positioned = true
                                }
                            else Modifier,
                        trailing = {
                            Text(
                                option.price,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        },
                    )
                }
            }
        }
    }
    if (state.savingImage) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (state.imageFailed) ToolStatus(stringResource(R.string.settings_tool_image_save_failed))
    if (state.imageUnavailable && state.enabled(imageGenerationTool) == true)
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
