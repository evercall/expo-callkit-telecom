export const AUDIO_OPTIONS = {
	mediaConstraints: { audio: true, video: false },
	sessionTimersExpires: 5400,
} as const;

export const REGISTRATION_TIMEOUT_MS = 30_000;
export const INVITE_DTMF_DELAY_MS = 5_000;
export const TRANSFER_TIMEOUT_MS = 20_000;
export const MAX_ICE_RESTART_ATTEMPTS = 3;
export const RECOVERY_TIMEOUT_MS = 45_000;
export const NEGOTIATION_TIMEOUT_MS = 15_000;
export const MEDIA_VERIFICATION_TIMEOUT_MS = 6_000;
export const TRANSIENT_GRACE_MS = 1_500;
export const RECOVERY_POLL_INTERVAL_MS = 500;
export const RECOVERY_TRIGGER_DEBOUNCE_MS = 300;
