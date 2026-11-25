package ai.okou.android.workflows

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.text.TextRange

/** Retains the native input across window changes and connector visits during one edit. */
internal sealed class WorkflowEditSession {
    abstract val draft: WorkflowEdit

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

        override val draft by
            derivedStateOf(structuralEqualityPolicy()) {
                initial.copy(
                    value =
                        InstructionsFields(
                            title.text.toString(),
                            purpose.text.toString(),
                            instruction.text.toString(),
                        ),
                )
            }
    }

    class Rule(initial: WorkflowEdit.Rule) : WorkflowEditSession() {
        val time = TextFieldState(initial.value.time)
        val subject = TextFieldState(initial.value.subject)
        val calendarId = TextFieldState(initial.value.calendarId)

        private var options by mutableStateOf(initial)

        override val draft by
            derivedStateOf(structuralEqualityPolicy()) {
                options.copy(
                    value =
                        options.value.copy(
                            time = time.text.toString(),
                            subject = subject.text.toString(),
                            calendarId = calendarId.text.toString(),
                        ),
                )
            }

        fun editOptions(change: (WorkflowEdit.Rule) -> WorkflowEdit.Rule) {
            options = change(options)
        }
    }
}
