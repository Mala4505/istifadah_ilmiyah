'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { saveMaxUploadPages } from '@/lib/actions/settings'

/**
 * Admin-only "Upload limits" card (docs/ocr-execution-decision.md
 * follow-up). A single numeric field -- deliberately not more, since
 * `app_settings` only has one column to configure today; this component
 * doesn't try to anticipate future settings that don't exist yet.
 */
export function UploadLimitSettings({ initialMaxUploadPages }: { initialMaxUploadPages: number }) {
  const [value, setValue] = useState(String(initialMaxUploadPages))
  const [isPending, startTransition] = useTransition()

  const parsed = Number(value)
  const isValid = value.trim() !== '' && Number.isInteger(parsed) && parsed >= 1 && parsed <= 500
  const isDirty = value !== String(initialMaxUploadPages)

  function handleSave() {
    if (!isValid) return
    startTransition(async () => {
      const result = await saveMaxUploadPages(parsed)
      if (!result.ok) {
        toastError(result.error, { context: 'upload-limit-settings' })
        return
      }
      toast.success('Upload limit saved.')
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 max-w-xs">
        <Label htmlFor="max-upload-pages">Maximum pages per upload</Label>
        <Input
          id="max-upload-pages"
          type="number"
          inputMode="numeric"
          min={1}
          max={500}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isPending}
        />
        <p className="text-xs text-muted-foreground">
          A PDF with more pages than this is rejected at upload, before it&apos;s stored or sent for OCR. Set
          below the point where extraction stops finishing within the platform&apos;s time limit — see the
          upload timeout notes for the currently measured ceiling.
        </p>
      </div>
      <div>
        <Button type="button" size="sm" onClick={handleSave} disabled={!isValid || !isDirty || isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
