/**
 * Promise.withResolvers (ES2024) polyfill. pdfjs-dist >=4.9's main-thread API
 * surface calls this directly (the worker script has its own copy of this
 * same polyfill baked into public/pdf.worker.min.mjs, since a page-level
 * polyfill can't reach a Worker's separate global scope) -- unsupported on
 * browsers older than Chrome 119 / Safari 17.4 / Firefox 121, which throws
 * "Promise.withResolvers is not a function" (2026-09-16 bug report, /review).
 * Idempotent -- safe to call more than once.
 */
export function ensurePromiseWithResolversPolyfill(): void {
  if (typeof Promise.withResolvers === 'function') return
  Promise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}
