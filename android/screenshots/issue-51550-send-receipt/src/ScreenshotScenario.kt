package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.TextDisposition
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.view.accessibility.AccessibilityNodeInfo
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun captureNewChat() =
        capture(newChat = true, "01-new-sending.png", "02-new-queued-before-history.png")

    @Test
    fun captureExistingChat() =
        capture(newChat = false, "03-existing-sending.png", "04-existing-queued-before-history.png")

    private fun capture(newChat: Boolean, sendingImage: String, queuedImage: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousControls = app.controlService
        val previousJournal = app.journalStore
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory = Files.createTempDirectory(app.cacheDir.toPath(), "capture-receipt-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val fixture = ComposerApiFixture()
        val releaseSend = CountDownLatch(1)
        val statusRequested = CountDownLatch(1)
        val releaseStatus = CountDownLatch(1)
        val historyRequested = CountDownLatch(1)
        val releaseHistory = CountDownLatch(1)
        fixture.beforeSendReturn = { check(releaseSend.await(45, TimeUnit.SECONDS)) }
        fixture.beforeInputStatusReturn = {
            statusRequested.countDown()
            check(releaseStatus.await(45, TimeUnit.SECONDS))
        }
        fixture.beforeHistoryReturn = { threadId ->
            val submitted = fixture.inputs.values.any { it["threadId"]?.jsonPrimitive?.content == threadId }
            if (submitted) {
                historyRequested.countDown()
                check(releaseHistory.await(45, TimeUnit.SECONDS))
            }
        }
        fixture.chats.historyCatchUp = {
            jsonResponse("""{"events":{},"notFoundThreads":[]}""")
        }
        fun restoreValue(setting: String) =
            Regex("Override \\w+: (\\S+)").find(device.executeShellCommand("wm $setting"))
                ?.groupValues?.get(1) ?: "reset"
        val size = restoreValue("size")
        val density = restoreValue("density")
        val jobs = mutableListOf<Job>()
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        fun await(selector: BySelector) = checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
            "Missing native node $selector"
        }
        fun await(description: String, predicate: () -> Boolean) {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = predicate()
            }, 12_000)) { "Timed out waiting for $description" }
        }
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun desc(label: String) = By.pkg(app.packageName).desc(label)
        val sending = app.getString(R.string.composer_sending)
        fun showsSending(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            return node.stateDescription?.toString() == sending ||
                (0 until node.childCount).any { showsSending(node.getChild(it)) }
        }
        try {
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("wm density 160")
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.controlService = fixture.service
            app.journalStore = journal
            auth.state.value = testAuthenticationState()
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity
            await(text(if (newChat) app.getString(R.string.composer_new) else "Personal chat")).click()
            val editor = By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
            val prompt = "Please summarize the launch plan."
            val field = await(editor)
            lateinit var workspace: SessionModel
            activity.onActivity { workspace = ViewModelProvider(it)[SessionModel::class.java] }
            await("workspace") { workspace.uiState.value.ready != null }
            val ready = checkNotNull(workspace.uiState.value.ready)
            jobs += checkNotNull(ready.composer.viewModelScope.coroutineContext[Job])
            jobs += checkNotNull(ready.chats.viewModelScope.coroutineContext[Job])
            if (!newChat) await("the existing history") {
                ready.chats.history.uiState.value.phase == HistoryPhase.Ready
            }
            field.text = prompt
            await(desc(app.getString(R.string.composer_send)).enabled(true)).click()
            await("the send request") { fixture.inputs.size == 1 }
            val (_, input) = fixture.inputs.entries.single()
            val thread = ComposerTarget(input.getValue("threadId").jsonPrimitive.content)
            await(text(prompt))
            await("the sending state") { showsSending(instrumentation.uiAutomation.rootInActiveWindow) }
            ScreenshotCapture.capture(sendingImage)

            releaseSend.countDown()
            await("the acceptance receipt") {
                ready.composer.uiState.value.entry(thread).receipt?.disposition == TextDisposition.Accepted
            }
            val beforeStatus = await(text(prompt)).visibleBounds
            if (!newChat) {
                activity.moveToState(Lifecycle.State.STARTED)
                activity.moveToState(Lifecycle.State.RESUMED)
            }
            await("the separate queued status and history reads") {
                statusRequested.count == 0L && historyRequested.count == 0L
            }
            releaseStatus.countDown()
            await(desc(app.getString(R.string.conversation_queue_count, 1)))
            val afterStatus = await(text(prompt)).visibleBounds
            check(beforeStatus.left == afterStatus.left && beforeStatus.right == afterStatus.right)
            check(device.findObjects(text(prompt)).size == 1)
            check(!showsSending(instrumentation.uiAutomation.rootInActiveWindow))
            ScreenshotCapture.capture(queuedImage)
        } catch (error: Throwable) {
            failures += error
            runCatching { ScreenshotCapture.capture("diagnostic-" + sendingImage) }
        } finally {
            releaseSend.countDown()
            releaseStatus.countDown()
            releaseHistory.countDown()
            for (cleanup in listOf<() -> Unit>(
                { scenario?.close() },
                { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
                { runBlocking { journal.close() } },
                { fixture.close() },
                { cache.restore() },
                { app.restoreApiPreferences(preferences) },
                {
                    app.chatService = previousChats
                    app.composerService = previousComposer
                    app.controlService = previousControls
                    app.journalStore = previousJournal
                    auth.state.value = previousAuth
                },
                { device.executeShellCommand("wm size $size") },
                { device.executeShellCommand("wm density $density") },
                { check(directory.deleteRecursively()) },
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
