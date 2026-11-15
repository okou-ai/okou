package ai.okou.android

import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.SessionRoot
import ai.okou.android.auth.WorkspaceSessionFactory
import ai.okou.android.preferences.applyApplicationLocale
import ai.okou.android.state.SavedStatePolicy
import ai.okou.android.updates.AppUpdateSettings
import ai.okou.android.updates.UpdateHost
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private var updateSourceAuthorized by mutableStateOf(false)
    private val session: SessionModel by viewModels {
        viewModelFactory {
            initializer {
                val app = application as OkouApplication
                SessionModel(
                    app.authentication,
                    WorkspaceSessionFactory(app::createWorkspaceSession),
                    BuildConfig.API_ORIGIN,
                    app.chatCache,
                    app.instructionsDrafts,
                    app.composerJournal,
                    updatesRequired = app.updates.required,
                )
            }
        }
    }
    private val appearance: AppearanceModel by viewModels {
        viewModelFactory {
            initializer { AppearanceModel((application as OkouApplication).appearancePreferences) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val settings = appearance
        val authentication = session
        val updates = (application as OkouApplication).updates
        setContent {
            val state by settings.uiState.collectAsStateWithLifecycle()
            val sessionState by authentication.uiState.collectAsStateWithLifecycle()
            val updateState by updates.state.collectAsStateWithLifecycle()
            // Capture the rendered owner, rather than reading a newer State value on an old click.
            val presentedGeneration = sessionState.generation
            val preferences =
                key(presentedGeneration) {
                    // A new workspace must not inherit collectAsState's remembered value from its
                    // predecessor.
                    sessionState.ready?.preferences?.uiState?.collectAsStateWithLifecycle()?.value
                }
            LaunchedEffect(presentedGeneration, preferences?.locale) {
                if (authentication.isPresentationCurrent(presentedGeneration)) {
                    applyApplicationLocale(preferences?.locale)
                }
            }
            val dark = state.mode.resolveDark(isSystemInDarkTheme())
            LaunchedEffect(dark) {
                val style =
                    if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                    else
                        SystemBarStyle.light(
                            android.graphics.Color.TRANSPARENT,
                            android.graphics.Color.BLACK,
                        )
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            OkouTheme(
                dark,
                preferences?.colorTheme
                    ?: ai.okou.android.api.generated.UserPreferencesColorTheme.DEFAULT,
            ) {
                UpdateHost(
                    if (sessionState.stage == ai.okou.android.auth.SessionStage.UpdateRequired)
                        updateState.copy(required = true)
                    else updateState,
                    { updates.check() },
                    updates::download,
                    updates::cancelDownload,
                    updates::defer,
                    ::installUpdate,
                    updateSourceAuthorized,
                ) { openUpdates ->
                    SessionRoot(
                        sessionState,
                        state,
                        settings::selectMode,
                        settings::retry,
                        { authentication.retry(presentedGeneration) },
                        { id -> authentication.chooseWorkspace(id, presentedGeneration) },
                        { authentication.signOut(presentedGeneration) },
                        openWorkspaceSetup = {
                            try {
                                startActivity(
                                    Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WEB_ORIGIN))
                                )
                            } catch (_: ActivityNotFoundException) {
                                Toast.makeText(
                                        this,
                                        R.string.auth_browser_unavailable,
                                        Toast.LENGTH_LONG,
                                    )
                                    .show()
                            }
                        },
                        appUpdates = {
                            AppUpdateSettings(updateState, openUpdates, { updates.check() })
                        },
                    )
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // ComponentActivity writes Jetpack providers after the ordinary lifecycle callback.
        // Checking here also covers API 24-28, without the API 29-only post-save callback.
        if (BuildConfig.DEBUG) SavedStatePolicy.verify(outState)
    }

    override fun onResume() {
        super.onResume()
        session.refreshPreferences()
        updateSourceAuthorized =
            Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()
        (application as OkouApplication).updates.check(manual = false)
    }

    private fun installUpdate(release: AndroidUpdatesRelease) {
        val updates = (application as OkouApplication).updates
        lifecycleScope.launch {
            val file = updates.installationFile(release) ?: return@launch
            try {
                if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                    startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:$packageName"),
                        )
                    )
                } else {
                    val uri =
                        FileProvider.getUriForFile(this@MainActivity, "$packageName.updates", file)
                    startActivity(
                        Intent(Intent.ACTION_VIEW)
                            .setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    )
                }
            } catch (_: ActivityNotFoundException) {
                updates.installFailed(release)
            } catch (_: SecurityException) {
                updates.installFailed(release)
            }
        }
    }
}
