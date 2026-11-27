package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.OkouTheme
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItemFramework
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItemType
import ai.okou.android.historyEventWire
import android.content.res.Configuration
import android.os.LocaleList
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationTurnFeedbackTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun historicalFailureShowsReasonAndGuidanceWithoutRecoveryNetworkReads() {
        fun history(wire: String): HistoryMessage {
            val row = HistoryEvent.decode(wire)
            return projectHistory(
                    HistoryCheckpoint(CHAT_PERSONAL, listOf(row), HistoryCursor(row.id, row.seqId)),
                )
                .messages
                .single()
        }
        fun failure(reason: String) = history(RecoveryApiFixture.failure(reason))
        val legacy =
            history(
                historyEventWire(
                    "legacy",
                    1,
                    type = "output.error",
                    payload = """{"error":"Legacy error"}""",
                ),
            )
        val displayed = mutableStateOf(listOf(legacy))
        fun show(vararg messages: HistoryMessage) {
            compose.runOnIdle { displayed.value = messages.toList() }
        }
        compose.setContent {
            OkouTheme {
                Column {
                    for (entry in conversationTurns(displayed.value, emptySet()).messages) {
                        key(entry.key) { ConversationMessageRow(entry) }
                    }
                }
            }
        }
        val header = compose.onNodeWithTag("conversation_reply_header")
        val avatar = compose.onNodeWithTag("conversation_reply_avatar")
        val card = compose.onNodeWithTag("conversation_failure_card")
        val legacyTop = card.getUnclippedBoundsInRoot().top
        compose.onNodeWithText("Legacy error").assertExists()

        show(legacy, failure("provider_request_timeout"))
        compose.onNodeWithText("Legacy error").assertDoesNotExist()
        assertEquals(legacyTop, card.getUnclippedBoundsInRoot().top)
        val headerBounds = header.getUnclippedBoundsInRoot()
        val avatarBounds = avatar.getUnclippedBoundsInRoot()
        assertEquals(48.dp, headerBounds.bottom - headerBounds.top)
        assertEquals(32.dp, avatarBounds.right - avatarBounds.left)
        assertEquals(
            8.dp,
            card.getUnclippedBoundsInRoot().top - header.getUnclippedBoundsInRoot().bottom,
        )
        compose.onNodeWithText("The model response timed out").assertExists()
        compose
            .onNodeWithText("Try again in a moment, or choose another model to keep working.")
            .assertExists()

        show(failure("future_reason"))
        compose.onNodeWithText("This run couldn't finish").assertExists()
        compose.onNodeWithText("Open the chat on the Okou website for details.").assertExists()

        show(failure("provider_image_too_large"))
        compose.onNodeWithText("Image is too large").assertExists()
        compose.onNodeWithText("Remove the image or replace it with a smaller one.").assertExists()

        show(failure("guest_memory_oom_killed"))
        compose.onNodeWithText("This run ran out of memory").assertExists()
        compose.onNodeWithText("The content generated so far is still available.").assertExists()

        show(failure("safety_policy_refusal"))
        compose.onNodeWithText("Revise your request before sending it again.").assertExists()

        val legacySafety =
            history(
                historyEventWire(
                    "legacy-safety",
                    1,
                    type = "output.error",
                    payload =
                        """{"content":"Legacy diagnostic","error":"Bad request: {\"error\":{\"code\":\"content_policy_violation\"}}"}""",
                ),
            )
        show(legacySafety)
        compose.onNodeWithText("Revise your request before sending it again.").assertExists()
        compose.onNodeWithText("Legacy diagnostic").assertDoesNotExist()
        compose.onNodeWithText("Bad request", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Continue").assertDoesNotExist()

        show(failure("firewall_auth_failed"))
        compose.onNodeWithText("This run couldn't finish").assertExists()

        show(history(historyEventWire(type = "run.cancelled", payload = "null")))
        header.assertExists()
        compose.onNodeWithText("Stopped").assertExists()
        card.assertDoesNotExist()
        val stopped = compose.onNodeWithTag("conversation_stopped").getUnclippedBoundsInRoot()
        assertEquals(8.dp, stopped.top - header.getUnclippedBoundsInRoot().bottom)
        assertEquals(24.dp, stopped.bottom - stopped.top)
    }

    @Test
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun recoveryDetailsStackWhenTheTextSizeOutgrowsTheAvailableWidth() {
        val account = "fixture@example.test"
        val data =
            FailureRecoveryData(
                RecoverySelection(CHAT_PERSONAL, "failed", "gpt-recovery", false),
                AssistantFailure.Run("failed", "usage_limit"),
                FailureClassification(FailureKind.Usage, RecoveryFramework.Codex),
                account =
                    RecoverySubscriptionsSubscriptionsItem(
                        id = "account",
                        type = RecoverySubscriptionsSubscriptionsItemType.CODEX_OAUTH_TOKEN,
                        framework = RecoverySubscriptionsSubscriptionsItemFramework.CODEX,
                        createdAt = CHAT_DATE,
                        updatedAt = CHAT_DATE,
                        accountEmail = account,
                        subscriptionResetCredits = 2,
                        needsReconnect = false,
                        lastRefreshErrorCode = null,
                    ),
            )
        val fontScale = mutableStateOf(1f)
        compose.setContent {
            val density = Density(LocalDensity.current.density, fontScale.value)
            CompositionLocalProvider(LocalDensity provides density) {
                OkouTheme {
                    Box(Modifier.width(320.dp)) {
                        RecoveryInformation(data)
                    }
                }
            }
        }
        val label = compose.onNodeWithText("Model account")
        val value = compose.onNodeWithText(account)
        val regularLabel = label.getUnclippedBoundsInRoot()
        val regularValue = value.getUnclippedBoundsInRoot()
        assertEquals(8.dp, regularValue.left - regularLabel.right)
        assertEquals(regularLabel.top, regularValue.top)
        compose.onNodeWithText("Resets available").assertExists()

        compose.runOnIdle { fontScale.value = 2f }
        val stackedLabel = label.getUnclippedBoundsInRoot()
        val stackedValue = value.getUnclippedBoundsInRoot()
        assertEquals(4.dp, stackedValue.top - stackedLabel.bottom)
        assertEquals(stackedLabel.left, stackedValue.left)
    }

    @Test
    fun completedSummaryUsesTheAppLanguageAndKeepsMinuteAndSecondUnits() {
        val activity = compose.activity
        val configuration =
            Configuration(activity.resources.configuration).apply {
                setLocales(LocaleList.forLanguageTags("zh-Hans"))
            }
        val resources = activity.createConfigurationContext(configuration).resources
        compose.setContent {
            CompositionLocalProvider(
                LocalConfiguration provides configuration,
                LocalResources provides resources,
            ) {
                OkouTheme {
                    ConversationReplySummary(
                        ReplySummary(ReplyPhase.Completed, 0, 83_500),
                        2,
                        false,
                    ) {}
                }
            }
        }

        compose.onNodeWithText("共工作 1 分钟 24 秒 · 2 个步骤").assertExists()
    }

    @Test
    fun textActionsExtendIntoTheGutterAndActivateOnRelease() {
        val prompt = "Review the checklist"
        val completion =
            ConversationCompletion(
                "completed",
                null,
                null,
                listOf(ConversationFollowup(prompt, ConversationFollowupKind.Talk)),
            )
        var toggles = 0
        var selected: String? = null
        compose.setContent {
            OkouTheme {
                LazyColumn(Modifier.width(240.dp).padding(horizontal = 24.dp)) {
                    item {
                        ConversationReplySummary(
                            ReplySummary(ReplyPhase.Completed, null, null),
                            2,
                            false,
                        ) {
                            toggles++
                        }
                    }
                    item {
                        ConversationCompletionRow(completion) { selected = it }
                    }
                }
            }
        }

        val summary = compose.onNodeWithTag("conversation_reply_summary")
        val followup = compose.onNodeWithTag("conversation_followup")
        val summaryBounds = summary.getUnclippedBoundsInRoot()
        val followupBounds = followup.getUnclippedBoundsInRoot()
        assertEquals(16.dp, summaryBounds.left)
        assertEquals(16.dp, followupBounds.left)
        assertEquals(216.dp, followupBounds.right)
        assertTrue(summaryBounds.right < followupBounds.right)

        for (action in listOf(summary, followup)) {
            action.assertHeightIsEqualTo(48.dp)
            action.performTouchInput { down(Offset(2f, centerY)) }
            compose.runOnIdle {
                assertEquals(0, toggles)
                assertNull(selected)
            }
            action.performTouchInput { cancel() }
        }
        compose.runOnIdle {
            assertEquals(0, toggles)
            assertNull(selected)
        }
        for (action in listOf(summary, followup)) {
            action.performTouchInput {
                down(Offset(2f, centerY))
                up()
            }
        }
        compose.runOnIdle {
            assertEquals(1, toggles)
            assertEquals(prompt, selected)
        }
    }

    @Test
    fun anEllipsizedSuggestionStillProvidesItsFullTextAndAction() {
        val prompt =
            "Summarize the release notes, include the deployment dates and flag follow-up tasks."
        val followups = listOf(ConversationFollowup(prompt, ConversationFollowupKind.Talk))
        val completion = ConversationCompletion("completed", null, null, followups)
        var selected: String? = null
        compose.setContent {
            OkouTheme {
                ConversationCompletionRow(completion, Modifier.width(160.dp)) { selected = it }
            }
        }

        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(prompt, useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(layouts)
        }
        val layout = layouts.single()
        assertEquals(2, layout.lineCount)
        assertTrue(layout.isLineEllipsized(1))
        compose.onNode(hasText(prompt) and hasClickAction()).performClick()
        compose.runOnIdle { assertEquals(prompt, selected) }
    }

    @Test
    fun activeSummaryUsesOneLineAndExposesItsFullLabelAtLargeFontScale() {
        val summary = "Checking the release schedule, checklist, dependencies, and rollout notes"
        compose.setContent {
            val density = Density(LocalDensity.current.density, fontScale = 2f)
            CompositionLocalProvider(LocalDensity provides density) {
                OkouTheme { ConversationActivity(summary, Modifier.width(240.dp)) }
            }
        }

        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(summary).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(layouts)
        }
        val layout = layouts.single()
        assertEquals(1, layout.lineCount)
        assertTrue(layout.isLineEllipsized(0))
        assertEquals(13.sp, layout.layoutInput.style.fontSize)
        assertEquals(20.sp, layout.layoutInput.style.lineHeight)
    }

    @Test
    fun snackbarCollisionBoundsFollowTheSurfaceInsideItsMargins() {
        val message = "Could not stop the task"
        var outerBounds: Rect? = null
        var surfaceBounds: Rect? = null
        compose.setContent {
            val host = remember { SnackbarHostState() }
            LaunchedEffect(host) {
                host.showSnackbar(message, duration = SnackbarDuration.Indefinite)
            }
            OkouTheme {
                WorkspaceFeedbackHost(
                    host,
                    Modifier.width(240.dp)
                        .onGloballyPositioned { outerBounds = it.boundsInRoot() }
                        .padding(bottom = 4.dp),
                    surfaceModifier =
                        Modifier.onGloballyPositioned { surfaceBounds = it.boundsInRoot() },
                )
            }
        }

        compose.onNodeWithText(message).assertExists()
        compose.runOnIdle {
            val outer = checkNotNull(outerBounds)
            val surface = checkNotNull(surfaceBounds)
            val sideGap = with(compose.density) { 12.dp.roundToPx().toFloat() }
            val bottomGap = with(compose.density) { 4.dp.roundToPx().toFloat() }
            assertEquals(
                Rect(
                    outer.left + sideGap,
                    outer.top,
                    outer.right - sideGap,
                    outer.bottom - bottomGap,
                ),
                surface,
            )
        }
    }
}
