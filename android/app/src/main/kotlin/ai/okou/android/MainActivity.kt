package ai.okou.android

import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.SessionRoot
import ai.okou.android.auth.SessionStage
import ai.okou.android.auth.WorkspaceSessionFactory
import ai.okou.android.preferences.applyApplicationLocale
import ai.okou.android.state.SavedStatePolicy
import ai.okou.android.updates.AppUpdateSettings
import ai.okou.android.updates.UpdateHost
import ai.okou.android.updates.updateToolbarAction
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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.withResumed
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private val updates
        get() = (application as OkouApplication).updates

    private var editing by mutableStateOf(false)
    private var windowFocused by mutableStateOf(false)
    private val updateInstall by
        viewModels<UpdateInstallModel> { viewModelFactory { initializer { UpdateInstallModel() } } }
    private val sourceSettings =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val pending = updateInstall.attempt as? UpdateInstallAttempt.Authorizing
            if (pending != null) {
                updateInstall.attempt = UpdateInstallAttempt.Idle
                if (canInstallPackages()) installUpdate(pending.release)
            }
        }
    private val packageInstaller =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (updateInstall.attempt == UpdateInstallAttempt.Installer)
                updateInstall.attempt = UpdateInstallAttempt.Idle
        }
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
                    app.runControlJournal,
                    app.memberAppearanceCache,
                    updatesRequired = app.updates.required,
                )
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val authentication = session
        setContent {
            val sessionState by authentication.uiState.collectAsStateWithLifecycle()
            val updateState by updates.state.collectAsStateWithLifecycle()
            val lifecycleState by lifecycle.currentStateAsState()
            val updateRequired =
                updateState.required || sessionState.stage == SessionStage.UpdateRequired
            // Capture the rendered owner, rather than reading a newer State value on an old click.
            val presentedGeneration = sessionState.generation
            val preferences =
                key(presentedGeneration) {
                    // A new workspace must not inherit collectAsState's remembered value from its
                    // predecessor.
                    sessionState.ready?.preferences?.uiState?.collectAsStateWithLifecycle()?.value
                }
            val locale = preferences?.locale
            LaunchedEffect(presentedGeneration, locale, updateRequired, updateState.preparing) {
                // Keep the applied native locale while the required screen blocks workspace access.
                if (
                    !updateRequired &&
                        (locale != null || !updateState.preparing) &&
                        authentication.isPresentationCurrent(presentedGeneration)
                )
                    applyApplicationLocale(locale)
            }
            val systemDark = isSystemInDarkTheme()
            val cachedAppearance = sessionState.cachedAppearance
            val theme = preferences?.theme ?: cachedAppearance?.theme
            val dark = theme?.resolveDark(systemDark) ?: systemDark
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
                    ?: cachedAppearance?.colorTheme
                    ?: UserPreferencesColorTheme.DEFAULT,
            ) {
                val installEnabled = updateInstall.attempt == UpdateInstallAttempt.Idle
                val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
                val pending = updateInstall.automaticRelease
                val automaticInstall =
                    pending?.takeIf {
                        installEnabled &&
                            updateState.canInstall &&
                            updateState.selectedRelease == it &&
                            lifecycleState == Lifecycle.State.RESUMED &&
                            !editing &&
                            !keyboardVisible
                    }
                LaunchedEffect(pending, updateState.selectedRelease) {
                    if (
                        pending != null &&
                            updates.state.value.selectedRelease != pending &&
                            updateInstall.automaticRelease == pending
                    )
                        updateInstall.automaticRelease = null
                }
                UpdateHost(
                    updateState.copy(required = updateRequired),
                    { updates.check() },
                    ::downloadUpdate,
                    updates::defer,
                    ::installUpdate,
                    installEnabled,
                    automaticInstall,
                    windowFocused,
                    startAutomaticInstall = { installUpdate(it, automatic = true) },
                    showAnnouncement =
                        sessionState.stage != SessionStage.Ready || sessionState.ready == null,
                ) { openUpdates ->
                    SessionRoot(
                        sessionState,
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
                        appUpdates = { AppUpdateSettings(updateState, openUpdates) },
                        updateToolbarAction =
                            updateToolbarAction(
                                updateState,
                                ::downloadUpdate,
                                ::installUpdate,
                                installEnabled,
                                openUpdates,
                            ),
                        onUpdateEditingChanged = { editing = it },
                    )
                }
                val explanation = updateInstall.attempt as? UpdateInstallAttempt.Explain
                if (explanation != null) {
                    if (
                        updateState.canInstall && updateState.selectedRelease == explanation.release
                    ) {
                        AlertDialog(
                            onDismissRequest = {
                                updateInstall.attempt = UpdateInstallAttempt.Idle
                            },
                            shape = RoundedCornerShape(28.dp),
                            containerColor = MaterialTheme.colorScheme.surface,
                            title = {
                                Text(
                                    stringResource(R.string.updates_allow_install),
                                    style =
                                        MaterialTheme.typography.headlineSmall.copy(
                                            fontWeight = FontWeight.SemiBold
                                        ),
                                )
                            },
                            text = {
                                Text(
                                    stringResource(R.string.updates_permission),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            },
                            confirmButton = {
                                Button(
                                    onClick = { authorizeUpdate(explanation) },
                                    shape = RoundedCornerShape(12.dp),
                                    colors =
                                        ButtonDefaults.buttonColors(
                                            containerColor =
                                                MaterialTheme.colorScheme.inverseSurface,
                                            contentColor =
                                                MaterialTheme.colorScheme.inverseOnSurface,
                                        ),
                                ) {
                                    Text(stringResource(R.string.updates_open_settings))
                                }
                            },
                            dismissButton = {
                                TextButton(
                                    onClick = { updateInstall.attempt = UpdateInstallAttempt.Idle },
                                    colors =
                                        ButtonDefaults.textButtonColors(
                                            contentColor = MaterialTheme.colorScheme.onSurface
                                        ),
                                ) {
                                    Text(stringResource(R.string.updates_later))
                                }
                            },
                        )
                    } else {
                        LaunchedEffect(explanation) {
                            if (updateInstall.attempt == explanation)
                                updateInstall.attempt = UpdateInstallAttempt.Idle
                        }
                    }
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
        updates.check(manual = false)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        windowFocused = hasFocus
    }

    private fun canInstallPackages() =
        Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()

    private fun canAutomaticallyInstall() =
        lifecycle.currentState == Lifecycle.State.RESUMED &&
            windowFocused &&
            !editing &&
            ViewCompat.getRootWindowInsets(window.decorView)
                ?.isVisible(WindowInsetsCompat.Type.ime()) != true

    private fun downloadUpdate(release: AndroidUpdatesRelease) {
        if (updates.download(release)) updateInstall.automaticRelease = release
    }

    private fun authorizeUpdate(explanation: UpdateInstallAttempt.Explain) {
        if (updateInstall.attempt != explanation) return
        val release = explanation.release
        val current = updates.state.value
        updateInstall.attempt = UpdateInstallAttempt.Idle
        if (!current.canInstall || current.selectedRelease != release) return
        if (canInstallPackages()) {
            installUpdate(release)
            return
        }
        updateInstall.attempt = UpdateInstallAttempt.Authorizing(release)
        try {
            sourceSettings.launch(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                )
            )
        } catch (_: ActivityNotFoundException) {
            updateInstall.attempt = UpdateInstallAttempt.Idle
            updates.installFailed(release)
        } catch (_: SecurityException) {
            updateInstall.attempt = UpdateInstallAttempt.Idle
            updates.installFailed(release)
        }
    }

    private fun installUpdate(release: AndroidUpdatesRelease) =
        installUpdate(release, automatic = false)

    private fun installUpdate(release: AndroidUpdatesRelease, automatic: Boolean) {
        if (updateInstall.attempt != UpdateInstallAttempt.Idle) return
        if (automatic && (updateInstall.automaticRelease != release || !canAutomaticallyInstall()))
            return
        val current = updates.state.value
        if (!current.canInstall || current.selectedRelease != release) return
        if (!canInstallPackages()) {
            updateInstall.automaticRelease = null
            updateInstall.attempt = UpdateInstallAttempt.Explain(release)
            return
        }
        updateInstall.attempt = UpdateInstallAttempt.Verifying
        lifecycleScope.launch {
            try {
                val file = updates.installationFile(release) ?: return@launch
                lifecycle.withResumed {
                    val eligible = updates.state.value
                    if (!eligible.canInstall || eligible.selectedRelease != release)
                        return@withResumed
                    if (automatic && !canAutomaticallyInstall()) return@withResumed
                    updateInstall.automaticRelease = null
                    if (!canInstallPackages()) {
                        updateInstall.attempt = UpdateInstallAttempt.Explain(release)
                        return@withResumed
                    }
                    val uri =
                        FileProvider.getUriForFile(this@MainActivity, "$packageName.updates", file)
                    updateInstall.attempt = UpdateInstallAttempt.Installer
                    packageInstaller.launch(
                        Intent(Intent.ACTION_VIEW)
                            .setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    )
                }
            } catch (_: ActivityNotFoundException) {
                updateInstall.attempt = UpdateInstallAttempt.Idle
                updates.installFailed(release)
            } catch (_: SecurityException) {
                updateInstall.attempt = UpdateInstallAttempt.Idle
                updates.installFailed(release)
            } finally {
                if (updateInstall.attempt == UpdateInstallAttempt.Verifying)
                    updateInstall.attempt = UpdateInstallAttempt.Idle
            }
        }
    }
}

private class UpdateInstallModel : ViewModel() {
    var attempt by mutableStateOf<UpdateInstallAttempt>(UpdateInstallAttempt.Idle)
    var automaticRelease by mutableStateOf<AndroidUpdatesRelease?>(null)
}

private sealed interface UpdateInstallAttempt {
    data object Idle : UpdateInstallAttempt

    data class Explain(val release: AndroidUpdatesRelease) : UpdateInstallAttempt

    data class Authorizing(val release: AndroidUpdatesRelease) : UpdateInstallAttempt

    data object Verifying : UpdateInstallAttempt

    data object Installer : UpdateInstallAttempt
}
