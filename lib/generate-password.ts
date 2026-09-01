/** Random, readable-enough temporary password — the admin hands it to the user out of band. */
export function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16)
}
