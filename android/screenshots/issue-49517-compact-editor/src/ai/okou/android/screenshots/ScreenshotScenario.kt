package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import java.nio.file.Files
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun existingChatKeepsItsDraftAndTranscriptWhenTheWindowShortens() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val size = device.executeShellCommand("wm size")
        val density = device.executeShellCommand("wm density")
        check(size.contains("Physical size:") && density.contains("Physical density:"))
        val initialSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1)
        val initialDensity = Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val oldJournal = app.journalStore
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory = Files.createTempDirectory(app.cacheDir.toPath(), "short-composer-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val fixture = ChatListApiFixture()
        app.chatService = fixture.service
        app.composerService = fixture.service
        app.journalStore = journal
        var scenario: ActivityScenario<MainActivity>? = null
        val jobs = mutableSetOf<Job>()
        val failures = mutableListOf<Throwable>()
        try {
            fun await(description: String, condition: () -> Boolean) {
                assertTrue(
                    description,
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) = condition()
                        },
                        10_000,
                    ),
                )
            }

            fun view(selector: BySelector) =
                checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
                    selector.toString()
                }

            fun text(value: String) = By.pkg(app.packageName).text(value)

            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 400x520")
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity

            fun awaitWindow(height: Int) {
                await("The activity should receive the 400 × $height display at mdpi") {
                    var ready = false
                    activity.onActivity {
                        val bounds = it.windowManager.currentWindowMetrics.bounds
                        ready =
                            bounds.width() == 400 &&
                                bounds.height() == height &&
                                it.resources.configuration.densityDpi == 160
                    }
                    ready
                }
            }

            fun captureOwners() {
                activity.onActivity {
                    val ready =
                        checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        )
                    ready.chats.viewModelScope.coroutineContext[Job]?.let(jobs::add)
                    ready.composer.viewModelScope.coroutineContext[Job]?.let(jobs::add)
                }
            }

            awaitWindow(520)
            view(text("Personal chat")).click()
            val field = By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
            val send =
                By.pkg(app.packageName)
                    .desc(app.getString(R.string.composer_send))
                    .clickable(true)
                    .enabled(true)
            val message = By.pkg(app.packageName).textContains("Hello history")
            val saving = text(app.getString(R.string.composer_saving))
            val syncing = text(app.getString(R.string.composer_sync_saving))
            val draft = "Draft summary\nKeep the current chat\nShare these screenshots"
            view(message)
            captureOwners()
            view(field).text = draft
            await("The normal editor should display multiple lines and enable Send") {
                val node = device.findObject(field)
                node?.text == draft &&
                    node.visibleBounds.height() > 48 &&
                    device.hasObject(send) &&
                    !device.hasObject(saving) &&
                    !device.hasObject(syncing)
            }
            val normalBounds = view(field).visibleBounds
            val normalSendBounds = view(send).visibleBounds
            assertEquals(48, normalSendBounds.height())
            ScreenshotCapture.capture("composer-standard.png")

            device.executeShellCommand("wm size 400x479")
            awaitWindow(479)
            await("The short editor should retain the draft, a single line and enabled Send") {
                val node = device.findObject(field)
                node?.text == draft &&
                    node.visibleBounds.height() in 1..48 &&
                    device.findObject(send)?.visibleBounds?.height() == 48 &&
                    !device.hasObject(saving) &&
                    !device.hasObject(syncing)
            }
            if (!device.hasObject(message)) {
                UiScrollable(UiSelector().packageName(app.packageName).scrollable(true))
                    .setAsVerticalList()
                    .scrollIntoView(
                        UiSelector().packageName(app.packageName).textContains("Hello history")
                    )
            }
            view(message)
            captureOwners()
            ScreenshotCapture.capture("composer-short.png")

            device.executeShellCommand("wm size 400x480")
            awaitWindow(480)
            await("The editor should be multiline again at 480dp") {
                val node = device.findObject(field)
                node?.text == draft &&
                    node.visibleBounds.height() == normalBounds.height() &&
                    device.hasObject(send)
            }
            captureOwners()

            device.executeShellCommand("wm size 400x520")
            awaitWindow(520)
            captureOwners()

            fun keyboardTop(): Int? {
                var top: Int? = null
                activity.onActivity {
                    val insets = ViewCompat.getRootWindowInsets(it.window.decorView)
                    if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                        top =
                            it.windowManager.currentWindowMetrics.bounds.bottom -
                                insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                    }
                }
                return top
            }

            view(field).click()
            var observedKeyboardLayout = "The IME has not reported an inset"
            try {
                await("The IME should leave the normal viewport and Send reachable") {
                    val top = keyboardTop() ?: return@await false
                    val editor = device.findObject(field)?.visibleBounds
                    val action = device.findObject(send)?.visibleBounds
                    observedKeyboardLayout =
                        "IME top=$top, editor=$editor, send=$action, normal editor=$normalBounds, normal send=$normalSendBounds"
                    editor != null &&
                        action != null &&
                        top in 1..479 &&
                        editor.height() in 1..normalBounds.height() &&
                        action.centerX() == normalSendBounds.centerX() &&
                        action.height() == normalSendBounds.height() &&
                        action.bottom <= top
                }
            } catch (failure: AssertionError) {
                throw AssertionError(observedKeyboardLayout, failure)
            }
            awaitWindow(520)
            ScreenshotCapture.capture("composer-keyboard.png")
            assertTrue(device.pressBack())
            await("Closing the IME should restore the draft and its normal viewport") {
                val node = device.findObject(field)
                keyboardTop() == null &&
                    node?.text == draft &&
                    node.visibleBounds.height() == normalBounds.height()
            }
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("short-composer-failure")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
                    { runBlocking { journal.close() } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    {
                        app.chatService = oldChats
                        app.composerService = oldComposer
                        app.journalStore = oldJournal
                    },
                    { check(directory.deleteRecursively()) },
                    { device.executeShellCommand("wm size ${initialSize ?: "reset"}") },
                    { device.executeShellCommand("wm density ${initialDensity ?: "reset"}") },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
