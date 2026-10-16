// Plain module (no 'use client' / 'server-only'): imported by both the
// change-password server action and its client form so the rule lives once.

/** Same floor as lib/generate-password.ts (which makes 16-char passwords). */
export const MIN_PASSWORD_LENGTH = 10

/** Supabase Auth (bcrypt) rejects anything longer than 72 characters. */
export const MAX_PASSWORD_LENGTH = 72
