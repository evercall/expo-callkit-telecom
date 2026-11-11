/**
 * Platform-neutral telephony contracts shared by browser and React Native clients.
 *
 * This file deliberately has no React, React Native, DOM, WebRTC, JsSIP, or
 * native-module imports. Implementations may use those technologies, while
 * application code can depend on this stable surface.
 */

export enum TelephonyClientStatus {
	CONNECTING    = "connecting",
	CONNECTED     = "connected",
	RECOVERING    = "recovering",
	DISCONNECTING = "disconnecting",
	DISCONNECTED  = "disconnected",
}

export enum TelephonySessionStatus {
	TRYING     = "trying",
	RINGING    = "ringing",
	ACTIVE     = "active",
	ON_HOLD    = "on_hold",
	TERMINATED = "terminated",
}

export type AudioDeviceDirection = "input" | "output";

/** Normalized port kinds; nativeType preserves platform-specific and future kinds. */
export type AudioDeviceType =
	| "bluetooth_hfp" | "bluetooth_a2dp" | "bluetooth_le"
	| "builtin_speaker" | "builtin_mic" | "builtin_earpiece"
	| "wired_headset" | "wired_headphones" | "usb" | "hdmi"
	| "line" | "airplay" | "car_audio" | "hearing_aid" | "unknown";

export interface AudioDevice {
	/** Opaque, direction-specific identifier. Re-enumerate after hardware changes. */
	readonly id: string;
	readonly direction: AudioDeviceDirection;
	readonly type: AudioDeviceType;
	readonly friendlyName: string;
	/** Observed on the current native route, not the last requested selection.
	 * null means the platform cannot determine activity reliably (currently all
	 * Android inputs, or a missing/ambiguous route). Re-enumerate on device events.
	 * This describes routing, not whether audio is playing or being recorded.
	 */
	readonly isActive: boolean | null;
	/** AVAudioSession port value or Android AudioDeviceInfo type number as a string. */
	readonly nativeType: string;
	/** Paired selection can change both input and output, as in the native call UI. */
	readonly routing: "paired" | "independent";
}

export type TelephonyCallDirection = "incoming" | "outgoing";

export interface TelephonyRemoteIdentity {
	phoneNumber: string;
	displayName: string;
}

export interface TelephonyAccount {
	/** Stable application-level account identifier. */
	id: string;
	/** SIP address of record, for example `sip:alice@example.com`. */
	uri: string;
	/** Optional Contact URI, including provider-specific push parameters. */
	contactUri?: string;
	authorizationUser: string;
	password: string;
	displayName?: string;
	/** WSS endpoint used by the JavaScript SIP engine. */
	websocketUrl: string;
	registrationExpiresSeconds?: number;
	userAgent?: string;
}

export interface TelephonyConfiguration {
	account: TelephonyAccount;
	iceServers?: RTCIceServer[];
	/** DTMF transport. Defaults to RFC2833 (RTP) on Android/iOS and SIP INFO elsewhere. */
	dtmfTransport?: "RFC2833" | "INFO";
	registrationRetry?: {
		initialDelayMs: number;
		maximumDelayMs: number;
		maximumAttempts?: number;
	};
}

export interface TelephonySessionSnapshot {
	id: string;
	nativeCallId: string;
	sipCallId?: string;
	direction: TelephonyCallDirection;
	status: TelephonySessionStatus;
	remoteIdentity: TelephonyRemoteIdentity;
	/** Unix timestamp in milliseconds when the session started. */
	startedAt: number;
	/** Unix timestamp in milliseconds when the call connected. */
	connectedAt?: number;
	/** Unix timestamp in milliseconds when the session ended. */
	endedAt?: number;
	isMuted: boolean;
	isOnHold: boolean;
}

export interface TelephonySnapshot {
	clientStatus: TelephonyClientStatus;
	selectedAccountId?: string;
	sessions: readonly TelephonySessionSnapshot[];
	revision: number;
}

export type TelephonySnapshotListener = (snapshot: TelephonySnapshot) => void;

/** The asynchronous engine operation that failed. */
export type TelephonyErrorOperation =
	| "registration"
	| "transport"
	| "sessionFailed"
	| "mediaNegotiation"
	| "audioSession"
	| "reportIncomingCall"
	| "answerFromSystem"
	| "endFromSystem"
	| "callFromSystem"
	| "confirmSession"
	| "terminateSession"
	| "acceptSession"
	| "muteFromSystem"
	| "holdFromSystem"
	| "sendDtmfFromSystem"
	| "sendDtmf";

/**
 * Error reported by work initiated from a native or JsSIP event callback.
 *
 * Event callbacks cannot return their promises to application code. Subscribe
 * to these errors to surface failures such as a missing Android runtime
 * permission without relying on a global unhandled-rejection handler.
 */
export interface TelephonyError {
	/** Stable library-level classification. */
	code: "missing_permissions" | "operation_failed";
	/** Native/underlying error code, when one was supplied. */
	nativeCode?: string;
	message: string;
	operation: TelephonyErrorOperation;
	/** Android permission names that the consuming app may request. */
	requiredPermissions: readonly string[];
	nativeCallId?: string;
	sipCallId?: string;
	cause: unknown;
}

export type TelephonyErrorListener = (error: TelephonyError) => void;

export interface TelephonySession {
	readonly id: string;
	readonly snapshot: TelephonySessionSnapshot;

	accept(): Promise<void>;

	accepted(): Promise<boolean>;

	reject(): Promise<void>;

	cancel(): Promise<void>;

	terminate(): Promise<void>;

	hold(): Promise<boolean>;

	unhold(): Promise<boolean>;

	/**
	 * Blind transfer to a SIP URI. Resolves true when REFER is accepted, then ends
	 * this call, matching WebphoneLib. Rejection or a 20-second timeout returns
	 * false and preserves the call. Invalid arguments or call state reject.
	 * REFER acceptance does not guarantee the destination subsequently answers.
	 */
	blindTransfer(target: string): Promise<boolean>;

	/**
	 * Transfer to another established session belonging to the same engine.
	 * Uses SIP REFER with Replaces. Only the source call is ended on acceptance;
	 * the server controls the consultation call's subsequent lifecycle.
	 */
	attendedTransfer(target: { id: string }): Promise<boolean>;

	setMuted(muted: boolean): Promise<void>;

	/** Requests a native route change. Audio routing is shared by all calls.
	 * Resolves when the OS accepts the request; observe route events for actual routing.
	 * Rejects stale devices, wrong directions, ended calls and unsupported routing.
	 */
	setInput(device: AudioDevice): Promise<void>;

	/** Same routing semantics and errors as setInput. */
	setOutput(device: AudioDevice): Promise<void>;

	/**
	 * Sends tones after call confirmation. Rejects if the call ends first.
	 * Tones may contain only `0-9`, `A-D`, `#`, `*`, and comma pause.
	 */
	dtmf(tones: string): Promise<void>;
}

/**
 * WebphoneLib-style client contract implemented independently per platform.
 *
 * The React Native implementation uses JsSIP and native call integration. The
 * Electron implementation may adapt the existing WebphoneLib client to this
 * interface without importing mobile code.
 */
export interface TelephonyEngine {
	reconfigure(configuration: TelephonyConfiguration): Promise<void>;

	connect(): Promise<boolean>;

	disconnect(): Promise<void>;

	close(): Promise<void>;

	isConnected(): boolean;

	/**
	 * Starts a call and returns its session without waiting for acceptance.
	 * Optional tones are sent five seconds after call confirmation to allow the
	 * remote IVR to become ready; commas add two-second pauses.
	 * Manual session.dtmf() calls do not have this automatic delay.
	 * Automatic tone failures are reported through subscribeToErrors.
	 */
	invite(uri: string, tones?: string): Promise<TelephonySession>;

	getSession(id: string): TelephonySession | undefined;

	getSessions(): readonly TelephonySession[];

	/** WebphoneLib-compatible attended transfer; accepts sessions or ID references. */
	attendedTransfer(a: { id: string }, b: { id: string }): Promise<boolean>;

	/** Discover call-compatible devices without activating audio or asking for permissions.
	 * iOS exposes inputs, speaker/receiver and outputs paired with available inputs;
	 * arbitrary AirPlay/A2DP outputs require the system route picker.
	 * Android selection requires API 31+; managed Telecom can override requests.
	 * Available devices can depend on call activation and granted permissions.
	 */
	getAudioDevices(direction: AudioDeviceDirection): readonly AudioDevice[];

	/** Re-enumerate devices/current native route when notified. Unsubscribe on cleanup. */
	subscribeToAudioDevices(listener: () => void): () => void;

	getSnapshot(): TelephonySnapshot;

	subscribe(listener: TelephonySnapshotListener): () => void;

	/**
	 * Subscribes to failures from work started by native and JsSIP callbacks.
	 * Direct API calls such as {@link invite} continue to reject their returned
	 * promises normally and are not duplicated here.
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = engine.subscribeToErrors((error) => {
	 *   if (error.code === "missing_permissions") {
	 *     showPermissionPrompt(error.requiredPermissions);
	 *   }
	 * });
	 * ```
	 */
	subscribeToErrors(listener: TelephonyErrorListener): () => void;

	getConfiguration(): TelephonyConfiguration|undefined;
}
