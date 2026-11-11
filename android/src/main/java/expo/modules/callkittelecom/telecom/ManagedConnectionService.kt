package expo.modules.callkittelecom.telecom

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle

/** ConnectionService bound by Android Telecom for the registered Evercall PhoneAccount. */
class ManagedConnectionService : ConnectionService() {
    override fun onCreate() {
        super.onCreate()
        ManagedCallManager.shared.initialize(applicationContext)
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest,
    ): Connection = ManagedCallManager.shared.createIncomingConnection(request)

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest,
    ): Connection = ManagedCallManager.shared.createOutgoingConnection(request)

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest,
    ) {
        ManagedCallManager.shared.onCreateConnectionFailed(request)
    }

    override fun onCreateOutgoingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest,
    ) {
        ManagedCallManager.shared.onCreateConnectionFailed(request)
    }
}

