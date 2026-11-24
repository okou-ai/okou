package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.OkouApplication
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.auth.WorkspaceMembership
import ai.okou.android.awaitChatList
import android.app.UiModeManager
import android.content.res.Configuration
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

/** PR #50380: default workspace logos with initials, in the switcher and the chooser. */
@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as OkouApplication

    @Test
    fun workspaceInitials() {
        val auth = app.authentication as TestAuthentication
        val available = auth.available
        val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val nightMode = mode.nightMode
        instrumentation.uiAutomation.adoptShellPermissionIdentity(
            "android.permission.MODIFY_DAY_NIGHT_MODE",
        )
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            auth.available =
                listOf(
                    WorkspaceMembership("org-a", "Workspace A", "org:member"),
                    WorkspaceMembership("org_one", "Acme Inc", "org:member"),
                    WorkspaceMembership("org_two", "字节跳动", "org:member"),
                    WorkspaceMembership("org-ko", "한국 팀", "org:member"),
                    WorkspaceMembership("org-rocket", "🚀 Launch Team", "org:member"),
                    WorkspaceMembership("org-generated", "workspace-3f9a2c1d", "org:member"),
                )
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            scenario = ActivityScenario.launch(MainActivity::class.java)
            device.awaitChatList(app)
            val switcher = By.descStartsWith(app.getString(R.string.auth_switch_workspace))
            checkNotNull(device.wait(Until.findObject(switcher), WAIT)) { "No workspace switcher" }
            ScreenshotCapture.capture("chat-list-light.png")
            openChooser(switcher)
            ScreenshotCapture.capture("chooser-light.png")
            device.pressBack()
            scenario.close()
            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            scenario = ActivityScenario.launch(MainActivity::class.java)
            scenario.onActivity {
                check(
                    it.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                        Configuration.UI_MODE_NIGHT_YES,
                )
            }
            device.awaitChatList(app)
            openChooser(switcher)
            ScreenshotCapture.capture("chooser-dark.png")
        } finally {
            scenario?.close()
            auth.available = available
            mode.nightMode = nightMode
            instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    private fun openChooser(switcher: androidx.test.uiautomator.BySelector) {
        checkNotNull(device.wait(Until.findObject(switcher), WAIT)).click()
        checkNotNull(device.wait(Until.findObject(By.text("🚀 Launch Team")), WAIT)) {
            "The workspace chooser did not list the fixture workspaces"
        }
        device.waitForIdle()
    }

    private companion object {
        const val WAIT = 10_000L
    }
}
