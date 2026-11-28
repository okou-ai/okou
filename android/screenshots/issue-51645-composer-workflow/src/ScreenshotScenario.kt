package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.ComposerWorkflowApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.testAuthenticationState
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun existingChatOffersAndSendsAWorkflowCommand() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val preferences = app.snapshotApiPreferences()
        fun displayOverride(setting: String): String =
            Regex("Override \\w+: (\\S+)")
                .find(device.executeShellCommand("wm $setting"))
                ?.groupValues
                ?.get(1) ?: "reset"
        val size = displayOverride("size")
        val density = displayOverride("density")
        fun await(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                val hierarchy = ByteArrayOutputStream()
                device.dumpWindowHierarchy(hierarchy)
                "Missing $selector\n$hierarchy"
            }
        ComposerApiFixture().use { fixture ->
            val workflows = ComposerWorkflowApiFixture(fixture)
            try {
                device.executeShellCommand("wm size 412x915")
                device.executeShellCommand("wm density 160")
                app.chatService = fixture.service
                app.composerService = fixture.service
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    val configured =
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) =
                                device.displayWidth == 412 &&
                                    app.resources.displayMetrics.densityDpi == 160
                        }
                    check(device.wait(configured, 8_000) == true)
                    await(By.pkg(app.packageName).text("Personal chat")).click()
                    val field = By.pkg(app.packageName).desc("Message")
                    await(field).click()
                    check(device.pressKeyCode(KeyEvent.KEYCODE_SLASH))
                    await(By.text("Recently used"))
                    await(By.textContains("/review-changes"))
                    ScreenshotCapture.capture("workflow-recent.png")
                    // Accessibility set-text commits the query without a Latin IME composition.
                    await(field).text = "/rel"
                    await(By.pkg(app.packageName).desc("Message").text("/rel"))
                    await(By.textContains("/release-check"))
                    check(device.wait(Until.gone(By.text("Recently used")), 5_000) == true)
                    ScreenshotCapture.capture("workflow-filtered.png")
                    await(By.textContains("/release-check")).click()
                    check(device.wait(Until.gone(By.textContains("/release-notes")), 5_000) == true)
                    check(fixture.inputs.isEmpty())
                    await(By.pkg(app.packageName).desc("Send")).click()
                    await(By.pkg(app.packageName).textContains("/release-check"))
                    check(
                        device.wait(
                            object : Condition<UiDevice, Boolean> {
                                override fun apply(device: UiDevice) =
                                    fixture.inputs.values
                                        .singleOrNull()
                                        ?.get("prompt")
                                        ?.jsonPrimitive
                                        ?.content
                                        ?.trim() == "/release-check" &&
                                        workflows.recentWrites.isNotEmpty()
                            },
                            12_000,
                        ) == true,
                    )
                    ScreenshotCapture.capture("workflow-sent.png")
                    await(By.pkg(app.packageName).desc("Chat options")).click()
                    await(By.pkg(app.packageName).text("Workflows")).click()
                    await(By.textContains("/daily-digest"))
                    ScreenshotCapture.capture("workflow-picker.png")
                }
            } finally {
                device.executeShellCommand("wm size $size")
                device.executeShellCommand("wm density $density")
                auth.state.value = previousAuth
                app.chatService = previousChats
                app.composerService = previousComposer
                app.restoreApiPreferences(preferences)
                cache.restore()
            }
        }
    }
}
