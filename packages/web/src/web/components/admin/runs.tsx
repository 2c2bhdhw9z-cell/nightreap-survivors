import { Button } from "../ui/button";
import { lengthText, sizeText, tagsFor, wasKept, whenText } from "./runs-text";

/**
 * Runs that arrived, exactly as they were filed.
 *
 * WHAT THIS SCREEN IS FOR
 * Every finished run is uploaded with the recording it was played from. The server reads the recording,
 * decides whether to keep the run as a result, and then keeps the recording either way. This is the window
 * onto that pile: what came in, what was kept, what was turned away and why, and which kept runs looked odd
 * enough to be worth a person's time.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * There is no "handled" tick and no "clear this flag" button. A run being looked at is not a fact about the
 * run, and a list that let anybody quietly mark things as fine would be the first thing somebody leaned on.
 * If a run deserves a consequence, that consequence is a line in the record with a name, a reason and a
 * date on it, filed from the panel above — never a checkbox down here.
 *
 * A turned-away run is still shown. Refusals are the interesting rows: one honest player fails a check by
 * accident, while somebody probing the door fails a hundred in a minute, and that pattern only exists
 * because the refusals were kept.
 */

export interface RunRow {
  id: number;
  accountId: string;
  receivedAt: number;
  refusal: number;
  refusalReason: string;
  flagCount: number;
  flagReasons: string[];
  limitsVersion: number;
  ladderEligible: boolean;
  seed: number;
  stageId: number;
  ticks: number;
  playerCount: number;
  tainted: number;
  buildId: number;
  contentVersion: number;
  bytes: number;
  summary: string;
}

export interface RunLog {
  id: number;
  blob: string;
  bytes: number;
  claimJson: string;
  verdictJson: string;
}

export { sizeText } from "./runs-text";

function Chip({ text, tone }: { text: string; tone: "kept" | "away" | "odd" | "quiet" }) {
  const skin =
    tone === "kept"
      ? "border-emerald-800 bg-emerald-950/60 text-emerald-200"
      : tone === "away"
        ? "border-red-900 bg-red-950/60 text-red-200"
        : tone === "odd"
          ? "border-amber-800 bg-amber-950/50 text-amber-200"
          : "border-zinc-700 bg-zinc-900 text-zinc-400";
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] ${skin}`}>{text}</span>;
}

function RunCard({
  row,
  log,
  logBusy,
  logProblem,
  onFetchLog,
  onLookUp,
}: {
  row: RunRow;
  log: RunLog | null;
  logBusy: boolean;
  logProblem: string;
  onFetchLog: (id: number) => void;
  onLookUp: (accountId: string) => void;
}) {
  const kept = wasKept(row.refusal);
  const showingLog = log !== null && log.id === row.id;
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-zinc-500">#{row.id}</span>
        {tagsFor(row).map((tag) => (
          <Chip key={tag} text={tag} tone={tag === "Kept" ? "kept" : tag === "Turned away" ? "away" : tag === "Not for the boards" ? "quiet" : "odd"} />
        ))}
        <button
          type="button"
          onClick={() => onLookUp(row.accountId)}
          className="font-mono text-xs text-cyan-300 hover:underline"
          title="Look this player up above"
        >
          {row.accountId}
        </button>
        <span className="ml-auto text-xs text-zinc-500">{whenText(row.receivedAt)}</span>
      </div>

      <div className="mt-2 grid gap-x-4 gap-y-1 text-xs text-zinc-400 sm:grid-cols-3">
        <span>Lasted {lengthText(row.ticks)}</span>
        <span>Stage {row.stageId}</span>
        <span>
          {row.playerCount} player{row.playerCount === 1 ? "" : "s"}
        </span>
        <span>Recording {sizeText(row.bytes)}</span>
        <span className="font-mono">seed {row.seed}</span>
        <span className="font-mono">build {row.buildId}</span>
      </div>

      {kept ? null : <p className="mt-2 text-xs text-red-200">Turned away because: {row.refusalReason}</p>}

      {row.flagReasons.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-amber-200">
          {row.flagReasons.map((reason, at) => (
            <li key={`${row.id}-${at}`}>{reason}</li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 font-mono text-[11px] text-zinc-500">{row.summary}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={logBusy} onClick={() => onFetchLog(row.id)}>
          {showingLog ? "Fetch the recording again" : "Fetch the recording"}
        </Button>
        <span className="text-[11px] text-zinc-600">
          The recording is the evidence. It is never rewritten, and reading it changes nothing.
        </span>
      </div>

      {logBusy ? <p className="mt-2 text-xs text-zinc-500">Reading the recording…</p> : null}
      {logProblem === "" ? null : <p className="mt-2 text-xs text-red-200">{logProblem}</p>}

      {showingLog ? (
        <div className="mt-2 space-y-2 rounded border border-zinc-800 bg-zinc-950 p-2">
          <p className="text-xs text-zinc-400">
            {sizeText(log.bytes)} of recording, stored exactly as it arrived.
          </p>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">What the device said happened</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-zinc-300">{log.claimJson}</pre>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">What the server decided at the time</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-zinc-300">{log.verdictJson}</pre>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">First part of the recording itself</div>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-zinc-500">
              {log.blob.slice(0, 512)}
              {log.blob.length > 512 ? "…" : ""}
            </pre>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** The list itself: newest first, one card per upload. */
export function RunList({
  rows,
  log,
  logForId,
  logBusy,
  logProblem,
  onFetchLog,
  onLookUp,
  empty,
}: {
  rows: RunRow[];
  log: RunLog | null;
  logForId: number;
  logBusy: boolean;
  logProblem: string;
  onFetchLog: (id: number) => void;
  onLookUp: (accountId: string) => void;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <RunCard
          key={row.id}
          row={row}
          log={log}
          logBusy={logBusy && logForId === row.id}
          logProblem={logForId === row.id ? logProblem : ""}
          onFetchLog={onFetchLog}
          onLookUp={onLookUp}
        />
      ))}
    </ul>
  );
}

/** The two narrowing switches, plus a plain count of what is on screen. */
export function RunFilters({
  onlyRefused,
  onlyFlagged,
  showing,
  onChange,
}: {
  onlyRefused: boolean;
  onlyFlagged: boolean;
  showing: number;
  onChange: (next: { onlyRefused: boolean; onlyFlagged: boolean }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Only the ones turned away"
          checked={onlyRefused}
          onChange={(event) => onChange({ onlyRefused: event.target.checked, onlyFlagged })}
        />
        Only the ones turned away
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Only the ones worth a look"
          checked={onlyFlagged}
          onChange={(event) => onChange({ onlyRefused, onlyFlagged: event.target.checked })}
        />
        Only the ones worth a look
      </label>
      <span className="text-zinc-600">
        Showing {showing} upload{showing === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** How one account's uploads have gone. Three counts, no verdict about the person. */
export function RunTally({ accepted, refused, flagged }: { accepted: number; refused: number; flagged: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Chip text={`${accepted} kept`} tone="kept" />
      <Chip text={`${refused} turned away`} tone="away" />
      <Chip text={`${flagged} worth a look`} tone="odd" />
    </div>
  );
}
