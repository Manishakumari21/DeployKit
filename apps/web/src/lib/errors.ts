import { ApiError } from "./api";

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session expired. Sign in again to continue.";
    if (error.status === 403) return "You do not have access to this service.";
    if (error.status === 404) return "This service or configuration no longer exists.";
    if (error.status === 422) {
      return error.code ? `${error.message} (${error.code})` : error.message;
    }
    if (error.status === 504) {
      return error.code
        ? `Repository detection timed out (${error.code}). Try again.`
        : "Repository detection timed out. Try again.";
    }
    if (error.status === 502) {
      return error.code
        ? `The repository could not be reached (${error.code}). Try again shortly.`
        : "The repository could not be reached. Try again shortly.";
    }
    if (error.status === 400) return error.message || fallback;
    return fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
