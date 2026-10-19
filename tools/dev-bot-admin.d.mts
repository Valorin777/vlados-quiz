/** Ensures the DEV-only admin test user exists; resolves with its credentials (never log them). */
export function ensureDevBotAdmin(): Promise<{ email: string; password: string; uid: string }>;

/** Ensures the DEV-only NON-admin email user exists; resolves with its credentials (never log them). */
export function ensureDevBotUser(): Promise<{ email: string; password: string; uid: string }>;

/** DEV bot accounts only: marks the email verified (or not). Refresh the ID token afterwards. */
export function setDevEmailVerified(email: string, verified: boolean): Promise<void>;
