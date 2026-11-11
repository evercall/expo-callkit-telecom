import { AppRegistry, Platform } from "react-native";

import { addCallSessionRemovedListener, getCallSession } from "../Calls";

export const ANDROID_TELEPHONY_HEADLESS_TASK = "ExpoCallKitTelecomHeadlessTask";

export interface TelephonyHeadlessEvent {
	event: "incomingPush" | "answer" | string;
	callId?: string;
}

/**
 * Registers the Android callback that restores SIP state for a killed/background app.
 * Call once from the application's entry module, outside any React component.
 */
export function registerAndroidTelephonyHeadlessTask(
	handler: (event: TelephonyHeadlessEvent) => Promise<void>,
): void {
	if (Platform.OS !== "android") return;
	AppRegistry.registerHeadlessTask(ANDROID_TELEPHONY_HEADLESS_TASK, () => handler);
}

// Separate from the application's restoration callback: keeping an existing call
// alive must not reconnect SIP or place another outgoing call.
const ANDROID_TELEPHONY_CALL_TASK = "ExpoCallKitTelecomCallTask";

async function keepCallTaskActive({ callId }: TelephonyHeadlessEvent): Promise<void> {
	if (!callId) return;

	let resolveEnded!: () => void;
	const ended = new Promise<void>((resolve) => {
		resolveEnded = resolve;
	});
	// Subscribe before reading native state to cover a call ending during startup.
	const subscription = addCallSessionRemovedListener(({ id }) => {
		if (id === callId) resolveEnded();
	});
	try {
		const session = await getCallSession(callId);
		if (session?.id !== callId) return;
		// React Native keeps background timers enabled while this promise is pending.
		await ended;
	} finally {
		subscription.remove();
	}
}

// Register at module load so headless startup also works without a mounted UI or
// an application-provided restoration handler.
if (Platform.OS === "android") {
	AppRegistry.registerHeadlessTask(ANDROID_TELEPHONY_CALL_TASK, () => keepCallTaskActive);
}
