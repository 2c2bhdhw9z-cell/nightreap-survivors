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
