export const decodeSipUser = (user: string): string => {
	try {
		return decodeURIComponent(user);
	} catch {
		return user;
	}
}

export const validateDtmfTones = (tones: string): void => {
	if (typeof tones !== "string" || !/^[0-9A-D#*,]+$/i.test(tones))
		throw new Error("Invalid DTMF tones");
}
