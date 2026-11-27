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
import android.graphics.Rect
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
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun lostSaveReceiptReturnsToTheSameEditableForm() {
        val authentication = app.authentication as TestAuthentication
        val auth = authentication.state.value
        val previousService = app.instructionsService
        val previousStore = app.instructionsStore
        val preferences = app.snapshotApiPreferences()
        val directory = Files.createTempDirectory(app.cacheDir.toPath(), "instructions-capture-").toFile()
        val store = PersonalInstructionsDraftStore(app, directory)
        val saveStarted = CountDownLatch(1)
        val releaseSave = CountDownLatch(1)
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
                        val save = label(R.string.instructions_save)
                        val cancel = label(R.string.settings_cancel)
                        val discardMessage = label(R.string.instructions_unsaved)
                        val idleSave = await(save.enabled(true)).visibleBounds
                        val idleEditor = await(editor(draft)).visibleBounds
                        val idleCancel = await(cancel).visibleBounds
                        fixture.disconnectSave = true
                        fixture.beforeSave = {
                            saveStarted.countDown()
                            check(releaseSave.await(25, TimeUnit.SECONDS))
                        }
                        await(save).click()
                        check(saveStarted.await(10, TimeUnit.SECONDS))
                        val saving = label(R.string.settings_saving)
                        val pendingEditor = await(editor(draft)).visibleBounds
                        val pendingSave = await(saving).visibleBounds
                        val pendingCancel = await(cancel).visibleBounds
                        check(pendingEditor == idleEditor)
                        check(pendingCancel == idleCancel)
                        check(abs(pendingSave.centerX() - idleSave.centerX()) <= 1)
                        check(pendingSave.centerY() == idleSave.centerY())
                        ScreenshotCapture.capture("01-saving.png")
                        tap(pendingSave)
                        tap(pendingCancel)
                        device.waitForIdle()
                        await(saving)
                        check(!device.hasObject(discardMessage))
                        check(fixture.requests.map { it.method } == listOf("GET", "PUT"))

                        releaseSave.countDown()
                        await(label(R.string.instructions_save_rejected))
                        check(await(editor(draft)).visibleBounds == pendingEditor)
                        check(await(save).visibleBounds == idleSave)
                        check(await(cancel).visibleBounds == pendingCancel)
                        println("Instructions bounds: editor=$idleEditor save=$idleSave cancel=$idleCancel")
                        check(fixture.requests.map { it.method } == listOf("GET", "PUT"))
                        ScreenshotCapture.capture("02-editable-after-failure.png")
                        val edited = "Preserve this edit too."
                        await(editor(draft)).text = edited
                        await(editor(edited))
                        check(device.wait(Until.gone(label(R.string.instructions_save_rejected)), 10_000))
                        check(!device.hasObject(label(R.string.instructions_refresh_failed)))
                        tap(pendingCancel)
                        await(discardMessage)
                        check(device.pressBack())
                        check(device.wait(Until.gone(discardMessage), 10_000))
                        await(editor(edited))
                        fixture.beforeSave = {}
                        fixture.disconnectSave = false
                        tap(idleSave)
                        check(device.wait(Until.gone(editor(edited)), 10_000))
                        check(fixture.saved.content == edited)
                        val methods = fixture.requests.map { it.method }
                        check(methods == listOf("GET", "PUT", "GET", "PUT"))
                        println("Instructions request order: $methods")
                    } finally {
                        releaseSave.countDown()
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

    private fun tap(bounds: Rect) {
        check(device.click(bounds.centerX(), bounds.centerY()))
    }

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
