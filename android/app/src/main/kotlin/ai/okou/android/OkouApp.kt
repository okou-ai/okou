package ai.okou.android

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController

private enum class Destination(val route: String, val label: Int, val icon: Int) {
    Home("home", R.string.home, R.drawable.ic_draft),
    Settings("settings", R.string.settings, R.drawable.ic_settings),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OkouApp(
    home: HomeModel,
    appearance: AppearanceUiState,
    selectMode: (AppearanceMode) -> Unit,
    retryAppearance: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val navigation = rememberNavController()
    val entry by navigation.currentBackStackEntryAsState()
    val settingsOpen = entry?.destination?.route == Destination.Settings.route
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val navigate: (Destination) -> Unit = { destination ->
        if (entry?.destination?.route != destination.route) {
            // The navigation action hands focus away from the editor to its destination.
            focus.clearFocus()
            keyboard?.hide()
            navigation.navigate(destination.route) {
                popUpTo(navigation.graph.findStartDestination().id) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }
    BoxWithConstraints(modifier.fillMaxSize()) {
        val compact = maxWidth < 600.dp
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            contentWindowInsets = WindowInsets.safeDrawing,
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            stringResource(
                                if (settingsOpen) R.string.settings else R.string.app_name
                            )
                        )
                    },
                    colors =
                        TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.background
                        ),
                    navigationIcon = {
                        if (settingsOpen) {
                            IconButton(onClick = { navigation.navigateUp() }) {
                                Icon(
                                    painterResource(R.drawable.ic_back),
                                    stringResource(R.string.back),
                                )
                            }
                        }
                    },
                )
            },
            bottomBar = {
                if (compact) {
                    NavigationBar(Modifier.testTag("bottom_navigation")) {
                        Destination.entries.forEach { destination ->
                            NavigationBarItem(
                                selected = entry?.destination?.route == destination.route,
                                onClick = { navigate(destination) },
                                icon = {
                                    Icon(
                                        painterResource(destination.icon),
                                        null,
                                        Modifier.size(24.dp),
                                    )
                                },
                                label = { Text(stringResource(destination.label)) },
                            )
                        }
                    }
                }
            },
        ) { insets ->
            Row(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
                if (!compact) {
                    NavigationRail(Modifier.testTag("navigation_rail")) {
                        Destination.entries.forEach { destination ->
                            NavigationRailItem(
                                selected = entry?.destination?.route == destination.route,
                                onClick = { navigate(destination) },
                                icon = {
                                    Icon(
                                        painterResource(destination.icon),
                                        null,
                                        Modifier.size(24.dp),
                                    )
                                },
                                label = { Text(stringResource(destination.label)) },
                            )
                        }
                    }
                }
                NavHost(navigation, Destination.Home.route, Modifier.weight(1f).fillMaxSize()) {
                    composable(Destination.Home.route) { HomeScreen(home) }
                    composable(Destination.Settings.route) {
                        SettingsScreen(appearance, selectMode, retryAppearance)
                    }
                }
            }
        }
    }
}
