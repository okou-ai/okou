package ai.okou.android.state

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
class SavedUiStateTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun restoredSelectionWaitsForTheJournalBody() {
        val restoration = StateRestorationTester(compose)
        var text by mutableStateOf<String?>("Journal-owned draft")
        restoration.setContent {
            DisposableEffect(Unit) { onDispose { text = null } }
            val editing = rememberJournalEditor(text, "thread")
            OkouTheme(false) {
                OutlinedTextField(
                    value = editing.value,
                    onValueChange = {
                        editing.edit(it)
                        text = it.text
                    },
                    enabled = text != null,
                    modifier = Modifier.testTag("journal_editor"),
                )
            }
        }
        val field = compose.onNodeWithTag("journal_editor")
        field.performTextInputSelection(TextRange(7))
        restoration.emulateSavedInstanceStateRestore()
        field.assertIsNotEnabled()
        compose.runOnIdle { text = "Journal-owned draft" }
        field.assertTextContains("Journal-owned draft")
        assertEquals(
            TextRange(7),
            field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
    }

    @Test
    fun recentConversationScrollRestoresAndOldPresentationIsEvicted() {
        val restoration = StateRestorationTester(compose)
        var next = 0
        lateinit var collapsed: SavedUiIds
        restoration.setContent {
            val histories = rememberConversationUiState()
            collapsed = rememberCollapsedProjects()
            var selected by rememberUiTargetId()
            fun open(id: Int) {
                val target = "00000000-0000-4000-8000-${id.toString().padStart(12, '0')}"
                histories.open(target)
                selected = target
            }
            OkouTheme(false) {
                Column {
                    Text("${collapsed.values.size} collapsed Projects")
                    Button(onClick = { open(++next) }) { Text("Next conversation") }
                    Button(onClick = { open(1) }) { Text("First conversation") }
                    Button(onClick = { open(SavedStatePolicy.CONVERSATION_STATES) }) {
                        Text("Recent conversation")
                    }
                    selected?.let { id ->
                        histories.Content(id) {
                            val position = rememberLazyListState()
                            LazyColumn(
                                state = position,
                                modifier = Modifier.height(300.dp).testTag("retained_history"),
                            ) {
                                items((0..99).toList()) { row ->
                                    Text("History row $row", Modifier.height(40.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
        // Exercise both retention maxima together with canonical-length target IDs.
        compose.runOnIdle {
            for (id in 1..SavedStatePolicy.COLLAPSED_PROJECTS) collapsed.toggle(
                "00000000-0000-4000-8000-${id.toString().padStart(12, '0')}"
            )
        }
        compose.onNodeWithText("Next conversation").performClick()
        compose.onNodeWithTag("retained_history").performScrollToIndex(60)
        for (id in 2..SavedStatePolicy.CONVERSATION_STATES + 1) {
            compose.onNodeWithText("Next conversation").performClick()
            if (id == SavedStatePolicy.CONVERSATION_STATES)
                compose.onNodeWithTag("retained_history").performScrollToIndex(70)
        }
        compose.onNodeWithText("First conversation").performClick()
        compose.onNodeWithText("History row 0").assertIsDisplayed()
        compose.onNodeWithText("Recent conversation").performClick()
        compose.onNodeWithText("History row 70").assertIsDisplayed()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("History row 70").assertIsDisplayed()
        compose
            .onNodeWithText("${SavedStatePolicy.COLLAPSED_PROJECTS} collapsed Projects")
            .assertIsDisplayed()
        compose.runOnIdle {
            val saved = Bundle()
            InstrumentationRegistry.getInstrumentation()
                .callActivityOnSaveInstanceState(compose.activity, saved)
            SavedStatePolicy.verify(saved)
        }
    }

    @Test
    fun projectPresentationStaysBoundedAcrossManyChoicesAndRestoresRecentOnes() {
        val restoration = StateRestorationTester(compose)
        lateinit var collapsed: SavedUiIds
        restoration.setContent {
            collapsed = rememberCollapsedProjects()
            Text(collapsed.values.joinToString())
        }
        compose.runOnIdle {
            for (id in 1..2_000) collapsed.toggle(
                "00000000-0000-4000-8000-${id.toString().padStart(12, '0')}"
            )
        }
        val recent = compose.runOnIdle { collapsed.values }
        assertEquals(SavedStatePolicy.COLLAPSED_PROJECTS, recent.size)
        assertEquals("00000000-0000-4000-8000-000000002000", recent.last())
        restoration.emulateSavedInstanceStateRestore()
        assertEquals(recent, compose.runOnIdle { collapsed.values })
        compose.runOnIdle {
            collapsed.toggle(recent.last())
            assertEquals(recent.dropLast(1), collapsed.values)
            val saved = Bundle()
            InstrumentationRegistry.getInstrumentation()
                .callActivityOnSaveInstanceState(compose.activity, saved)
            SavedStatePolicy.verify(saved)
        }
    }
}
