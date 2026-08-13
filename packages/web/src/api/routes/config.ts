import { base } from "../__core/app";

/**
 * The remote-config document the app reads at launch.
 *
 * This is the server half of the switchboard described in `packages/mobile/game/config/remote-config.ts`.
 * It has one job: hand out the current document. Every rule about what a document *means* — kills beating
 * allow lists, rollouts, staleness, build gates — lives on the client and is tested there, because the
 * client is where the decision is made and it has to reach the same answer with no network at all.
 *
 * WHERE THE DOCUMENT COMES FROM
 * For now: the `REMOTE_CONFIG_JSON` environment value, falling back to the baked document below. Setting
 * that value and restarting the server changes what every app is told, without an app update or a store
 * review — which is the whole promise this is here to keep. Phase 3 replaces it with a stored row and the
 * break-glass admin page, and the shape handed to the client does not change when it does.
 *
 * WHY THIS BARELY VALIDATES
 * It checks the smallest thing that stops an operator mistake from being served — a document has to parse
 * and carry a whole, non-negative revision — and no more. The client refuses anything malformed whole,
 * keeps the document it already had, and never crashes on a bad response. Validating twice, differently,
 * would just create a way for the two halves to disagree.
 *
 * NOT A SECURITY BOUNDARY. Anything here can be faked by a patched client that skips the fetch entirely.
 * Nothing served here grants power: it opens and closes gates in front of features that defend themselves
 * server-side anyway.
 */

/** What ships if nobody has published anything: every gate shut, posting a run allowed. */
const BAKED = {
  revision: 1,
  flags: {
    ladderPosting: { on: true },
  },
} as const;

interface Doc {
  revision: number;
  flags: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the published document, or fall back.
 *
 * A broken environment value serves the baked document rather than an error: an app that cannot read
 * config keeps its own defaults, so serving nothing and serving the defaults are the same outcome — but
 * one of them also logs the mistake for us.
 */
function published(): Doc {
  const raw = process.env.REMOTE_CONFIG_JSON;
  if (raw === undefined || raw.trim() === "") return { revision: BAKED.revision, flags: { ...BAKED.flags } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    console.warn("[config] REMOTE_CONFIG_JSON is not valid JSON — serving the built-in document");
    return { revision: BAKED.revision, flags: { ...BAKED.flags } };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.flags)) {
    console.warn("[config] REMOTE_CONFIG_JSON has no flags block — serving the built-in document");
    return { revision: BAKED.revision, flags: { ...BAKED.flags } };
  }

  const revision = parsed.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    console.warn("[config] REMOTE_CONFIG_JSON has no usable revision — serving the built-in document");
    return { revision: BAKED.revision, flags: { ...BAKED.flags } };
  }

  return { revision, flags: parsed.flags };
}

/**
 * `client.config()` — the whole of the app's config fetch.
 *
 * Takes no input on purpose. Per-account and per-build targeting is expressed *inside* the document, as
 * allow lists, deny lists, rollout percentages and minimum builds, and evaluated on the device. So the
 * same bytes go to everybody, which means the document can be cached, compared, and read by us in one
 * place to know exactly what the world is being told.
 */
export const config = base.handler(() => published());
