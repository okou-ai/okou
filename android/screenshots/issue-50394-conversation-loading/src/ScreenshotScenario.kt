package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.RealtimePhase
import ai.okou.android.chat.RealtimeSnapshot
import ai.okou.android.chat.plainDraftDocument
import ai.okou.android.chatListRegion
import ai.okou.android.testAuthenticationState
import android.graphics.Rect
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
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureConversationLoadingAndRecovery() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val oldRealtime = app.realtimeService
        val oldJournal = app.journalStore
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val journalDirectory =
            Files.createTempDirectory(app.cacheDir.toPath(), "loading-draft-").toFile()
        val journal = ComposerJournalStore(app, journalDirectory)
        val realtime =
            TestRealtimeService().apply {
                snapshot.value = RealtimeSnapshot(RealtimePhase.Connecting)
            }
        val oldAnimationScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val historyStatus = AtomicInteger(503)
        val draftRequested = CountDownLatch(1)
        val releaseDraft = CountDownLatch(1)
        val owners = mutableSetOf<Job>()
        ComposerApiFixture(simulateHistory = false).use { fixture ->
            val chat = fixture.chats
            val rows = chat.historyRows
            chat.historyRows = { request ->
                val status = historyStatus.get()
                if (status == 200) rows(request) else MockResponse().setResponseCode(status)
            }
            chat.historyCatchUp = { MockResponse().setResponseCode(503) }
            val savedDraft = "I’ll send the revised notes."
            val draftPath = "/api/chat-threads/$CHAT_PERSONAL/draft"
            fixture.drafts[draftPath] = plainDraftDocument(savedDraft)
            fixture.beforeDraftRead = { path ->
                if (path == draftPath) {
                    draftRequested.countDown()
                    check(releaseDraft.await(20, TimeUnit.SECONDS))
                }
            }
            app.chatService = chat.service
            app.composerService = fixture.service
            app.realtimeService = realtime
            app.journalStore = journal
            auth.state.value = testAuthenticationState(user = "chat-loading-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("settings put global animator_duration_scale 1")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    checkNotNull(device.wait(Until.findObject(By.text("Personal chat")), 15_000))
                        .click()
                    lateinit var model: ChatListModel
                    fun readOwner() = scenario.onActivity { activity ->
                        val ready =
                            checkNotNull(
                                ViewModelProvider(activity)[SessionModel::class.java]
                                    .uiState
                                    .value
                                    .ready,
                            )
                        model = ready.chats
                        ready.chats.viewModelScope.coroutineContext[Job]?.let(owners::add)
                        ready.composer.viewModelScope.coroutineContext[Job]?.let(owners::add)
                    }
                    readOwner()
                    val skeleton = By.desc(app.getString(R.string.history_loading))
                    val progress = By.desc(app.getString(R.string.history_syncing))
                    val retry = By.text(app.getString(R.string.retry))
                    val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
                    val input = By.text("Hello history")
                    val unavailable = By.text(app.getString(R.string.history_missing))
                    awaitState("the first failed history read and a held draft request") {
                        model.history.uiState.value.consecutiveReadFailures > 0 &&
                            draftRequested.count == 0L &&
                            device.hasObject(skeleton) &&
                            device.hasObject(editor)
                    }
                    check(!device.hasObject(retry) && !device.hasObject(progress))
                    ScreenshotCapture.capture("01-first-read-retrying.png")

                    releaseDraft.countDown()
                    historyStatus.set(200)
                    awaitState("recovered history and hydrated draft") {
                        model.history.uiState.value.phase == HistoryPhase.Ready &&
                            device.hasObject(input) &&
                            !device.hasObject(skeleton) &&
                            device.findObject(editor)?.text == savedDraft
                    }
                    val inputBounds = checkNotNull(device.findObject(input)).visibleBounds
                    val editorBounds = checkNotNull(device.findObject(editor)).visibleBounds

                    fun showThirdFailure() {
                        historyStatus.set(503)
                        scenario.onActivity { model.history.invalidate() }
                        awaitState("the third failure with cached history and top progress") {
                            model.history.uiState.value.consecutiveReadFailures >= 3 &&
                                device.hasObject(progress) &&
                                device.hasObject(input)
                        }
                        check(!device.hasObject(retry) && !device.hasObject(skeleton))
                        // Material 3 expands progress accessibility bounds vertically. Check the
                        // painted track in the result image instead of using semantics height.
                        awaitActiveSegment(progress)
                    }
                    realtime.snapshot.value = RealtimeSnapshot(RealtimePhase.Unavailable)
                    showThirdFailure()
                    ScreenshotCapture.capture("02-cached-read-retrying.png")
                    check(checkNotNull(device.findObject(input)).visibleBounds == inputBounds) {
                        "Cached message moved when refresh feedback appeared"
                    }
                    check(checkNotNull(device.findObject(editor)).visibleBounds == editorBounds) {
                        "Composer moved when refresh feedback appeared"
                    }
                    val progressBounds = checkNotNull(device.findObject(progress)).visibleBounds
                    check(progressBounds.width() == device.displayWidth)
                    device.executeShellCommand("settings put global animator_duration_scale 0")
                    try {
                        awaitStaticSegment(progressBounds)
                        check(device.hasObject(progress))
                        ScreenshotCapture.capture("06-reduced-motion-progress.png")
                    } finally {
                        device.executeShellCommand("settings put global animator_duration_scale 1")
                    }

                    fun recoverHistory() {
                        historyStatus.set(200)
                        awaitState("history and editor with progress cleared") {
                            model.history.uiState.value.phase == HistoryPhase.Ready &&
                                device.hasObject(input) &&
                                !device.hasObject(progress) &&
                                device.findObject(editor)?.text == savedDraft
                        }
                    }
                    recoverHistory()
                    check(checkNotNull(device.findObject(input)).visibleBounds == inputBounds)
                    check(checkNotNull(device.findObject(editor)).visibleBounds == editorBounds)
                    ScreenshotCapture.capture("03-history-recovered.png")

                    withWideDisplay {
                        val list = chatListRegion(app)
                        awaitState("the resized two-pane conversation") {
                            app.resources.configuration.densityDpi == 160 &&
                                device.displayWidth >= 1_200 &&
                                device.hasObject(list) &&
                                device.hasObject(input)
                        }
                        readOwner()
                        awaitState("the resized conversation completed its refresh") {
                            model.history.uiState.value.phase == HistoryPhase.Ready
                        }
                        showThirdFailure()
                        val bar = checkNotNull(device.findObject(progress)).visibleBounds
                        val listBounds = checkNotNull(device.findObject(list)).visibleBounds
                        check(bar.width() > 768 && bar.left - listBounds.right in 0..2)
                        ScreenshotCapture.capture("04-wide-conversation-progress.png")
                        recoverHistory()
                    }
                    awaitState("the restored phone configuration") {
                        device.displayWidth < 1_200 && device.hasObject(input)
                    }
                    readOwner()
                    historyStatus.set(403)
                    scenario.onActivity { model.history.invalidate() }
                    awaitState("confirmed access loss") {
                        model.history.uiState.value.phase == HistoryPhase.Missing &&
                            device.hasObject(unavailable) &&
                            !device.hasObject(input) &&
                            !device.hasObject(progress) &&
                            !device.hasObject(retry) &&
                            !device.hasObject(editor)
                    }
                    ScreenshotCapture.capture("05-conversation-unavailable.png")
                }
            } finally {
                releaseDraft.countDown()
                try {
                    runBlocking {
                        withTimeout(10_000) { owners.forEach { it.join() } }
                        journal.close()
                    }
                    cache.restore()
                } finally {
                    app.chatService = oldChats
                    app.composerService = oldComposer
                    app.realtimeService = oldRealtime
                    app.journalStore = oldJournal
                    auth.state.value = oldAuth
                    val scale = oldAnimationScale.toFloatOrNull()
                    if (scale == null)
                        device.executeShellCommand("settings delete global animator_duration_scale")
                    else
                        device.executeShellCommand(
                            "settings put global animator_duration_scale $scale",
                        )
                }
            }
        }
    }

    private fun withWideDisplay(content: () -> Unit) {
        val oldSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val oldDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        try {
            device.executeShellCommand("wm size 1280x1024")
            device.executeShellCommand("wm density 160")
            content()
        } finally {
            try {
                device.executeShellCommand("wm size ${oldSize ?: "reset"}")
            } finally {
                device.executeShellCommand("wm density ${oldDensity ?: "reset"}")
            }
        }
    }

    private fun awaitActiveSegment(progress: BySelector) =
        awaitState("the active progress segment") {
            val bar = device.findObject(progress)?.visibleBounds ?: return@awaitState false
            val image = instrumentation.uiAutomation.takeScreenshot() ?: return@awaitState false
            try {
                val center = image.getPixel(bar.centerX(), bar.centerY())
                val left = image.getPixel(bar.left + bar.width() / 8, bar.centerY())
                val right = image.getPixel(bar.right - bar.width() / 8, bar.centerY())
                center != left || center != right
            } finally {
                image.recycle()
            }
        }

    private fun awaitStaticSegment(bar: Rect) =
        awaitState("the fixed 30% progress segment with animation disabled") {
            val image = instrumentation.uiAutomation.takeScreenshot() ?: return@awaitState false
            try {
                val active = 0xFFB5790C.toInt()
                val track = 0xFFF6EFE2.toInt()
                fun at(percent: Int) =
                    image.getPixel(bar.left + bar.width() * percent / 100, bar.centerY())
                at(2) == active && at(29) == active && at(31) == track && at(98) == track
            } finally {
                image.recycle()
            }
        }

    private fun awaitState(label: String, predicate: () -> Boolean) {
        val condition =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = predicate()
            }
        check(device.wait(condition, 20_000)) { "Did not observe $label" }
    }
}
