package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.ClerkAuthentication
import ai.okou.android.auth.SessionEntryFailure
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.testAuthenticationState
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import android.animation.ValueAnimator
import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.provider.Settings
import android.view.KeyEvent
import androidx.annotation.StringRes
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import com.clerk.api.Clerk
import com.clerk.api.sso.OAuthProvider
import com.clerk.api.sso.providerName
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.CompletableDeferred
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val auth = app.authentication as TestAuthentication
    private val identifier = By.res("clerk.auth.start.identifier")

    @Test
    fun membershipReadRecoversAfterARejectedSignOut() {
        val originalState = auth.state.value
        val originalMembershipsAction = auth.membershipsAction
        val originalSignOutAction = auth.signOutAction
        val workspaces = auth.available
        val allowFailures = CompletableDeferred<Unit>()
        val allowRecovery = CompletableDeferred<Unit>()
        val finishSignOut = CompletableDeferred<Unit>()
        val attempts = AtomicInteger()

        try {
            auth.state.value = AuthenticationState()
            auth.membershipsAction = {
                allowFailures.await()
                if (attempts.incrementAndGet() <= 3) throw ApiFailure.Http(429, null, null, 0)
                allowRecovery.await()
                workspaces
            }
            auth.signOutAction = { finishSignOut.await() }

            ActivityScenario.launch(MainActivity::class.java).use {
                auth.state.value = testAuthenticationState(workspace = null)
                find(R.string.auth_preparing_workspace)
                ScreenshotCapture.capture("preparing-workspace.png")

                allowFailures.complete(Unit)
                find(R.string.auth_unavailable)
                check(!device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.retry))))
                ScreenshotCapture.capture("workspace-unavailable.png")

                find(R.string.auth_sign_out).click()
                find(R.string.settings_sign_out_title)
                ScreenshotCapture.capture("retry-sign-out-confirmation.png")
                checkNotNull(device.findObjects(By.pkg(app.packageName).text(app.getString(R.string.auth_sign_out))).lastOrNull()).click()
                find(R.string.auth_signing_out)

                finishSignOut.completeExceptionally(IllegalStateException("Fixture sign-out rejected"))
                find(R.string.auth_unavailable)
                find(R.string.auth_sign_out_failed)
                find(R.string.auth_sign_out)
                check(!device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.retry))))
                ScreenshotCapture.capture("workspace-after-rejected-sign-out.png")

                allowRecovery.complete(Unit)
                find(R.string.auth_choose_workspace)
                find(R.string.auth_sign_out_failed)
                workspaces.forEach { workspace ->
                    val row = By.pkg(app.packageName).text(workspace.name)
                    check(device.wait(Until.hasObject(row), 5_000) == true) {
                        "Timed out waiting for ${workspace.name}"
                    }
                }
                check(attempts.get() == 4)
                ScreenshotCapture.capture("workspace-recovered.png")
            }
        } finally {
            auth.membershipsAction = originalMembershipsAction
            auth.signOutAction = originalSignOutAction
            auth.state.value = originalState
            allowFailures.complete(Unit)
            allowRecovery.complete(Unit)
            finishSignOut.complete(Unit)
        }
    }

    @Test
    fun sessionEntryStagesAndCurrentActions() {
        val previous = auth.state.value
        val workspaces = auth.available
        val memberships = auth.membershipsAction
        val refresh = auth.refreshAction
        val signOut = auth.signOutAction
        val membershipGate = CompletableDeferred<Unit>()
        val exitGate = CompletableDeferred<Unit>()
        val scaleSettings =
            listOf(
                "window_animation_scale",
                "transition_animation_scale",
                "animator_duration_scale",
            )
        val originalScales = scaleSettings.associateWith {
            device.executeShellCommand("settings get global $it").trim()
        }
        try {
            // Configure the first Compose window before its process-wide scale observer starts.
            instrumentation.uiAutomation.setAnimationScale(1f)
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            ValueAnimator.areAnimatorsEnabled() &&
                                Settings.Global.getFloat(
                                    app.contentResolver,
                                    "animator_duration_scale",
                                    0f,
                                ) == 1f
                    },
                    5_000,
                ) == true,
            ) {
                "The emulator did not enable system animator scale"
            }
            auth.state.value = AuthenticationState()
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                find(R.string.app_name)

                auth.membershipsAction = {
                    membershipGate.await()
                    auth.available
                }
                auth.state.value = testAuthenticationState(workspace = null)
                val waitingTitle = find(R.string.auth_preparing_workspace).visibleBounds
                check(kotlin.math.abs(waitingTitle.centerX() - device.displayWidth / 2) <= 2)
                captureWaiting(R.string.auth_preparing_workspace, "preparing.png")
                instrumentation.uiAutomation.setAnimationScale(0f)
                check(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean =
                                !ValueAnimator.areAnimatorsEnabled()
                        },
                        5_000,
                    ) == true,
                )
                captureWaiting(R.string.auth_preparing_workspace, "preparing-reduced-motion.png")
                check(waitingTitle == find(R.string.auth_preparing_workspace).visibleBounds)
                instrumentation.uiAutomation.setAnimationScale(1f)
                membershipGate.complete(Unit)

                find(R.string.auth_choose_workspace)
                val row = By.pkg(app.packageName).text(workspaces.first().name)
                find(By.text(workspaces.last().name))
                ScreenshotCapture.capture("choose-workspace.png")
                auth.refreshAction = { session ->
                    if (session.workspaceId == workspaces.first().id) {
                        throw ApiFailure.Http(503, null, null, null)
                    }
                }
                focusFirstAction(row)
                check(device.pressDPadCenter())
                capture(R.string.auth_selection_failed, "selection-failed.png")
                device.awaitKeyboardFocus(By.copy(row))
                check(auth.state.value.session?.workspaceId == workspaces.first().id)
                auth.refreshAction = refresh
                find(By.text(workspaces.first().name)).click()
                device.awaitChatList(app)

                auth.refreshAction = { throw ApiFailure.Unauthenticated() }
                auth.state.value = testAuthenticationState(session = "lost-access")
                find(R.string.auth_check_access)
                find(R.string.auth_sign_in_again)
                capture(R.string.auth_access_removed, "access-removed.png")

                auth.refreshAction = refresh
                auth.available = emptyList()
                auth.state.value =
                    testAuthenticationState(session = "no-workspace", workspace = null)
                find(R.string.auth_workspace_setup)
                find(R.string.auth_check_workspace)
                capture(R.string.auth_no_workspace, "no-workspace.png")
                val pendingCheck = CompletableDeferred<Unit>()
                auth.membershipsAction = {
                    pendingCheck.await()
                    error("Fixture membership read failed")
                }
                find(R.string.auth_check_workspace).click()
                capture(R.string.auth_checking_workspace, "checking.png")
                scenario.onActivity { activity ->
                    val model = ViewModelProvider(activity)[SessionModel::class.java]
                    model.openWorkspaceSetup(model.uiState.value.generation) { false }
                }
                capture(R.string.auth_browser_unavailable, "browser-unavailable.png")
                val confirmation = By.text(app.getString(R.string.settings_sign_out_title))
                find(R.string.auth_sign_out).click()
                find(confirmation)
                pendingCheck.complete(Unit)
                check(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                var failed = false
                                scenario.onActivity { activity ->
                                    val model =
                                        ViewModelProvider(activity)[SessionModel::class.java]
                                    failed =
                                        model.uiState.value.entryFailure == SessionEntryFailure.Check
                                }
                                return failed
                            }
                        },
                        5_000,
                    ) == true,
                ) {
                    "The held workspace check did not publish its failure"
                }
                device.waitForIdle(5_000)
                capture(R.string.settings_sign_out_title, "sign-out-after-check-failure.png")
                device.pressBack()
                check(device.wait(Until.gone(confirmation), 5_000) == true)
                capture(R.string.auth_check_failed, "check-failed.png")
                auth.state.value =
                    testAuthenticationState(session = "initial-error", workspace = null)
                capture(R.string.auth_unavailable, "unavailable.png")

                auth.signOutAction = { exitGate.await() }
                find(R.string.auth_sign_out).click()
                capture(R.string.settings_sign_out_title, "sign-out-confirmation.png")
                val actions = device.findObjects(By.text(app.getString(R.string.auth_sign_out)))
                checkNotNull(actions.lastOrNull()).click()
                captureWaiting(R.string.auth_signing_out, "signing-out.png")
            }
        } finally {
            membershipGate.complete(Unit)
            exitGate.complete(Unit)
            auth.membershipsAction = memberships
            auth.refreshAction = refresh
            auth.signOutAction = signOut
            auth.available = workspaces
            auth.state.value = previous
            instrumentation.setInTouchMode(true)
            originalScales.forEach { (setting, value) ->
                if (value == "null") device.executeShellCommand("settings delete global $setting")
                else device.executeShellCommand("settings put global $setting $value")
            }
        }
    }

    @Test
    fun verifyAccessCheckKeepsItsFilledActionAndFocus() {
        val previous = auth.state.value
        val refresh = auth.refreshAction
        val response = CompletableDeferred<Unit>()
        val checkAccess = By.pkg(app.packageName).text(app.getString(R.string.auth_check_access))
        try {
            auth.refreshAction = { throw ApiFailure.Unauthenticated() }
            auth.state.value = testAuthenticationState(session = "access-keyboard")
            ActivityScenario.launch(MainActivity::class.java).use {
                find(R.string.auth_access_removed)
                focusFirstAction(checkAccess)
                val bounds = find(checkAccess).visibleBounds
                auth.refreshAction = {
                    response.await()
                    throw ApiFailure.Http(503, null, null, null)
                }
                check(device.pressDPadCenter())
                find(R.string.auth_checking_workspace)
                device.awaitKeyboardFocus(By.copy(checkAccess))
                check(find(checkAccess).visibleBounds == bounds)
                find(R.string.auth_sign_in_again)
                captureFocusOutline(checkAccess, "access-keyboard-pending.png")
                response.complete(Unit)
                find(R.string.auth_check_failed)
                device.awaitKeyboardFocus(By.copy(checkAccess))
            }
        } finally {
            response.complete(Unit)
            auth.refreshAction = refresh
            auth.state.value = previous
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    fun verifyPickerAndCheckKeepKeyboardFocus() {
        val previous = auth.state.value
        val workspaces = auth.available
        val memberships = auth.membershipsAction
        val response = CompletableDeferred<Unit>()
        val requests = AtomicInteger()
        try {
            auth.state.value = testAuthenticationState(session = "picker-keyboard", workspace = null)
            ActivityScenario.launch(MainActivity::class.java).use {
                find(R.string.auth_choose_workspace)
                val workspace = By.pkg(app.packageName).text(workspaces.first().name)
                focusFirstAction(workspace)
                ScreenshotCapture.capture("workspace-picker-keyboard.png")
            }

            auth.available = emptyList()
            auth.state.value = testAuthenticationState(session = "empty-keyboard", workspace = null)
            ActivityScenario.launch(MainActivity::class.java).use {
                find(R.string.auth_no_workspace)
                val setup =
                    By.pkg(app.packageName).text(app.getString(R.string.auth_workspace_setup))
                focusFirstAction(setup)
                ScreenshotCapture.capture("setup-keyboard.png")
                val checkWorkspaces =
                    By.pkg(app.packageName).text(app.getString(R.string.auth_check_workspace))
                check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                device.awaitKeyboardFocus(By.copy(checkWorkspaces))
                val bounds = find(checkWorkspaces).visibleBounds
                auth.membershipsAction = {
                    requests.incrementAndGet()
                    response.await()
                    error("Fixture workspace check failed")
                }
                check(device.pressDPadCenter())
                find(R.string.auth_checking_workspace)
                device.awaitKeyboardFocus(By.copy(checkWorkspaces))
                check(find(checkWorkspaces).visibleBounds == bounds)
                find(setup)
                find(R.string.auth_sign_out)
                ScreenshotCapture.capture("check-keyboard-pending.png")
                check(device.pressDPadCenter())

                response.complete(Unit)
                find(R.string.auth_check_failed)
                device.awaitKeyboardFocus(By.copy(checkWorkspaces))
                check(find(checkWorkspaces).visibleBounds == bounds)
                check(requests.get() == 1)
                ScreenshotCapture.capture("check-keyboard-failed.png")
            }
        } finally {
            response.complete(Unit)
            auth.membershipsAction = memberships
            auth.available = workspaces
            auth.state.value = previous
            instrumentation.setInTouchMode(true)
        }
    }

    private fun focusFirstAction(selector: BySelector) {
        find(selector)
        instrumentation.setInTouchMode(false)
        val label = By.copy(selector).focused(true)
        val control = By.focused(true).hasChild(By.copy(selector))
        repeat(6) {
            device.waitForIdle(1_000)
            if (device.hasObject(label) || device.hasObject(control)) return
            check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
        }
        device.awaitKeyboardFocus(By.copy(selector))
    }

    private fun captureFocusOutline(selector: BySelector, name: String) {
        val focusedLabel = By.copy(selector).focused(true)
        val focusedControl = By.focused(true).hasChild(By.copy(selector))
        val bounds = (device.findObject(focusedLabel) ?: find(focusedControl)).visibleBounds
        val focusColor = Color.rgb(33, 26, 19)
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        val screen = instrumentation.uiAutomation.takeScreenshot() ?: return false
                        return try {
                            val frame = screen.copy(Bitmap.Config.ARGB_8888, false) ?: return false
                            try {
                                val x = bounds.centerX()
                                (bounds.top until minOf(bounds.top + 24, bounds.bottom)).any { y ->
                                    frame.getPixel(x, y) == focusColor
                                }
                            } finally {
                                frame.recycle()
                            }
                        } finally {
                            screen.recycle()
                        }
                    }
                },
                5_000,
            ) == true,
        ) { "The focused action did not show the theme outline: $selector" }
        ScreenshotCapture.capture(name)
    }

    @Test
    fun verifyRestorationContinuesToNativeClerkForm() {
        val previous = auth.state.value
        try {
            auth.state.value = AuthenticationState()
            instrumentation.runOnMainSync { ClerkAuthentication(app).initialize() }
            ActivityScenario.launch(MainActivity::class.java).use {
                find(R.string.app_name)
                check(!device.hasObject(identifier))
                ScreenshotCapture.capture("restoring-brand.png")

                auth.state.value = AuthenticationState(initialized = true)
                find(identifier)
                find(By.res("clerk.auth.start.continue"))
                find(R.string.app_name)
                awaitSocialProviderLabels()
                ScreenshotCapture.capture("sign-in.png")
            }
        } finally {
            auth.state.value = previous
        }
    }

    @Test
    fun verifySignOutConfirmationFocus() {
        val previous = auth.state.value
        val workspaces = auth.available
        val title = By.text(app.getString(R.string.settings_sign_out_title))
        val signOut = By.text(app.getString(R.string.auth_sign_out))
        val cancel = By.text(app.getString(R.string.settings_cancel))
        try {
            auth.available = emptyList()
            auth.state.value = testAuthenticationState(session = "confirm-keyboard", workspace = null)
            ActivityScenario.launch(MainActivity::class.java).use {
                find(R.string.auth_no_workspace)
                focusFirstAction(By.text(app.getString(R.string.auth_workspace_setup)))
                repeat(2) { check(device.pressKeyCode(KeyEvent.KEYCODE_TAB)) }
                device.awaitKeyboardFocus(By.copy(signOut))
                check(device.pressDPadCenter())
                find(title)
                verifyConfirmationSpacing(16, 24)
                focusFirstAction(cancel)
                captureFocusOutline(cancel, "sign-out-cancel-focused.png")
                check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                device.awaitKeyboardFocus(By.copy(signOut))
                captureFocusOutline(signOut, "sign-out-confirm-focused.png")
                check(device.pressKeyCode(KeyEvent.KEYCODE_TAB, KeyEvent.META_SHIFT_ON))
                device.awaitKeyboardFocus(By.copy(cancel))
                check(device.pressDPadCenter())
                check(device.wait(Until.gone(title), 5_000) == true)
                find(R.string.auth_no_workspace)
                device.awaitKeyboardFocus(By.copy(signOut))
            }
        } finally {
            instrumentation.setInTouchMode(true)
            auth.available = workspaces
            auth.state.value = previous
        }
    }

    private fun verifyConfirmationSpacing(titleGapDp: Int, actionGapDp: Int) {
        val heading = find(R.string.settings_sign_out_title).visibleBounds
        val body = find(R.string.settings_sign_out_body).visibleBounds
        val cancelLabel = find(R.string.settings_cancel)
        val cancel = generateSequence(cancelLabel) { it.parent }.first { it.isClickable }
        val action = cancel.visibleBounds
        val density = app.resources.displayMetrics.density
        val titleGap = body.top - heading.bottom
        val actionGap = action.top - body.bottom
        check(abs(titleGap - (titleGapDp * density).roundToInt()) <= 1) {
            "Title-to-body gap was $titleGap px at $density density, expected $titleGapDp dp"
        }
        check(abs(actionGap - (actionGapDp * density).roundToInt()) <= 1) {
            "Body-to-actions gap was $actionGap px at $density density, expected $actionGapDp dp"
        }
        check(action.height() >= (48 * density).roundToInt())
    }

    @Test
    fun wideSignInAndWorkspacePicker() {
        val previous = auth.state.value
        val originalSize = overrideValue("wm size")
        val originalDensity = overrideValue("wm density")
        try {
            auth.state.value = AuthenticationState(initialized = true)
            instrumentation.runOnMainSync { ClerkAuthentication(app).initialize() }
            device.executeShellCommand("wm size 840x960")
            device.executeShellCommand("wm density 160")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                awaitConfiguration(scenario, "wide portrait viewport") {
                    it.screenWidthDp >= 600 && it.screenHeightDp >= 480
                }
                find(identifier)
                awaitSocialProviderLabels()
                val brand = find(R.string.app_name).visibleBounds
                ScreenshotCapture.capture("wide-sign-in.png")
                auth.state.value =
                    testAuthenticationState(session = "wide-entry", workspace = null)
                find(R.string.auth_choose_workspace)
                check(kotlin.math.abs(find(R.string.app_name).visibleBounds.top - brand.top) <= 1)
                ScreenshotCapture.capture("wide-workspace-picker.png")
            }
        } finally {
            auth.state.value = previous
            device.executeShellCommand("wm size $originalSize")
            device.executeShellCommand("wm density $originalDensity")
        }
    }

    @Test
    fun requiredUpdateUsesTheEntryBrandAndKeepsItsActionVisible() {
        val originalSize = overrideValue("wm size")
        val originalDensity = overrideValue("wm density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val previous = app.updateOwner
        val authState = auth.state.value
        val workspaces = auth.available
        val release =
            AndroidUpdatesRelease(
                "99.1.0",
                24,
                10_200_000,
                "a".repeat(64),
                "https://static.okou.io/unused",
                "",
            )
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize(retainedRelease: AndroidUpdatesRelease?) = Unit

                    override suspend fun check() = AndroidUpdates(null, release)

                    override suspend fun recover(release: AndroidUpdatesRelease): File? = null

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File = error("This scenario only verifies the required-update action")

                    override fun close() = Unit
                },
                object : UpdateStore {
                    override suspend fun load(): UpdateRecord? = null

                    override suspend fun save(record: UpdateRecord) = Unit
                },
                BuildConfig.VERSION_NAME,
                35,
            )
        try {
            app.updateOwner = owner
            auth.available = emptyList()
            auth.state.value = testAuthenticationState(session = "required-entry", workspace = null)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                find(R.string.auth_no_workspace)
                val brandTop = find(R.string.app_name).visibleBounds.top
                owner.requireUpdate(RequiredUpdate(release.version))
                find(R.string.updates_required)
                val portraitAction = find(R.string.updates_download)
                check(portraitAction.visibleBounds.bottom > device.displayHeight * 0.85f)
                check(kotlin.math.abs(find(R.string.app_name).visibleBounds.top - brandTop) <= 1)
                ScreenshotCapture.capture("required-update.png")

                device.executeShellCommand("wm size 440x700")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 2.0")
                scenario.onActivity {
                    it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                }
                awaitConfiguration(scenario, "compact required update at 200% text") {
                    it.orientation == Configuration.ORIENTATION_LANDSCAPE &&
                        it.screenHeightDp < 480 && it.fontScale == 2f
                }
                val compactAction = find(R.string.updates_download)
                check(compactAction.visibleBounds.bottom > device.displayHeight * 0.85f)
                find(R.string.app_name)
                ScreenshotCapture.capture("compact-required-update.png")
                val compactActionBounds = compactAction.visibleBounds
                val compactHeadingBounds = find(R.string.updates_required).visibleBounds
                val body = find(By.pkg(app.packageName).scrollable(true))
                val newVersion = By.text(app.getString(R.string.updates_version, release.version))
                check(body.scrollUntil(Direction.DOWN, Until.hasObject(newVersion)))
                check(find(R.string.updates_required).visibleBounds == compactHeadingBounds)
                check(find(R.string.updates_download).visibleBounds == compactActionBounds)

                device.executeShellCommand("wm size 220x284")
                awaitConfiguration(scenario, "short required update at 200% text") {
                    it.orientation == Configuration.ORIENTATION_LANDSCAPE &&
                        it.screenWidthDp < 285 && it.screenHeightDp <= 220 && it.fontScale == 2f
                }
                find(R.string.updates_required_short)
                val actionBounds = find(R.string.updates_download).visibleBounds
                val scroll = By.pkg(app.packageName).scrollable(true)
                val headingArea = find(scroll).visibleBounds
                val brandBounds = find(R.string.app_name).visibleBounds
                check(brandBounds.top >= headingArea.top && brandBounds.bottom <= headingArea.bottom)
                val currentVersion =
                    By.pkg(app.packageName).text(
                        app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME),
                    )
                ScreenshotCapture.capture("short-required-update-top.png")
                val versionBounds = dragToVersion(scroll, currentVersion).visibleBounds
                check(versionBounds.height() > 0 && versionBounds.bottom <= actionBounds.top)
                check(find(R.string.updates_download).visibleBounds == actionBounds)
                ScreenshotCapture.capture("short-required-update-version.png")
            }
        } finally {
            app.updateOwner = previous
            owner.close()
            auth.available = workspaces
            auth.state.value = authState
            device.executeShellCommand("wm size $originalSize")
            device.executeShellCommand("wm density $originalDensity")
            if (originalFont == "null") device.executeShellCommand("settings delete system font_scale")
            else device.executeShellCommand("settings put system font_scale $originalFont")
        }
    }

    private fun dragToVersion(scroll: BySelector, version: BySelector): UiObject2 {
        repeat(14) {
            val viewport = find(scroll).visibleBounds
            val versionNode = device.findObject(version)
            val versionBounds = versionNode?.visibleBounds
            if (versionNode != null && versionBounds != null && versionBounds.height() >= 45) {
                return versionNode
            }
            // Use smaller drags once the label enters the viewport so the capture shows its text.
            val x = viewport.centerX()
            val bottom = viewport.bottom - 4
            val top = if (versionBounds == null) viewport.top + 4 else bottom - 29
            val reverse = versionBounds != null && versionBounds.top <= viewport.top
            val from = if (reverse) top else bottom
            val to = if (reverse) bottom else top
            check(top >= viewport.top && top < bottom && device.swipe(x, from, x, to, 26)) {
                "Could not swipe inside $viewport from ($x,$from) to ($x,$to)"
            }
            device.waitForIdle(2_000)
        }
        runCatching { ScreenshotCapture.capture("failure-short-required-update.png") }
        error("The installed version was never readable in the short update window")
    }

    private fun awaitSocialProviderLabels() {
        val providers = Clerk.socialProviders.values.filter { it.enabled && it.authenticatable }
        for (config in providers) {
            val provider = OAuthProvider.fromStrategy(config.strategy)
            val name = provider.providerName
            val label = app.getString(com.clerk.ui.R.string.continue_with, name)
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            device.hasObject(By.desc(label)) ||
                                device.hasObject(By.text(label)) ||
                                device.hasObject(By.text(name))
                    },
                    20_000,
                ) == true,
            ) {
                "The Clerk button for $name never displayed its icon or label"
            }
        }
    }

    @Test
    fun verifyIdentifierAndBrandAcrossIme() {
        val previous = auth.state.value
        val showIme = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val originalSize = overrideValue("wm size")
        val originalDensity = overrideValue("wm density")
        try {
            instrumentation.runOnMainSync { ClerkAuthentication(app).initialize() }
            auth.state.value = AuthenticationState(initialized = true)
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            captureIme("phone")

            device.executeShellCommand("wm size 840x960")
            device.executeShellCommand("wm density 160")
            captureIme("wide")
        } finally {
            auth.state.value = previous
            device.executeShellCommand("wm size $originalSize")
            device.executeShellCommand("wm density $originalDensity")
            if (showIme == "null") {
                device.executeShellCommand("settings delete secure show_ime_with_hard_keyboard")
            } else {
                device.executeShellCommand("settings put secure show_ime_with_hard_keyboard $showIme")
            }
        }
    }

    private fun captureIme(prefix: String) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val email = find(identifier)
            val brandTop = find(R.string.app_name).visibleBounds.top
            ScreenshotCapture.capture("$prefix-before-ime.png")
            email.click()
            awaitIme(scenario, visible = true)
            val value = "design-check@example.invalid"
            val focusedIdentifier = By.copy(identifier).focused(true)
            val fieldWithFocus = checkNotNull(device.wait(Until.findObject(focusedIdentifier), 5_000))
            fieldWithFocus.text = value
            checkNotNull(device.wait(Until.findObject(By.copy(focusedIdentifier).text(value)), 5_000)) {
                "The focused Clerk field did not show the test value in the $prefix viewport"
            }
            check(find(R.string.app_name).visibleBounds.top == brandTop)
            ScreenshotCapture.capture("$prefix-ime-open.png")
            check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(scenario, visible = false)
            val field = find(identifier)
            check(field.isFocused && field.text == value)
            check(find(R.string.app_name).visibleBounds.top == brandTop)
            ScreenshotCapture.capture("$prefix-after-ime.png")
        }
    }

    private fun awaitIme(scenario: ActivityScenario<MainActivity>, visible: Boolean) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var matches = false
                        scenario.onActivity { activity ->
                            matches =
                                ViewCompat.getRootWindowInsets(activity.window.decorView)
                                    ?.isVisible(WindowInsetsCompat.Type.ime()) == visible
                        }
                        return matches
                    }
                },
                10_000,
            ) == true,
        ) { "Unexpected IME visibility" }
    }

    @Test
    fun shortLandscapeDarkWithLargeText() {
        val previous = auth.state.value
        val workspaces = auth.available
        try {
            auth.available = emptyList()
            auth.state.value = testAuthenticationState(session = "compact-entry", workspace = null)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                find(R.string.auth_no_workspace)
                captureCompactDark(scenario)
            }
        } finally {
            auth.available = workspaces
            auth.state.value = previous
        }
    }

    private fun captureCompactDark(scenario: ActivityScenario<MainActivity>) {
        val mode = checkNotNull(app.getSystemService(UiModeManager::class.java))
        val originalNight = mode.nightMode
        val originalSize = overrideValue("wm size")
        val originalDensity = overrideValue("wm density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        var originalOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        var originalNightMask = Configuration.UI_MODE_NIGHT_UNDEFINED
        scenario.onActivity {
            originalOrientation = it.requestedOrientation
            originalNightMask =
                it.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        }
        val automation = instrumentation.uiAutomation
        automation.adoptShellPermissionIdentity("android.permission.MODIFY_DAY_NIGHT_MODE")
        try {
            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            device.executeShellCommand("wm size 440x700")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 2.0")
            scenario.onActivity {
                it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            awaitConfiguration(scenario, "short landscape window, dark mode, and 200% text") {
                it.orientation == Configuration.ORIENTATION_LANDSCAPE &&
                    it.screenHeightDp < 480 &&
                    it.fontScale == 2f &&
                    it.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                        Configuration.UI_MODE_NIGHT_YES
            }
            find(R.string.auth_no_workspace)
            val workspaceBrandName = find(R.string.app_name).visibleBounds
            ScreenshotCapture.capture("compact-dark-top.png")
            val signOut = By.text(app.getString(R.string.auth_sign_out))
            if (!device.hasObject(signOut)) {
                find(By.scrollable(true)).scroll(Direction.DOWN, 0.8f)
            }
            find(signOut)
            find(R.string.auth_check_workspace)
            ScreenshotCapture.capture("compact-dark.png")

            val entryState = auth.state.value
            instrumentation.runOnMainSync { ClerkAuthentication(app).initialize() }
            try {
                auth.state.value = AuthenticationState(initialized = true)
                find(identifier)
                val clerkBrandName = find(R.string.app_name).visibleBounds
                check(
                    kotlin.math.abs(clerkBrandName.left - workspaceBrandName.left) <= 1 &&
                        kotlin.math.abs(clerkBrandName.top - workspaceBrandName.top) <= 1 &&
                        kotlin.math.abs(clerkBrandName.width() - workspaceBrandName.width()) <= 1 &&
                        kotlin.math.abs(clerkBrandName.height() - workspaceBrandName.height()) <= 1,
                ) { "Compact brand name differs: Clerk $clerkBrandName, workspace $workspaceBrandName" }
                ScreenshotCapture.capture("compact-clerk.png")
                val workspaces = listOf(
                    ai.okou.android.auth.WorkspaceMembership("org-a", "Workspace A", "org:member"),
                    ai.okou.android.auth.WorkspaceMembership("org-b", "Workspace B", "org:member"),
                )
                auth.available = workspaces
                auth.state.value = testAuthenticationState(session = "compact-picker", workspace = null)
                find(R.string.auth_choose_workspace)
                find(By.text(workspaces.first().name))
                ScreenshotCapture.capture("compact-dark-picker.png")
            } finally {
                auth.available = emptyList()
                auth.state.value = entryState
            }

            // The dialog uses a font-scaled threshold below the 480dp entry breakpoint.
            device.executeShellCommand("wm size 320x700")
            awaitConfiguration(scenario, "compact confirmation window at 200% text") {
                it.orientation == Configuration.ORIENTATION_LANDSCAPE &&
                    it.screenHeightDp in 1..320 && it.fontScale == 2f
            }
            find(R.string.auth_no_workspace)
            if (!device.hasObject(signOut)) {
                find(By.scrollable(true)).scroll(Direction.DOWN, 0.8f)
            }
            find(signOut).click()
            verifyConfirmationSpacing(8, 12)
            find(signOut)
            ScreenshotCapture.capture("compact-dark-sign-out.png")
            find(R.string.settings_cancel).click()
            val dialogTitle = By.text(app.getString(R.string.settings_sign_out_title))
            check(device.wait(Until.gone(dialogTitle), 5_000) == true)
        } finally {
            try {
                if (originalFont == "null")
                    device.executeShellCommand("settings delete system font_scale")
                else device.executeShellCommand("settings put system font_scale $originalFont")
                device.executeShellCommand("wm size $originalSize")
                device.executeShellCommand("wm density $originalDensity")
                scenario.onActivity { it.requestedOrientation = originalOrientation }
            } finally {
                try {
                    mode.nightMode = originalNight
                } finally {
                    automation.dropShellPermissionIdentity()
                }
            }
        }
        awaitConfiguration(scenario, "original window and text size") {
            it.screenHeightDp >= 480 &&
                it.fontScale < 2f &&
                it.uiMode and Configuration.UI_MODE_NIGHT_MASK == originalNightMask
        }
        find(R.string.auth_no_workspace)
    }

    private fun awaitConfiguration(
        scenario: ActivityScenario<MainActivity>,
        expected: String,
        predicate: (Configuration) -> Boolean,
    ) {
        var observed = ""
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var match = false
                        scenario.onActivity {
                            val configuration = it.resources.configuration
                            observed = configuration.toString()
                            match = predicate(configuration)
                        }
                        return match
                    }
                },
                10_000,
            ) == true,
        ) {
            "Expected $expected, observed $observed"
        }
    }

    private fun overrideValue(command: String): String =
        device
            .executeShellCommand(command)
            .lineSequence()
            .firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ") ?: "reset"

    private fun find(@StringRes text: Int): UiObject2 = find(By.text(app.getString(text)))

    private fun find(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 20_000)) {
            "Never displayed $selector"
        }

    private fun capture(@StringRes title: Int, name: String) {
        find(title)
        ScreenshotCapture.capture(name)
    }

    private fun captureWaiting(@StringRes title: Int, name: String) {
        val heading = find(title).visibleBounds
        val density = app.resources.displayMetrics.density
        val left = heading.right + (12 * density).roundToInt()
        val size = (20 * density).roundToInt()
        val top = heading.centerY() - size / 2
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        val screen = instrumentation.uiAutomation.takeScreenshot() ?: return false
                        try {
                            val frame = screen.copy(Bitmap.Config.ARGB_8888, false) ?: return false
                            try {
                                for (x in left until minOf(left + size, frame.width)) {
                                    for (y in top until minOf(top + size, frame.height)) {
                                        // The reserved area shows the light theme background until the indicator renders.
                                        if (Color.red(frame.getPixel(x, y)) < 160) return true
                                    }
                                }
                                return false
                            } finally {
                                frame.recycle()
                            }
                        } finally {
                            screen.recycle()
                        }
                    }
                },
                5_000,
            ) == true,
        ) {
            runCatching { ScreenshotCapture.capture("failure-$name") }
            "Progress did not appear beside ${app.getString(title)}"
        }
        ScreenshotCapture.capture(name)
    }
}
