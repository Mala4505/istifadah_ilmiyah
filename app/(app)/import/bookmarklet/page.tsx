import { redirect } from 'next/navigation'

/**
 * The Portal Reader used to live on its own page here. It now lives inside
 * /import itself, alongside the file-upload card, so operators don't have to
 * navigate to a second page to find it. This redirect exists only in case
 * anything still links to the old URL.
 */
export default function BookmarkletPageRedirect() {
  redirect('/import')
}
