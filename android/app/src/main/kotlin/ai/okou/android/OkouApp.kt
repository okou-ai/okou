package ai.okou.android

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OkouApp(
    appearance: AppearanceUiState,
    selectMode: (AppearanceMode) -> Unit,
    retryAppearance: () -> Unit,
    account: @Composable () -> Unit = {},
    workspacePreferences: @Composable () -> Unit = {},
    modifier: Modifier = Modifier,
    homeContent: @Composable () -> Unit,
) {
    val navigation = rememberNavController()
    val entry by navigation.currentBackStackEntryAsState()
    val settingsOpen = entry?.destination?.route == "settings"
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val settingsLabel = stringResource(R.string.settings)
    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            TopAppBar(
                title = {
                    Text(stringResource(if (settingsOpen) R.string.settings else R.string.app_name))
                },
                colors =
                    TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    ),
                navigationIcon = {
                    if (settingsOpen)
                        IconButton(onClick = { navigation.navigateUp() }) {
                            Icon(painterResource(R.drawable.ic_back), stringResource(R.string.back))
                        }
                },
                actions = {
                    if (!settingsOpen)
                        IconButton(
                            onClick = {
                                focus.clearFocus()
                                keyboard?.hide()
                                navigation.navigate("settings") { launchSingleTop = true }
                            },
                            modifier = Modifier.semantics { contentDescription = settingsLabel },
                        ) {
                            Surface(
                                modifier = Modifier.size(32.dp),
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.secondaryContainer,
                            ) {
                                Icon(
                                    painterResource(R.drawable.okou_mark),
                                    contentDescription = null,
                                    modifier = Modifier.padding(6.dp),
                                )
                            }
                        }
                },
            )
        },
    ) { insets ->
        NavHost(
            navigation,
            "home",
            Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets),
        ) {
            composable("home") { homeContent() }
            composable("settings") {
                SettingsScreen(
                    appearance,
                    selectMode,
                    retryAppearance,
                    account,
                    workspacePreferences,
                )
            }
        }
    }
}
