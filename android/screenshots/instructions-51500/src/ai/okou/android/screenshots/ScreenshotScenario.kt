package ai.okou.android.screenshots

import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
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
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun verificationFailureReleasesTheEditorWithoutLosingTheDraft() {
        val authentication = app.authentication as TestAuthentication
        val auth = authentication.state.value
        val previousService = app.instructionsService
        val previousStore = app.instructionsStore
        val preferences = app.snapshotApiPreferences()
        val directory = Files.createTempDirectory(app.cacheDir.toPath(), "instructions-capture-").toFile()
        val store = PersonalInstructionsDraftStore(app, directory)
        val verificationStarted = CountDownLatch(1)
        val releaseVerification = CountDownLatch(1)
        try {
            InstructionsApiFixture().use { fixture ->
                app.instructionsService = fixture.service
                app.instructionsStore = store
                authentication.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    try {
                        device.awaitChatList(app)
                        device.openChatListSettings(app)
                        reveal(label(R.string.instructions_title)).click()
                        fun editor(text: String) =
                            By.pkg(app.packageName).clazz("android.widget.EditText").text(text)
                        val draft = "Keep decisions and open questions in separate paragraphs."
                        await(editor(fixture.saved.content)).text = draft
                        fun save(enabled: Boolean) = label(R.string.instructions_save).enabled(enabled)
                        fun cancel(enabled: Boolean) = label(R.string.settings_cancel).enabled(enabled)
                        await(save(true))
                        fixture.disconnectSave = true
                        fixture.beforeSave = {
                            fixture.rejectRead = true
                            fixture.beforeRead = {
                                verificationStarted.countDown()
                                check(releaseVerification.await(10, TimeUnit.SECONDS))
                            }
                        }
                        await(save(true)).click()
                        check(verificationStarted.await(10, TimeUnit.SECONDS))
                        await(label(R.string.instructions_checking))
                        val pendingEditor = await(editor(draft)).visibleBounds
                        val pendingSave = await(save(false)).visibleBounds
                        val pendingCancel = await(cancel(false)).visibleBounds
                        ScreenshotCapture.capture("01-checking.png")

                        releaseVerification.countDown()
                        await(label(R.string.instructions_save_rejected))
                        check(await(editor(draft)).visibleBounds == pendingEditor)
                        check(await(save(true)).visibleBounds == pendingSave)
                        check(await(cancel(true)).visibleBounds == pendingCancel)
                        println("Instructions bounds: editor=$pendingEditor save=$pendingSave cancel=$pendingCancel")
                        check(fixture.requests.count { it.method == "PUT" } == 1)
                        check(fixture.requests.count { it.method == "GET" } == 4)
                        ScreenshotCapture.capture("02-editable-after-failure.png")
                        val edited = "Preserve this edit too."
                        await(editor(draft)).text = edited
                        await(editor(edited))
                    } finally {
                        releaseVerification.countDown()
                    }
                }
            }
        } finally {
            app.instructionsService = previousService
            app.instructionsStore = previousStore
            authentication.state.value = auth
            app.restoreApiPreferences(preferences)
            runBlocking { store.close() }
            check(directory.deleteRecursively())
        }
    }

    private fun label(id: Int) = By.pkg(app.packageName).text(app.getString(id))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Expected $selector" }

    private fun reveal(selector: BySelector): UiObject2 {
        if (!device.hasObject(selector)) {
            val scroll = await(By.pkg(app.packageName).scrollable(true))
            val visible = object : Condition<UiObject2, Boolean> {
                override fun apply(unused: UiObject2) = device.hasObject(selector)
            }
            if (scroll.scrollUntil(Direction.DOWN, visible) != true) {
                scroll.scrollUntil(Direction.UP, visible)
            }
        }
        return await(selector)
    }
}
