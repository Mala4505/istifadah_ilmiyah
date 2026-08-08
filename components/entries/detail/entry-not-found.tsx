import { Card, CardContent } from '@/components/ui/card'

/**
 * Shown when the entry id in the URL isn't a valid number, doesn't exist, or
 * is hidden by `entries_select` RLS (department scoping / inactive staff
 * profile). Those three cases are indistinguishable from the Data API's
 * point of view by design — RLS returns "no row" rather than "forbidden" —
 * so a single honest message covers all of them rather than guessing.
 */
export function EntryNotFound({ id }: { id: string }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Entry {id}</h1>
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">Entry not found</p>
          <p className="text-sm text-muted-foreground">
            Either this entry doesn&apos;t exist, or you don&apos;t have access to it. Entries are
            scoped to your assigned department — if you believe this is a mistake, check with an
            admin that your staff profile is active and assigned to the right department.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
