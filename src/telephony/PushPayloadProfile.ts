import { Platform } from "react-native";

import ExpoCallKitTelecomModule from "../ExpoCallKitTelecomModule";

export type PushCallEvent =
	| "incoming"
	| "cancelled"
	| "answeredElsewhere";

export type PushScalar = string | number | boolean | null;

export interface PushFieldMapping {
	/** Dot-separated object path. Array indexing and executable expressions are intentionally absent. */
	path?: string;
	constant?: PushScalar;
	defaultValue?: PushScalar;
	required?: boolean;
}

export interface PushMatchRule {
	path: string;
	equals: PushScalar;
}

export interface PushEventMapping extends PushFieldMapping {
	values: Readonly<Record<string, PushCallEvent>>;
}

export interface PushPayloadProfile {
	id: string;
	version: number;
	match?: readonly PushMatchRule[];
	fields: {
		event: PushEventMapping;
		callId: PushFieldMapping;
		accountId?: PushFieldMapping;
		callerName?: PushFieldMapping;
		callerHandle: PushFieldMapping;
		expiresAt?: PushFieldMapping;
		revision?: PushFieldMapping;
	};
}

export interface NormalizedCallPush {
	profileId: string;
	profileVersion: number;
	event: PushCallEvent;
	callId: string;
	accountId?: string;
	callerName?: string;
	callerHandle: string;
	expiresAt?: string;
	revision?: number;
}

export interface PushProfileValidationError {
	path: string;
	message: string;
}

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateField(
	field: PushFieldMapping | undefined,
	path: string,
	required: boolean,
	errors: PushProfileValidationError[],
): void {
	if (!field) {
		if (required) errors.push({ path, message: "field mapping is required" });
		return;
	}

	const sourceCount = Number(field.path !== undefined) + Number(field.constant !== undefined);
	if (sourceCount !== 1) {
		errors.push({
			path,
			message: "exactly one of path or constant must be supplied",
		});
	}

	if (field.path !== undefined) {
		const segments = field.path.split(".");
		if (segments.length === 0 || segments.some((segment) => !SEGMENT_PATTERN.test(segment))) {
			errors.push({ path: `${path}.path`, message: "path contains an invalid segment" });
		}
	}
}

/** Validates profiles before they are persisted by the native layer. */
export function validatePushPayloadProfile(
	profile: PushPayloadProfile,
): readonly PushProfileValidationError[] {
	const errors: PushProfileValidationError[] = [];

	if (!profile.id.trim()) errors.push({ path: "id", message: "id is required" });
	if (!Number.isSafeInteger(profile.version) || profile.version < 1) {
		errors.push({ path: "version", message: "version must be a positive integer" });
	}

	profile.match?.forEach((rule, index) => {
		if (!rule.path || rule.path.split(".").some((segment) => !SEGMENT_PATTERN.test(segment))) {
			errors.push({ path: `match.${index}.path`, message: "path contains an invalid segment" });
		}
	});

	validateField(profile.fields.event, "fields.event", true, errors);
	if (Object.keys(profile.fields.event.values).length === 0) {
		errors.push({ path: "fields.event.values", message: "at least one event value is required" });
	}
	validateField(profile.fields.callId, "fields.callId", true, errors);
	validateField(profile.fields.accountId, "fields.accountId", false, errors);
	validateField(profile.fields.callerName, "fields.callerName", false, errors);
	validateField(profile.fields.callerHandle, "fields.callerHandle", true, errors);
	validateField(profile.fields.expiresAt, "fields.expiresAt", false, errors);
	validateField(profile.fields.revision, "fields.revision", false, errors);

	return errors;
}

/** Throws a stable error when a profile is not safe to persist. */
export function assertValidPushPayloadProfile(profile: PushPayloadProfile): void {
	const errors = validatePushPayloadProfile(profile);
	if (errors.length > 0) {
		const detail = errors.map((error) => `${error.path}: ${error.message}`).join("; ");
		throw new Error(`Invalid push payload profile: ${detail}`);
	}
}

/**
 * Validates and persists payload mappings used by native push handlers before JS starts.
 * Profiles are data-only and may be replaced at runtime without rebuilding the application.
 */
export function configurePushPayloadProfiles(
	profiles: readonly PushPayloadProfile[],
): void {
	if (profiles.length === 0) throw new Error("At least one push payload profile is required");
	profiles.forEach(assertValidPushPayloadProfile);
	if (Platform.OS === "android" || Platform.OS === "ios") {
		ExpoCallKitTelecomModule.configurePushPayloadProfiles(JSON.stringify(profiles));
	}
}

/** Returns the profiles currently persisted by the native push handler. */
export function getConfiguredPushPayloadProfiles(): readonly PushPayloadProfile[] {
	if (Platform.OS !== "android" && Platform.OS !== "ios") return [];
	const json = ExpoCallKitTelecomModule.getPushPayloadProfilesJson();
	if (!json) return [];
	const profiles = JSON.parse(json) as PushPayloadProfile[];
	profiles.forEach(assertValidPushPayloadProfile);
	return profiles;
}
