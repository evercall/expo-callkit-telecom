package expo.modules.callkittelecom.services

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Starts the app's SIP coordinator without requiring an Activity or visible React tree. */
class ExpoCallKitTelecomHeadlessService : HeadlessJsTaskService() {
    companion object {
        const val TASK_NAME = "ExpoCallKitTelecomHeadlessTask"
        private const val CALL_TASK_NAME = "ExpoCallKitTelecomCallTask"
        private const val EXTRA_EVENT = "event"
        private const val EXTRA_CALL_ID = "callId"
        private const val TAG = "ExpoCallKitTelecom.Headless"
        private const val MAX_CALL_TASK_MS = 43_200_000L

        fun dispatch(context: Context, event: String, callId: String? = null) {
            try {
                acquireWakeLockNow(context)
                context.startService(
                    Intent(context, ExpoCallKitTelecomHeadlessService::class.java).apply {
                        putExtra(EXTRA_EVENT, event)
                        if (callId != null) putExtra(EXTRA_CALL_ID, callId)
                    },
                )
            } catch (error: Throwable) {
                Log.e(TAG, "Unable to start SIP headless task", error)
            }
        }
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val event = intent?.getStringExtra(EXTRA_EVENT) ?: return null
        val data = Arguments.createMap().apply {
            putString("event", event)
            intent.getStringExtra(EXTRA_CALL_ID)?.let { putString("callId", it) }
        }
        // The call-lifetime task is registered by the library and does not invoke
        // the application's SIP restoration callback.
        val taskName = if (event == "callActive") CALL_TASK_NAME else TASK_NAME
        return HeadlessJsTaskConfig(taskName, data, MAX_CALL_TASK_MS, true)
    }
}
