package ai.okou.android.state

import android.os.Bundle
import android.os.Parcel

/** Headroom below the shared Binder limit; not an allowance for document size or other IPC. */
internal object SavedStatePolicy {
    const val ACTIVITY_BYTES = 50_000
    const val CONVERSATION_STATES = 32
    const val COLLAPSED_PROJECTS = 64

    fun verify(state: Bundle) {
        val parcel = Parcel.obtain()
        try {
            parcel.writeBundle(state)
            val bytes = parcel.dataSize()
            if (bytes >= ACTIVITY_BYTES) throw SavedStateBudgetExceeded(bytes)
        } finally {
            parcel.recycle()
        }
    }
}

internal class SavedStateBudgetExceeded(val bytes: Int) :
    IllegalStateException(
        "Activity saved state is $bytes bytes; budget is less than " +
            "${SavedStatePolicy.ACTIVITY_BYTES} bytes. " +
            "Keep documents in their data owner and bound presentation history."
    )
