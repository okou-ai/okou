package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureWelcomeInBothAppearancesAndAShortWindow() {
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val previousMode = mode.nightMode
        val automation = instrumentation.uiAutomation
        val failures = mutableListOf<Throwable>()
        var activity: ActivityScenario<MainActivity>? = null

        fun tryStep(step: () -> Unit) {
            try {
                step()
            } catch (failure: Throwable) {
                failures += failure
            }
        }

        try {
            automation.adoptShellPermissionIdentity("android.permission.MODIFY_DAY_NIGHT_MODE")
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            auth.state.value = testAuthenticationState(user = "welcome-avatar-${UUID.randomUUID()}")
            val scenario = ActivityScenario.launch(MainActivity::class.java)
            activity = scenario
            device.awaitChatList(app)
            await(label(R.string.composer_new).enabled(true)).click()

            capture(scenario, "portrait-light.png", Configuration.UI_MODE_NIGHT_NO, short = false)

            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            capture(scenario, "portrait-dark.png", Configuration.UI_MODE_NIGHT_YES, short = false)

            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            scenario.onActivity {
                it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            capture(scenario, "short-light.png", Configuration.UI_MODE_NIGHT_NO, short = true)
        } catch (failure: Throwable) {
            failures += failure
            tryStep { ScreenshotCapture.capture("welcome-failure.png") }
            tryStep {
                TestStorage().openOutputFile("welcome-failure.xml").use {
                    device.dumpWindowHierarchy(it)
                }
            }
        } finally {
            tryStep { activity?.close() }
            tryStep { cache.restore() }
            tryStep { app.restoreApiPreferences(preferences) }
            tryStep { auth.state.value = previousAuth }
            tryStep { mode.nightMode = previousMode }
            tryStep { automation.dropShellPermissionIdentity() }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun capture(
        scenario: ActivityScenario<MainActivity>,
        name: String,
        expectedNightMode: Int,
        short: Boolean,
    ) {
        val configurationReady =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    var matches = false
                    scenario.onActivity {
                        val config = it.resources.configuration
                        val height =
                            it.windowManager.currentWindowMetrics.bounds.height() /
                                it.resources.displayMetrics.density
                        val night = config.uiMode and Configuration.UI_MODE_NIGHT_MASK
                        matches = night == expectedNightMode && (height < 480) == short
                    }
                    return matches
                }
            }
        check(device.wait(configurationReady, WAIT) == true) {
            "Configuration did not become ready for $name"
        }
        await(label(R.string.conversation_welcome))
        await(label(R.string.conversation_welcome_detail))
        await(By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true))
        instrumentation.waitForIdleSync()
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }

    private fun label(id: Int) = By.pkg(app.packageName).text(app.getString(id))

    private fun await(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(selector), WAIT)) { "Missing $selector" }

    private companion object {
        const val WAIT = 10_000L
    }
}
