import { errorCode, errorMessage } from './errors';

const READ_PHONE_NUMBERS_PERMISSION = "android.permission.READ_PHONE_NUMBERS";

export const requiredPermissions = (error: unknown): readonly string[] => {
	const message = errorMessage(error);
	const permissions = message.match(/android\.permission\.[A-Z_]+/g) ?? [];
	if (
		errorCode(error) === "ERR_MISSING_CALL_PERMISSIONS" &&
		permissions.length === 0
	) {
		return [READ_PHONE_NUMBERS_PERMISSION];
	}
	return [...new Set(permissions)];
}
