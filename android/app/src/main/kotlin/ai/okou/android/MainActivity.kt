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
import ai.okou.android.updates.UpdateUiState
import ai.okou.android.updates.updateToolbarAction
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.ViewTreeObserver
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.res.stringResource
import androidx.core.content.FileProvider
import androidx.core.graphics.drawable.toDrawable
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.File
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
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
                    app.runControlOwners,
                    app.memberPreferencesCache,
                    app.projectExpansionStore,
                    app.defaultModelStore,
                    settingsCache = app.workspaceSettingsCache,
                    searchRecents = app.searchRecents,
                    updatesRequired = app.updates.required,
                )
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val authentication = session
        if (savedInstanceState == null) keepColdStartWindow(authentication)
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
            val cachedPreferences = sessionState.cachedPreferences
            val locale = preferences?.locale ?: cachedPreferences?.locale
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
            val theme = preferences?.theme ?: cachedPreferences?.theme
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
                    ?: cachedPreferences?.colorTheme
                    ?: UserPreferencesColorTheme.DEFAULT,
            ) {
                val windowBackground = MaterialTheme.colorScheme.background.toArgb()
                LaunchedEffect(windowBackground) {
                    // The native window can expose its backdrop at the system insets after
                    // recreation.
                    window.setBackgroundDrawable(windowBackground.toDrawable())
                }
                val updateDetails = rememberUpdateDetailsOpen()
                val attempt = updateInstall.attempt
                val pending = updateInstall.automaticRelease
                val installProgress = updateInstall.progressLabel(updateState)
                LaunchedEffect(
                    attempt,
                    pending,
                    updateState.selectedRelease,
                    updateState.canInstall,
                    lifecycleState,
                ) {
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
                    { updateInstall.download(it, advanceRetry = true) },
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
                            authentication.openWorkspaceSetup(presentedGeneration) {
                                try {
                                    startActivity(
                                        Intent(Intent.ACTION_VIEW, BuildConfig.WEB_ORIGIN.toUri()),
                                    )
                                    true
                                } catch (_: ActivityNotFoundException) {
                                    false
                                }
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
                                    { updateInstall.download(it) },
                                    ::installUpdate,
                                    installProgress,
                                    openUpdates,
                                )
                                ?.copy(detailsOpen = updateDetails.value),
                    )
                }
                if (
                    attempt is UpdateInstallAttempt.Explain &&
                        updateState.canInstall &&
                        updateState.selectedRelease == attempt.release
                ) {
                    OkouConfirmationDialog(
                        title = stringResource(R.string.updates_allow_install),
                        confirm = stringResource(R.string.updates_open_settings),
                        onDismiss = { updateInstall.dismissExplanation(attempt) },
                        onConfirm = { authorizeUpdate(attempt) },
                        dismissLabel = stringResource(R.string.updates_later),
                        keepActionsVisible = true,
                    ) {
                        Text(stringResource(R.string.updates_permission))
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

    private fun keepColdStartWindow(authentication: SessionModel) {
        val content = findViewById<android.view.View>(android.R.id.content)
        // Leave the launch window up briefly. A slow Clerk initialization must not hold drawing.
        val deadline = SystemClock.uptimeMillis() + 500
        content.viewTreeObserver.addOnPreDrawListener(
            object : ViewTreeObserver.OnPreDrawListener {
                override fun onPreDraw(): Boolean {
                    if (
                        authentication.uiState.value.stage == SessionStage.Restoring &&
                            SystemClock.uptimeMillis() < deadline
                    ) {
                        content.postInvalidateOnAnimation()
                        return false
                    }
                    content.viewTreeObserver.removeOnPreDrawListener(this)
                    return true
                }
            },
        )
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

    init {
        viewModelScope.launch {
            updates.state.collect { state ->
                if (automaticRelease != state.selectedRelease) automaticRelease = null
                val localAttempt = attempt as? UpdateInstallAttempt.PreHandoff ?: return@collect
                if (!state.canInstall || state.selectedRelease != localAttempt.release) {
                    attempt = UpdateInstallAttempt.Idle
                    if (localAttempt is UpdateInstallAttempt.Verifying) localAttempt.work.cancel()
                }
            }
        }
    }

    @StringRes
    fun progressLabel(state: UpdateUiState): Int? {
        if (!state.canInstall) return null
        val current = attempt
        if (current is UpdateInstallAttempt.Installer && current.release == state.selectedRelease)
            return R.string.updates_installing
        return R.string.updates_waiting_to_install.takeIf {
            current != UpdateInstallAttempt.Idle || automaticRelease == state.selectedRelease
        }
    }

    fun download(release: AndroidUpdatesRelease, advanceRetry: Boolean = false) {
        if (updates.download(release, advanceRetry)) automaticRelease = release
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
        val verification = UpdateInstallAttempt.Verifying(release)
        verification.work =
            viewModelScope.launch(start = CoroutineStart.LAZY) {
                try {
                    val file = updates.installationFile(release) ?: return@launch
                    if (attempt === verification) {
                        attempt = UpdateInstallAttempt.Verified(release, file)
                    }
                } finally {
                    if (attempt === verification) attempt = UpdateInstallAttempt.Idle
                }
            }
        attempt = verification
        verification.work.start()
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

    sealed interface PreHandoff : UpdateInstallAttempt {
        val release: AndroidUpdatesRelease
    }

    data class Explain(override val release: AndroidUpdatesRelease) : PreHandoff

    data class Authorizing(val release: AndroidUpdatesRelease) : UpdateInstallAttempt

    class Verifying(override val release: AndroidUpdatesRelease) : PreHandoff {
        lateinit var work: Job
    }

    data class Verified(override val release: AndroidUpdatesRelease, val file: File) : PreHandoff

    data class Installer(val release: AndroidUpdatesRelease) : UpdateInstallAttempt
}
