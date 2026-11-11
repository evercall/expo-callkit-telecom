package com.oney.WebRTCModule;

import com.facebook.react.bridge.ReactContext;
import org.webrtc.DtmfSender;
import org.webrtc.RtpSender;

/**
 * Bridges the native RTP DTMF sender missing from React Native WebRTC's JS API.
 * This package intentionally gives access to its package-private observer and
 * executor, so all sender operations use the same thread as WebRTC itself.
 */
public final class ExpoCallKitDtmfBridge {
    private ExpoCallKitDtmfBridge() {}

    public interface Result {
        void onSuccess();
        void onFailure(Exception error);
    }

    public interface StateResult {
        void onSuccess(int remainingSymbols, boolean canInsert, boolean audioTrackEnabled,
                       int durationMs, int interToneGapMs);
        void onFailure(Exception error);
    }

    private static RtpSender audioSender(ReactContext context, int peerConnectionId, String senderId) {
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null) throw new IllegalStateException("WebRTC module is unavailable");
        PeerConnectionObserver observer = module.getPeerConnectionObserver(peerConnectionId);
        if (observer == null || observer.getPeerConnection() == null) {
            throw new IllegalStateException("WebRTC peer connection is unavailable");
        }
        RtpSender sender = observer.getSender(senderId);
        if (sender == null || sender.track() == null || !"audio".equals(sender.track().kind())) {
            throw new IllegalStateException("WebRTC audio sender is unavailable");
        }
        return sender;
    }

    public static void inspect(ReactContext context, int peerConnectionId, String senderId,
                               StateResult result) {
        ThreadUtils.runOnExecutor(() -> {
            try {
                // Reacquire on each sample: getSenders() disposes previous Java wrappers.
                RtpSender sender = audioSender(context, peerConnectionId, senderId);
                DtmfSender dtmf = sender.dtmf();
                if (dtmf == null) throw new IllegalStateException("RTP DTMF sender is unavailable");
                result.onSuccess(dtmf.tones().length(), dtmf.canInsertDtmf(),
                    sender.track().enabled(), dtmf.duration(), dtmf.interToneGap());
            } catch (Exception error) {
                result.onFailure(error);
            }
        });
    }

    public static void send(ReactContext context, int peerConnectionId, String senderId,
                            String tones, Result result) {
        ThreadUtils.runOnExecutor(() -> {
            try {
                if (!tones.matches("[0-9A-D#*,]+")) {
                    throw new IllegalArgumentException("Invalid DTMF tones");
                }
                RtpSender sender = audioSender(context, peerConnectionId, senderId);
                DtmfSender dtmf = sender.dtmf();
                if (dtmf == null || !dtmf.canInsertDtmf()) {
                    throw new IllegalStateException("RTP DTMF is unavailable: telephone-event was not negotiated or the audio sender is inactive");
                }
                // Preserve any tones already queued by an earlier keypad action.
                if (!dtmf.insertDtmf(dtmf.tones() + tones, 100, 500)) {
                    throw new IllegalStateException("WebRTC rejected the RTP DTMF sequence");
                }
                result.onSuccess();
            } catch (Exception error) {
                result.onFailure(error);
            }
        });
    }
}
