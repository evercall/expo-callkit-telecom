import { ErrorContext } from '../Calls.types';

export const logDtmf = (message: string, context: ErrorContext, details: object = {}): void => {
	console.info(`[JsSipTelephonyEngine DTMF] ${message}`, {
		timestamp: new Date().toISOString(),
		...context,
		...details,
	});
}

