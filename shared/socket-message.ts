/** Elysia parses JSON text frames before invoking WebSocket message handlers. */
export function socketMessage(
	value: unknown,
): string | ArrayBuffer | Uint8Array {
	if (
		typeof value === "string" ||
		value instanceof ArrayBuffer ||
		value instanceof Uint8Array
	)
		return value;
	return JSON.stringify(value) ?? "";
}
