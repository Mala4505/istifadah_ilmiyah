// Browser-side download of a base64-encoded PDF. Mirrors downloadCsv in
// lib/reports/csv.ts, but for the binary path -- the PDF is built
// server-side (Server Components can't ship closures to a Client Component),
// base64-encoded to cross the boundary as a plain string, then decoded here.

export function downloadPdfBase64(filename: string, base64: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
