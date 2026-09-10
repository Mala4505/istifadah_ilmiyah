import { redirect } from 'next/navigation'

/**
 * The superadmin workload board used to live on its own route here, with its
 * own nav item. It now folds into /documents as an `Inbox | Workload` view
 * toggle (redesign plan Phase 1.2). This redirect exists only so anything
 * still linking to the old URL lands on the new view.
 */
export default function DocumentsWorkloadRedirect() {
  redirect('/documents?view=workload')
}
