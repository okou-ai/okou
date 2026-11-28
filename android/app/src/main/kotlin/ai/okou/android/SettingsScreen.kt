package ai.okou.android

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

@Composable
internal fun SettingsPage(
    scroll: ScrollState,
    progress: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    val window = currentWindowSizeDp()
    val wide = supportsWorkspacePanes(window.width, window.height)
    Column(Modifier.fillMaxSize().imePadding()) {
        if (wide) HorizontalDivider()
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.verticalScroll(scroll)
                    .padding(
                        start = 24.dp,
                        end = 24.dp,
                        top = if (wide) 24.dp else 12.dp,
                        bottom = 32.dp,
                    )
                    .widthIn(max = 720.dp)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                content()
            }
            progress()
        }
    }
}

@Composable
internal fun SettingsScreen(
    appUpdates: @Composable (() -> Unit)? = null,
    workspacePreferences: @Composable () -> Unit,
    workspace: @Composable () -> Unit = {},
    models: @Composable () -> Unit,
    tools: @Composable () -> Unit,
    myOkou: @Composable () -> Unit,
    account: @Composable () -> Unit = {},
) {
    workspace()
    SettingsSection(stringResource(R.string.settings_models)) { SettingsGroup { models() } }
    SettingsSection(stringResource(R.string.settings_tools)) { tools() }
    SettingsSection(stringResource(R.string.settings_my_okou)) { SettingsGroup { myOkou() } }
    workspacePreferences()
    account()
    if (appUpdates != null) {
        SettingsSection(stringResource(R.string.on_this_device)) { SettingsGroup { appUpdates() } }
    }
}
