package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.ClerkAuthentication
import ai.okou.android.auth.SessionEntryFailure
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.testAuthenticationState
import android.animation.ValueAnimator
import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.provider.Settings
import android.view.KeyEvent
import androidx.annotation.StringRes
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
import java.util.concurrent.atomic.AtomicInteger
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
                captureWaiting(R.string.auth_preparing_workspace, "preparing.png")
                membershipGate.complete(Unit)

                find(R.string.auth_choose_workspace)
                val row = find(By.text(workspaces.first().name))
                find(By.text(workspaces.last().name))
                ScreenshotCapture.capture("choose-workspace.png")
                auth.refreshAction = { session ->
                    if (session.workspaceId == workspaces.first().id) {
                        throw ApiFailure.Http(503, null, null, null)
                    }
                }
                row.click()
                capture(R.string.auth_selection_failed, "selection-failed.png")
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
                ScreenshotCapture.capture("access-keyboard-pending.png")
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
        if (
            !device.hasObject(By.copy(selector).focused(true)) &&
            !device.hasObject(By.focused(true).hasChild(By.copy(selector)))
        ) {
            check(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
        }
        device.awaitKeyboardFocus(By.copy(selector))
    }

    @Test
    fun verifyRestorationContinuesToNativeClerkForm() {
        val previous = auth.state.value
        val identifier = By.res("clerk.auth.start.identifier")
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
            ScreenshotCapture.capture("compact-dark-top.png")
            val signOut = By.text(app.getString(R.string.auth_sign_out))
            if (!device.hasObject(signOut)) {
                find(By.scrollable(true)).scroll(Direction.DOWN, 0.8f)
            }
            find(signOut)
            find(R.string.auth_check_workspace)
            ScreenshotCapture.capture("compact-dark.png")
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
                                        // The reserved area is white until the indicator renders.
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
