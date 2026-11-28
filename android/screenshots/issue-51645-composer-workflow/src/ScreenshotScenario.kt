package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.ComposerWorkflowApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.testAuthenticationState
import android.app.Instrumentation
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inspector.WindowInspector
import androidx.core.view.children
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
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
                runCatching { ScreenshotCapture.capture("workflow-diagnostic.png") }
                "Missing $selector\n$hierarchy"
            }
        ComposerApiFixture().use { fixture ->
            val workflows = ComposerWorkflowApiFixture(fixture)
            val recent = CountDownLatch(1)
            workflows.beforeRecent = { recent.await() }
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
                    fun editor() =
                        By.pkg(app.packageName).clazz("android.widget.EditText").focused(true)
                    check(device.pressKeyCode(KeyEvent.KEYCODE_SLASH))
                    await(editor().text("/"))
                    await(By.textContains("/daily-digest"))
                    recent.countDown()
                    await(By.text("Recently used"))
                    await(By.textContains("/review-changes"))
                    ScreenshotCapture.capture("workflow-recent.png")
                    instrumentation.runOnMainSync {
                        val popup = WindowInspector.getGlobalWindowViews().single {
                            it.javaClass.simpleName == "PopupLayout"
                        }
                        val event = MotionEvent.obtain(0L, 0L, MotionEvent.ACTION_OUTSIDE, 0f, 0f, 0)
                        try {
                            popup.dispatchTouchEvent(event)
                        } finally {
                            event.recycle()
                        }
                    }
                    await(By.text("Recently used"))
                    val connection = focusedInputConnection(instrumentation)
                    instrumentation.runOnMainSync { check(connection.setComposingText("re", 1)) }
                    await(editor().text("/re"))
                    await(By.textContains("/release-check"))
                    instrumentation.runOnMainSync { check(connection.setComposingText("rel", 1)) }
                    await(editor().text("/rel"))
                    check(device.wait(Until.gone(By.text("Recently used")), 5_000) == true)
                    await(By.textContains("/release-check"))
                    ScreenshotCapture.capture("workflow-filtered.png")
                    instrumentation.runOnMainSync { check(connection.finishComposingText()) }
                    await(By.textContains("/release-check"))
                    check(device.findObject(By.text("Recently used")) == null)
                    check(workflows.catalogReads.size == 1)
                    await(By.textContains("/release-check")).click()
                    await(editor().textContains("/release-check"))
                    check(device.wait(Until.gone(By.textContains("/release-notes")), 5_000) == true)
                    check(fixture.inputs.isEmpty())
                    await(By.pkg(app.packageName).desc("Send")).click()
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
                    // The fixture confirms queued delivery; the command is visible in that queue.
                    await(By.pkg(app.packageName).desc("Queue (1)")).click()
                    await(By.pkg(app.packageName).textContains("/release-check"))
                    ScreenshotCapture.capture("workflow-sent.png")
                    check(device.pressBack())
                    check(device.wait(Until.gone(By.textContains("/release-check")), 5_000) == true)
                    await(By.pkg(app.packageName).desc("Chat options")).click()
                    await(By.pkg(app.packageName).text("Workflows")).click()
                    await(By.textContains("/daily-digest"))
                    ScreenshotCapture.capture("workflow-picker.png")
                }
            } finally {
                recent.countDown()
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

private fun focusedInputConnection(instrumentation: Instrumentation): InputConnection {
    fun View.textEditor(): View? =
        if (onCheckIsTextEditor()) this
        else (this as? ViewGroup)?.children?.firstNotNullOfOrNull { it.textEditor() }

    var connection: InputConnection? = null
    instrumentation.runOnMainSync {
        connection =
            WindowInspector.getGlobalWindowViews()
                .asSequence()
                .filter(View::hasWindowFocus)
                .mapNotNull { it.textEditor() }
                .firstNotNullOfOrNull { it.onCreateInputConnection(EditorInfo()) }
    }
    return checkNotNull(connection) { "The focused chat editor has no input connection" }
}
