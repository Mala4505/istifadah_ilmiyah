'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddToTagDialog } from '@/components/tags/add-to-tag-dialog'

/** Entry-detail "Add to tag" button (super-admin only -- the page decides whether to render it). */
export function AddToTagControl({ entryId }: { entryId: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Tag className="h-3.5 w-3.5" />
        Add to tag…
      </Button>
      <AddToTagDialog open={open} onOpenChange={setOpen} entryIds={[entryId]} onDone={() => router.refresh()} />
    </>
  )
}
