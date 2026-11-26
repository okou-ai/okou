package ai.okou.android.workflows

import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.canAdoptConfirmedForm
import ai.okou.android.replaceTextPreservingSelection
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.text.TextRange

/** Retains the native input across window changes and connector visits during one edit. */
internal sealed class WorkflowEditSession {
    abstract val draft: WorkflowEdit

    abstract fun receiveConfirmed(detail: WorkflowDetail): Boolean

    data class FieldSelection(val field: TextFieldState, val range: TextRange)

    var fieldSelection: FieldSelection? = null
        private set

    fun rememberSelection(field: TextFieldState, range: TextRange) {
        fieldSelection = FieldSelection(field, range)
    }

    class Instructions(initial: WorkflowEdit.Instructions) : WorkflowEditSession() {
        val title = TextFieldState(initial.value.title)
        val purpose = TextFieldState(initial.value.purpose)
        val instruction = TextFieldState(initial.value.instruction)
        private var original by mutableStateOf(initial.original)

        override val draft by
            derivedStateOf(structuralEqualityPolicy()) {
                WorkflowEdit.Instructions(
                    original = original,
                    value =
                        InstructionsFields(
                            title.text.toString(),
                            purpose.text.toString(),
                            instruction.text.toString(),
                        ),
                )
            }

        override fun receiveConfirmed(detail: WorkflowDetail): Boolean =
            Snapshot.withMutableSnapshot {
                val current = draft
                val keepInput = !canAdoptConfirmedForm(current.changed, title, purpose, instruction)
                val latest =
                    current.updateConfirmed(detail, keepInput) as? WorkflowEdit.Instructions
                        ?: return@withMutableSnapshot false
                original = latest.original
                if (!keepInput) {
                    title.replaceTextPreservingSelection(latest.value.title)
                    purpose.replaceTextPreservingSelection(latest.value.purpose)
                    instruction.replaceTextPreservingSelection(latest.value.instruction)
                }
                true
            }
    }

    class Rule(initial: WorkflowEdit.Rule) : WorkflowEditSession() {
        val subject = TextFieldState(initial.value.subject)
        val calendarId = TextFieldState(initial.value.calendarId)

        private var options by mutableStateOf(initial)

        override val draft by
            derivedStateOf(structuralEqualityPolicy()) {
                options.copy(
                    value =
                        options.value.copy(
                            subject = subject.text.toString(),
                            calendarId = calendarId.text.toString(),
                        ),
                )
            }

        fun editOptions(change: (WorkflowEdit.Rule) -> WorkflowEdit.Rule) {
            options = change(options)
        }

        override fun receiveConfirmed(detail: WorkflowDetail): Boolean =
            Snapshot.withMutableSnapshot {
                val current = draft
                val keepInput = !canAdoptConfirmedForm(current.changed, subject, calendarId)
                val latest =
                    current.updateConfirmed(detail, keepInput) as? WorkflowEdit.Rule
                        ?: return@withMutableSnapshot false
                options = latest
                if (!keepInput) {
                    subject.replaceTextPreservingSelection(latest.value.subject)
                    calendarId.replaceTextPreservingSelection(latest.value.calendarId)
                }
                true
            }
    }
}
