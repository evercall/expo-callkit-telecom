import type { EndEvent } from "jssip/lib/RTCSession";

import type { CallEndedReason } from "../Calls.types";

type Reason = { protocol: string; cause?: number };

export type SessionTermination = {
	reason: CallEndedReason | "localEnded";
	originator: string;
	cause: string;
	method?: string;
	statusCode?: number;
	reasonHeaderPresent: boolean;
	reasons: Reason[];
};

/** Keep method/status and structured Reason evidence; never log SIP messages,
 * raw headers, URIs, addresses, SDP, or arbitrary Reason text. */
export const sessionTermination = (event?: Partial<EndEvent>): SessionTermination => {
	const message = event?.message;
	const method = message?.method;
	const statusCode = message && "status_code" in message ? message.status_code : undefined;
	const headers = message?.getHeaders?.("Reason") ?? [];
	const reasons = headers.flatMap((header) =>
		// Remove quoted text before splitting list elements: a comma or a
		// protocol-looking string inside Reason text is not another reason.
		header.replace(/"(?:\\.|[^"\\])*"/g, '""').split(",").flatMap((value) => {
			const protocol = value.match(/^\s*(SIP|Q\.850)\s*(?:;|$)/i)?.[1];
			const code = value.match(/;\s*cause\s*=\s*(\d+)\s*(?:;|$)/i)?.[1];
			if (!protocol || !code) return [];
			return [{ protocol: protocol.toUpperCase(), cause: Number(code) }];
		})
	);
	const originator = event?.originator ?? "unknown";
	const cause = event?.cause ?? "unknown";
	let reason: SessionTermination["reason"] = "failed";
	const normalReason = reasons.every((value) =>
		value.protocol === "SIP" ? (value.cause ?? 0) < 400 : value.cause === 16 || value.cause === 31
	);
	if (originator === "remote" && cause === "Terminated" && method === "BYE" && normalReason) reason = "remoteEnded";
	if (originator === "local" && cause === "Terminated") reason = "localEnded";
	if (cause === "No Answer" || cause === "Expires" || (originator === "local" && cause === "Canceled")) reason = "unanswered";
	return {
		reason, originator, cause,
		method: method && /^[A-Z]+$/.test(method) ? method : undefined,
		statusCode, reasonHeaderPresent: headers.length > 0, reasons,
	};
};
