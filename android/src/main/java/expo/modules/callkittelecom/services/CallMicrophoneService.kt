package expo.modules.callkittelecom.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ResultReceiver
import android.util.Log
import expo.modules.callkittelecom.models.CallSessionStatus
import expo.modules.callkittelecom.store.CallStore
import java.util.UUID

/** Keeps WebRTC microphone capture eligible while the native call UI is visible. */
class CallMicrophoneService : Service() {
    companion object {
        private const val TAG = "Evercall.Microphone"
        private const val CHANNEL_ID = "evercall_active_call"
        private const val NOTIFICATION_ID = 7301
        private const val EXTRA_CALL_ID = "callId"
        private const val EXTRA_RESULT = "result"
        private const val RESULT_READY = 1
        private const val RESULT_FAILED = 0

        fun start(context: Context, callId: UUID, onReady: (Boolean) -> Unit) {
            val receiver = object : ResultReceiver(Handler(Looper.getMainLooper())) {
                override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
                    onReady(resultCode == RESULT_READY)
                }
            }
            val intent = Intent(context, CallMicrophoneService::class.java).apply {
                putExtra(EXTRA_CALL_ID, callId.toString())
                putExtra(EXTRA_RESULT, receiver)
            }

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (error: RuntimeException) {
                Log.e(TAG, "Microphone service launch rejected", error)
                receiver.send(RESULT_FAILED, null)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallMicrophoneService::class.java))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        @Suppress("DEPRECATION")
        val receiver = intent?.getParcelableExtra<ResultReceiver>(EXTRA_RESULT)
        val callId = intent?.getStringExtra(EXTRA_CALL_ID)?.let(UUID::fromString)
        val status = callId?.let { CallStore.session(it)?.status }

        // The caller may have cancelled while Android was starting this service.
        if (status != CallSessionStatus.CONNECTING && status != CallSessionStatus.REQUESTING) {
            receiver?.send(RESULT_FAILED, null)
            if (CallStore.allSessions().isEmpty()) stopSelf(startId)
            return START_NOT_STICKY
        }

        try {
            val notification = createNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (error: RuntimeException) {
            Log.e(TAG, "Microphone foreground promotion failed", error)
            receiver?.send(RESULT_FAILED, null)
            if (CallStore.allSessions().isEmpty()) stopSelf(startId)
            return START_NOT_STICKY
        }

        Log.i(TAG, "Microphone foreground service started for $callId")
        receiver?.send(RESULT_READY, null)
        return START_NOT_STICKY
    }

    private fun createNotification(): Notification {
        val builder =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = getSystemService(NotificationManager::class.java)
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        "Active calls",
                        NotificationManager.IMPORTANCE_LOW,
                    ),
                )
                Notification.Builder(this, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }

        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Evercall call")
            .setContentText("Microphone active during your call")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        Log.i(TAG, "Microphone foreground service stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
