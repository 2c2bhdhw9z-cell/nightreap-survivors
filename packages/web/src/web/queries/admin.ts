import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpcAdmin } from "../lib/api";

/**
 * Data hooks for the break-glass page.
 *
 * Every one of these goes through the operator client, so every request carries the token this tab is
 * holding and a tab holding nothing gets a plain refusal rather than a blank screen.
 *
 * Nothing here caches for long. An operator looking at an account during an incident is asking what is
 * true right now, and a stale answer is the one thing this page must never give.
 */

/** What buttons exist, what each needs, and which can be undone — computed by the server, never listed here. */
export function useActionCatalogue(enabled: boolean) {
  return useQuery({
    ...orpcAdmin.admin.catalogue.queryOptions({ input: {} }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** One account: its standing recomputed from its rows, and its rows newest first. */
export function useAccount(subjectId: string, enabled: boolean) {
  return useQuery({
    ...orpcAdmin.admin.account.queryOptions({ input: { subjectId, limit: 200 } }),
    enabled: enabled && subjectId.length > 0,
    staleTime: 0,
    retry: false,
  });
}

/** The did / undid / redid story around one row. */
export function useStory(seq: number) {
  return useQuery({
    ...orpcAdmin.events.story.queryOptions({ input: { seq } }),
    enabled: seq > 0,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Anything that writes.
 *
 * All three invalidate everything the page is showing rather than patching a list in place. The page's whole
 * claim is that what it shows was recomputed from the rows; quietly editing the copy on screen to look
 * right would make that claim false at exactly the moment it matters.
 */
function useRefresh() {
  const queries = useQueryClient();
  return () => {
    void queries.invalidateQueries();
  };
}

export function useTakeAction() {
  const refresh = useRefresh();
  return useMutation({ ...orpcAdmin.admin.act.mutationOptions(), onSuccess: refresh });
}

export function useUndoRow() {
  const refresh = useRefresh();
  return useMutation({ ...orpcAdmin.admin.undo.mutationOptions(), onSuccess: refresh });
}

export function useRedoRow() {
  const refresh = useRefresh();
  return useMutation({ ...orpcAdmin.events.restore.mutationOptions(), onSuccess: refresh });
}

/* ---------------------------------------------------------------------------------------------- */
/* Runs that came in                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The newest uploads, newest first, optionally narrowed to the ones worth a look.
 *
 * The two switches are a filter and nothing else. Nothing here marks a run as dealt with, because "dealt
 * with" is somebody's opinion and opinions belong in the record with a name on them, not in a list on a
 * screen that anybody can quietly change.
 */
export function useRecentRuns(
  options: { limit: number; onlyFlagged: boolean; onlyRefused: boolean },
  enabled: boolean,
) {
  return useQuery({
    ...orpcAdmin.runs.recent.queryOptions({ input: options }),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/** Every upload one account has ever filed, with how many were kept, turned away, and worth a look. */
export function useAccountRuns(accountId: string, enabled: boolean) {
  return useQuery({
    ...orpcAdmin.runs.forAccount.queryOptions({ input: { accountId, limit: 50 } }),
    enabled: enabled && accountId.length > 0,
    staleTime: 0,
    retry: false,
  });
}

/**
 * The stored recording of one run.
 *
 * Asked for on purpose and one at a time. These are by far the biggest thing kept about a run, and a screen
 * that pulled them while somebody scrolled would be moving megabytes for nothing.
 */
export function useRunBlob(id: number) {
  return useQuery({
    ...orpcAdmin.runs.blobOf.queryOptions({ input: { id } }),
    enabled: id > 0,
    staleTime: 0,
    retry: false,
  });
}
