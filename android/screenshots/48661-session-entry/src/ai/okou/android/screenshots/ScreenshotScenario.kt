package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.ClerkAuthentication
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import android.app.UiModeManager
import android.content.res.Configuration
import androidx.annotation.StringRes
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
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val auth = app.authentication as TestAuthentication

    @Test
    fun nativeClerkForm() {
        val previous = auth.state.value
        try {
            instrumentation.runOnMainSync {
                ClerkAuthentication(app).initialize()
                auth.state.value = AuthenticationState(initialized = true)
            }
            ActivityScenario.launch(MainActivity::class.java).use {
                find(By.res("clerk.auth.start.identifier"))
                find(By.res("clerk.auth.start.continue"))
                find(R.string.app_name)
                ScreenshotCapture.capture("sign-in.png")
            }
        } finally {
            auth.state.value = previous
        }
    }

    @Test
    fun workspaceEntryStagesAndCurrentActions() {
        val previous = auth.state.value
        val workspaces = auth.available
        val memberships = auth.membershipsAction
        val refresh = auth.refreshAction
        val signOut = auth.signOutAction
        val membershipGate = CompletableDeferred<Unit>()
        val exitGate = CompletableDeferred<Unit>()
        val animatorScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        try {
            device.executeShellCommand("settings put global animator_duration_scale 1.0")
            auth.state.value = AuthenticationState()
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                capture(R.string.auth_restoring, "restoring.png")

                auth.membershipsAction = {
                    membershipGate.await()
                    auth.available
                }
                auth.state.value = testAuthenticationState(workspace = null)
                capture(R.string.auth_preparing_workspace, "preparing.png")
                find(R.string.auth_sign_out)
                membershipGate.complete(Unit)

                find(R.string.auth_choose_workspace)
                check(find(R.string.auth_check_workspace).isEnabled)
                val row = find(By.text(workspaces.first().name))
                find(By.text(workspaces.last().name))
                ScreenshotCapture.capture("choose-workspace.png")
                row.click()
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
                captureCompactDark(scenario)

                auth.membershipsAction = { error("Fixture membership read failed") }
                find(R.string.auth_check_workspace).click()
                capture(R.string.auth_unavailable, "unavailable.png")
                auth.membershipsAction = memberships
                find(R.string.retry).click()
                find(R.string.auth_no_workspace)

                auth.signOutAction = { exitGate.await() }
                find(R.string.auth_sign_out).click()
                capture(R.string.auth_signing_out, "signing-out.png")
            }
        } finally {
            membershipGate.complete(Unit)
            exitGate.complete(Unit)
            auth.membershipsAction = memberships
            auth.refreshAction = refresh
            auth.signOutAction = signOut
            auth.available = workspaces
            auth.state.value = previous
            if (animatorScale == "null")
                device.executeShellCommand("settings delete global animator_duration_scale")
            else
                device.executeShellCommand(
                    "settings put global animator_duration_scale $animatorScale"
                )
        }
    }

    private fun captureCompactDark(scenario: ActivityScenario<MainActivity>) {
        val mode = checkNotNull(app.getSystemService(UiModeManager::class.java))
        val originalNight = mode.nightMode
        val originalSize = overrideValue("wm size")
        val originalDensity = overrideValue("wm density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        try {
            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            device.executeShellCommand("wm size 700x440")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 2.0")
            awaitConfiguration(scenario) {
                it.screenHeightDp < 480 &&
                    it.fontScale == 2f &&
                    it.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                        Configuration.UI_MODE_NIGHT_YES
            }
            val signOut = By.text(app.getString(R.string.auth_sign_out))
            if (!device.hasObject(signOut)) {
                find(By.scrollable(true)).scroll(Direction.DOWN, 0.8f)
            }
            find(signOut)
            find(R.string.auth_check_workspace)
            ScreenshotCapture.capture("compact-dark.png")
        } finally {
            if (originalFont == "null")
                device.executeShellCommand("settings delete system font_scale")
            else device.executeShellCommand("settings put system font_scale $originalFont")
            device.executeShellCommand("wm size $originalSize")
            device.executeShellCommand("wm density $originalDensity")
            mode.nightMode = originalNight
        }
        awaitConfiguration(scenario) { it.screenHeightDp >= 480 && it.fontScale < 2f }
        find(R.string.auth_no_workspace)
    }

    private fun awaitConfiguration(
        scenario: ActivityScenario<MainActivity>,
        predicate: (Configuration) -> Boolean,
    ) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var match = false
                        scenario.onActivity { match = predicate(it.resources.configuration) }
                        return match
                    }
                },
                10_000,
            ) == true
        ) {
            "Expected Android window configuration did not apply"
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
}
