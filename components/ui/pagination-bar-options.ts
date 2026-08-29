/**
 * Page-size choices shared by the pagination bar and by the Server Components
 * that validate the `size` URL param against them
 * (docs/hub-screen-certification.md §3.1).
 *
 * Kept in a plain (non-'use client') module on purpose: pagination-bar.tsx is
 * a client component, and a Server Component that imports a value — not a
 * component — from a 'use client' module gets a client-reference proxy rather
 * than the real array, so `PAGE_SIZE_OPTIONS.includes(...)` throws
 * "not a function" during the server render.
 */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const
