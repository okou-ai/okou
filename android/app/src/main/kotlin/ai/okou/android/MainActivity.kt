package ai.okou.android

import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.SessionRoot
import ai.okou.android.auth.SessionStage
import ai.okou.android.auth.WorkspaceSessionFactory
import ai.okou.android.preferences.applyApplicationLocale
import ai.okou.android.preferences.resetApplicationLocale
import ai.okou.android.state.SavedStatePolicy
import ai.okou.android.state.rememberUpdateDetailsOpen
import ai.okou.android.updates.AppUpdateSettings
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateHost
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.updates.updateToolbarAction
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.File
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private val updates
        get() = (application as OkouApplication).updates

    private val updateInstall by
        viewModels<UpdateInstallModel> {
            viewModelFactory { initializer { UpdateInstallModel(updates) } }
        }
    private val sourceSettings =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            updateInstall.authorizationReturned(canInstallPackages())
        }
    private val packageInstaller =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            updateInstall.installerReturned(result.resultCode == Activity.RESULT_FIRST_USER)
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
                    app.projectExpansionStore,
                    app.defaultModelStore,
                    settingsCache = app.workspaceSettingsCache,
                    searchRecents = app.searchRecents,
                    updatesRequired = app.updates.required,
                    connectivity = app.connectivity,
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
            val account by authentication.account.collectAsStateWithLifecycle(initialValue = null)
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
            val clearLocale =
                !updateState.preparing &&
                    when (sessionState.stage) {
                        SessionStage.SignIn,
                        SessionStage.ChooseWorkspace,
                        SessionStage.AccessRemoved -> true
                        else -> false
                    }
            LaunchedEffect(presentedGeneration, locale, updateRequired, clearLocale) {
                // Session restoration keeps the native locale until membership is resolved.
                if (updateRequired || !authentication.isPresentationCurrent(presentedGeneration))
                    return@LaunchedEffect
                when {
                    locale != null -> applyApplicationLocale(locale)
                    clearLocale -> resetApplicationLocale()
                }
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
                val updateDetails = rememberUpdateDetailsOpen()
                val attempt = updateInstall.attempt
                val pending = updateInstall.automaticRelease
                val installProgress =
                    updateInstall.progressLabel
                        ?: R.string.updates_waiting_to_install.takeIf {
                            pending != null &&
                                updateState.canInstall &&
                                updateState.selectedRelease == pending
                        }
                LaunchedEffect(
                    attempt,
                    pending,
                    updateState.selectedRelease,
                    updateState.canInstall,
                    lifecycleState,
                ) {
                    updateInstall.discardObsoleteDownload()
                    if (lifecycle.currentState != Lifecycle.State.RESUMED) return@LaunchedEffect
                    when (attempt) {
                        UpdateInstallAttempt.Idle -> {
                            if (updateState.canInstall)
                                updateInstall.automaticRelease?.let(::installUpdate)
                        }
                        is UpdateInstallAttempt.Verified -> launchInstaller(attempt)
                        else -> Unit
                    }
                }
                UpdateHost(
                    updateState.copy(required = updateRequired),
                    { updates.check() },
                    updateInstall::download,
                    ::installUpdate,
                    installProgress,
                    detailsOpen = updateDetails,
                ) { openUpdates ->
                    SessionRoot(
                        sessionState,
                        { authentication.retry(presentedGeneration) },
                        { id -> authentication.chooseWorkspace(id, presentedGeneration) },
                        { authentication.signOut(presentedGeneration) },
                        account = account,
                        openWorkspaceSetup = {
                            try {
                                startActivity(
                                    Intent(Intent.ACTION_VIEW, BuildConfig.WEB_ORIGIN.toUri()),
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
                            AppUpdateSettings(
                                updateState,
                                openUpdates,
                                updateDetails.value,
                            )
                        },
                        updateToolbarAction =
                            updateToolbarAction(
                                updateState,
                                updateInstall::download,
                                ::installUpdate,
                                installProgress,
                                openUpdates,
                            ),
                    )
                }
                val explanation = updateInstall.attempt as? UpdateInstallAttempt.Explain
                if (explanation != null) {
                    if (
                        updateState.canInstall && updateState.selectedRelease == explanation.release
                    ) {
                        val compact =
                            with(LocalDensity.current) {
                                currentWindowSizeDp().height.dp - 48.dp < 16.sp.toDp() * 12
                            }
                        AlertDialog(
                            onDismissRequest = { updateInstall.dismissExplanation(explanation) },
                            modifier = Modifier.widthIn(max = 360.dp),
                            shape = RoundedCornerShape(28.dp),
                            containerColor = MaterialTheme.colorScheme.surface,
                            title = {
                                Text(
                                    stringResource(R.string.updates_allow_install),
                                    style =
                                        MaterialTheme.typography.headlineSmall.copy(
                                            fontSize = if (compact) 20.sp else 24.sp,
                                            lineHeight = if (compact) 28.sp else 32.sp,
                                            fontWeight = FontWeight.SemiBold,
                                        ),
                                )
                            },
                            text = {
                                Text(
                                    stringResource(R.string.updates_permission),
                                    Modifier.verticalScroll(rememberScrollState()),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            },
                            confirmButton = {
                                val buttonShape = RoundedCornerShape(12.dp)
                                Button(
                                    onClick = { authorizeUpdate(explanation) },
                                    modifier =
                                        Modifier.heightIn(min = 48.dp)
                                            .updateFocusOutline(
                                                buttonShape,
                                                MaterialTheme.colorScheme.inverseOnSurface,
                                            ),
                                    shape = buttonShape,
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
                                    onClick = { updateInstall.dismissExplanation(explanation) },
                                    modifier =
                                        Modifier.heightIn(min = 48.dp)
                                            .updateFocusOutline(
                                                ButtonDefaults.shape,
                                                LocalActivityStatusColor.current,
                                            ),
                                    colors =
                                        ButtonDefaults.textButtonColors(
                                            contentColor = MaterialTheme.colorScheme.onSurface,
                                        ),
                                ) {
                                    Text(stringResource(R.string.updates_later))
                                }
                            },
                        )
                    } else {
                        LaunchedEffect(explanation) {
                            updateInstall.dismissExplanation(explanation)
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
        session.foregroundChanged(true)
        updates.check(manual = false)
    }

    override fun onPause() {
        session.foregroundChanged(false)
        super.onPause()
    }

    private fun canInstallPackages() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

    private fun authorizeUpdate(explanation: UpdateInstallAttempt.Explain) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!updateInstall.beginAuthorization(explanation, canInstallPackages())) return
        try {
            sourceSettings.launch(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:$packageName".toUri()),
            )
        } catch (_: ActivityNotFoundException) {
            updateInstall.launchFailed(explanation.release)
        } catch (_: SecurityException) {
            updateInstall.launchFailed(explanation.release)
        }
    }

    private fun installUpdate(release: AndroidUpdatesRelease) {
        updateInstall.install(release, canInstallPackages())
    }

    private fun launchInstaller(verified: UpdateInstallAttempt.Verified) {
        val file = updateInstall.takeVerifiedFile(verified, canInstallPackages()) ?: return
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.updates", file)
            packageInstaller.launch(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .putExtra(Intent.EXTRA_RETURN_RESULT, true)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        } catch (_: ActivityNotFoundException) {
            updateInstall.launchFailed(verified.release)
        } catch (_: SecurityException) {
            updateInstall.launchFailed(verified.release)
        }
    }
}

private class UpdateInstallModel(private val updates: AppUpdates) : ViewModel() {
    var attempt by mutableStateOf<UpdateInstallAttempt>(UpdateInstallAttempt.Idle)
        private set

    var automaticRelease by mutableStateOf<AndroidUpdatesRelease?>(null)
        private set

    @get:StringRes
    val progressLabel: Int?
        get() =
            when (attempt) {
                UpdateInstallAttempt.Idle -> null
                is UpdateInstallAttempt.Installer -> R.string.updates_installing
                else -> R.string.updates_preparing
            }

    fun download(release: AndroidUpdatesRelease) {
        if (updates.download(release)) automaticRelease = release
    }

    fun discardObsoleteDownload() {
        if (automaticRelease != updates.state.value.selectedRelease) automaticRelease = null
    }

    fun install(release: AndroidUpdatesRelease, authorized: Boolean) {
        if (attempt != UpdateInstallAttempt.Idle || !canInstall(release)) return
        automaticRelease = null
        updates.clearInstallFailure(release)
        if (authorized) verify(release) else attempt = UpdateInstallAttempt.Explain(release)
    }

    fun dismissExplanation(explanation: UpdateInstallAttempt.Explain) {
        if (attempt == explanation) attempt = UpdateInstallAttempt.Idle
    }

    fun beginAuthorization(
        explanation: UpdateInstallAttempt.Explain,
        authorized: Boolean,
    ): Boolean {
        if (attempt != explanation) return false
        val release = explanation.release
        if (!canInstall(release)) {
            dismissExplanation(explanation)
            return false
        }
        if (authorized) {
            verify(release)
            return false
        }
        attempt = UpdateInstallAttempt.Authorizing(release)
        return true
    }

    fun authorizationReturned(authorized: Boolean) {
        val pending = attempt as? UpdateInstallAttempt.Authorizing ?: return
        attempt = UpdateInstallAttempt.Idle
        if (authorized) install(pending.release, authorized = true)
    }

    private fun verify(release: AndroidUpdatesRelease) {
        attempt = UpdateInstallAttempt.Verifying
        viewModelScope.launch {
            try {
                val file = updates.installationFile(release) ?: return@launch
                attempt = UpdateInstallAttempt.Verified(release, file)
            } finally {
                if (attempt == UpdateInstallAttempt.Verifying) attempt = UpdateInstallAttempt.Idle
            }
        }
    }

    fun takeVerifiedFile(verified: UpdateInstallAttempt.Verified, authorized: Boolean): File? {
        if (attempt != verified) return null
        val release = verified.release
        if (!canInstall(release)) {
            attempt = UpdateInstallAttempt.Idle
            return null
        }
        if (!authorized) {
            attempt = UpdateInstallAttempt.Explain(release)
            return null
        }
        attempt = UpdateInstallAttempt.Installer(release)
        return verified.file
    }

    fun installerReturned(failed: Boolean) {
        val installer = attempt as? UpdateInstallAttempt.Installer ?: return
        if (failed) updates.installFailed(installer.release)
        attempt = UpdateInstallAttempt.Idle
    }

    fun launchFailed(release: AndroidUpdatesRelease) {
        attempt = UpdateInstallAttempt.Idle
        updates.installFailed(release)
    }

    private fun canInstall(release: AndroidUpdatesRelease): Boolean {
        val current = updates.state.value
        return current.canInstall && current.selectedRelease == release
    }
}

private sealed interface UpdateInstallAttempt {
    data object Idle : UpdateInstallAttempt

    data class Explain(val release: AndroidUpdatesRelease) : UpdateInstallAttempt

    data class Authorizing(val release: AndroidUpdatesRelease) : UpdateInstallAttempt

    data object Verifying : UpdateInstallAttempt

    data class Verified(val release: AndroidUpdatesRelease, val file: File) : UpdateInstallAttempt

    data class Installer(val release: AndroidUpdatesRelease) : UpdateInstallAttempt
}
