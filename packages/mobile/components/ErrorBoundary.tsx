/**
 * Re-export of the template's managed error boundary.
 *
 * The shipped template puts the component in `__ErrorBoundary.tsx` (system-managed, not to be
 * edited) while the `mobile-layout-keeps-template-providers` convention requires the root layout to
 * import `../components/ErrorBoundary`. This file bridges the two so `bun run lint` passes without
 * touching a `__`-prefixed file.
 */
export { ErrorBoundary } from "./__ErrorBoundary";
