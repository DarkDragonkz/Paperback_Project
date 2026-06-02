const DEBUG_SOURCE_LOGS = false

export function debugLog(message?: unknown, ...optionalParams: unknown[]): void {
  if (DEBUG_SOURCE_LOGS) globalThis.console.log(message, ...optionalParams)
}
