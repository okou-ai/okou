package ai.okou.android.screenshots

import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.auth.SessionModel
import ai.okou.android.instructions.InstructionsPhase
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesTerminalReadFailureInBothThemes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val authentication = app.authentication as TestAuthentication
        val previousAuth = authentication.state.value
        val previousService = app.instructionsService
        val previousStore = app.instructionsStore
        val previousPrefs = app.initialPreferences
        val apiPrefs = app.snapshotApiPreferences()
        val previousSize = device.executeShellCommand("wm size")
        val previousDensity = device.executeShellCommand("wm density")
        val drafts = Files.createTempDirectory(app.cacheDir.toPath(), "failure-art-").toFile()

        fun restoreDisplay(option: String, old: String) {
            val size = old.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
            device.executeShellCommand("wm $option ${size ?: "reset"}")
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            for ((theme, name) in listOf(
                UserPreferencesTheme.LIGHT to "read-failure-light.png",
                UserPreferencesTheme.DARK to "read-failure-dark.png",
            )) {
                InstructionsApiFixture().use { fixture ->
                    fixture.rejectRead = true
                    app.restoreApiPreferences(emptyMap())
                    app.initialPreferences = testPreferences().copy(theme = theme)
                    app.instructionsService = fixture.service
                    app.instructionsStore = PersonalInstructionsDraftStore(app, drafts)
                    authentication.state.value = testAuthenticationState()
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        scenario.onActivity { assertEquals(412, it.resources.configuration.screenWidthDp) }
                        device.awaitChatList(app)
                        device.openChatListSettings(app)
                        val target = By.pkg(app.packageName).text(app.getString(R.string.instructions_title))
                        if (!device.hasObject(target)) {
                            val scroll = checkNotNull(device.wait(
                                Until.findObject(By.pkg(app.packageName).scrollable(true)), 10_000,
                            ))
                            val visible = object : Condition<UiObject2, Boolean> {
                                override fun apply(value: UiObject2): Boolean = device.hasObject(target)
                            }
                            if (scroll.scrollUntil(Direction.DOWN, visible) != true) {
                                scroll.scrollUntil(Direction.UP, visible)
                            }
                        }
                        checkNotNull(device.wait(Until.findObject(target), 10_000)).click()
                        lateinit var editor: ai.okou.android.instructions.PersonalInstructionsModel
                        scenario.onActivity { activity ->
                            val session = ViewModelProvider(activity)[SessionModel::class.java]
                            editor = checkNotNull(session.uiState.value.ready).instructions
                        }
                        check(device.wait(object : Condition<UiDevice, Boolean> {
                            override fun apply(value: UiDevice): Boolean =
                                editor.uiState.value.phase == InstructionsPhase.Failed
                        }, 15_000) == true) { "Instructions read ended in ${editor.uiState.value.phase}" }
                        check(!editor.uiState.value.canSave)
                        val error = By.pkg(app.packageName).text(app.getString(R.string.instructions_load_failed))
                        val cancel = By.pkg(app.packageName).text(app.getString(R.string.settings_cancel))
                        val button = checkNotNull(device.wait(Until.findObject(cancel), 5_000))
                        check(device.wait(object : Condition<UiDevice, Boolean> {
                            override fun apply(value: UiDevice): Boolean =
                                value.findObjects(error).any {
                                    it.visibleBounds.top >= button.visibleBounds.top - 130 &&
                                        it.visibleBounds.bottom <= button.visibleBounds.top
                                }
                        }, 5_000) == true) { "Instructions failure is not visible above the actions" }
                        assertEquals(3, fixture.requests.count { it.method == "GET" })
                        ScreenshotCapture.capture(name)
                    }
                }
            }
        } catch (failure: Throwable) {
            runCatching { ScreenshotCapture.capture("diagnostic.png") }
            throw failure
        } finally {
            authentication.state.value = previousAuth
            app.instructionsService = previousService
            app.instructionsStore = previousStore
            app.initialPreferences = previousPrefs
            app.restoreApiPreferences(apiPrefs)
            drafts.deleteRecursively()
            restoreDisplay("size", previousSize)
            restoreDisplay("density", previousDensity)
        }
    }
}
