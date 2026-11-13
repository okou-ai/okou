package ai.okou.android.chat

/** A catch-up may confirm an unchanged dataset without requiring another disk transaction. */
data class MetadataSyncResult<T>(val checkpoint: T, val changed: Boolean)
