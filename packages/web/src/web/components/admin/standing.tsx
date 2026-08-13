/**
 * An account's standing, as worked out from its rows.
 *
 * Nothing on this panel is read from a stored total. Every number here was added up from the account's own
 * history a moment ago, which is the whole argument of the log made visible: if a stored total and this
 * panel ever disagreed, this panel would be the one telling the truth.
 */

export interface Standing {
  gold: number;
  marks: number;
  unlocks: number;
  runsAccepted: number;
  runsRevoked: number;
  strikes: number;
  muted: boolean;
  chatBanned: boolean;
  flagged: boolean;
  segregated: boolean;
  events: number;
  reversed: number;
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function Mark({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={
        on
          ? "rounded border border-red-900 bg-red-950/70 px-2 py-1 text-xs font-semibold text-red-300"
          : "rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-600"
      }
    >
      {label}
      {on ? "" : " — no"}
    </span>
  );
}

export function StandingPanel({ standing, total }: { standing: Standing; total: number }) {
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Gold" value={standing.gold.toLocaleString()} />
        <Tile label="Reaper marks" value={standing.marks.toLocaleString()} />
        <Tile label="Unlocks given" value={standing.unlocks} />
        <Tile label="Chat strikes" value={standing.strikes} />
        <Tile label="Runs accepted" value={standing.runsAccepted} />
        <Tile label="Runs thrown out" value={standing.runsRevoked} />
        <Tile label="Things on record" value={total} />
        <Tile label="Of those, undone" value={standing.reversed} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Mark label="Muted" on={standing.muted} />
        <Mark label="Chat banned" on={standing.chatBanned} />
        <Mark label="Flagged" on={standing.flagged} />
        <Mark label="Kept off the ladders" on={standing.segregated} />
      </div>

      <p className="text-xs text-zinc-500">
        Worked out from this account's history just now, not read from a saved total.
      </p>
    </section>
  );
}
