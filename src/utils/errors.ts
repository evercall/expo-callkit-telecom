import { SipFailureEvent } from '../Calls.types';

export const mediaFailureError = (operation: string, cause: unknown): Error => {
	return new Error(`${operation}: ${errorMessage(cause)}`);
}

export const errorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null || !("code" in error))
		return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

export const errorMessage = (error: unknown): string => {
	return error instanceof Error ? error.message : String(error);
}

export const sipFailureError = (prefix: string, event: SipFailureEvent): Error => {
	const message = "message" in event ? event.message : undefined;
	const response = "response" in event ? event.response : undefined;
	const candidate = response ?? message;
	const statusCode =
			  candidate && "status_code" in candidate
				  ? candidate.status_code
				  : event.code;
	const reasonPhrase =
			  candidate && "reason_phrase" in candidate
				  ? candidate.reason_phrase
				  : event.reason;
	const details = [
		event.cause,
		statusCode
			? `SIP ${statusCode}${reasonPhrase ? ` ${reasonPhrase}` : ""}`
			: reasonPhrase,
		"originator" in event && event.originator
			? `originator ${event.originator}`
			: undefined,
	].filter(Boolean);
	const error = new Error(
		`${prefix}: ${details.join("; ") || "unknown reason"}`
	) as Error & { code?: string };
	if (statusCode) error.code = `SIP_${statusCode}`;
	return error;
}
