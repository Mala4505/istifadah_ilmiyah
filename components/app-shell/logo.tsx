import Image from 'next/image'
import { cn } from '@/lib/utils'

/**
 * The source art is dark maroon/gold ink on a transparent background, meant
 * to sit on a light page. Against the dark-mode card background both colors
 * drop below readable contrast, so dark mode gets a light backing plate
 * behind the mark instead of a re-colored asset.
 */
export function Logo({ className, imageClassName }: { className?: string; imageClassName?: string }) {
  return (
    <div className={cn('inline-flex rounded-lg dark:bg-[#f6f3ef] dark:p-2', className)}>
      <Image
        src="/istifadah_logo_1_alpha.png"
        alt="Istifadah Ilmiyah"
        width={505}
        height={502}
        priority
        className={cn('h-auto', imageClassName)}
      />
    </div>
  )
}
