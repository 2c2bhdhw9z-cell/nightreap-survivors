import { useMemo, useState } from "react";
import { Button } from "../ui/button";

/**
 * The buttons an operator can press.
 *
 * Every button on this panel was described by the server. The list, the inputs each one needs, whether it
 * can be undone and the warning it carries all arrive in the answer — none of it is written down here. So a
 * new action shows up with the right inputs and the right warning without this file changing, and this file
 * running against an older server cannot offer an action that server has never heard of.
 *
 * There is no free-form "write any row" form here on purpose. This panel can only express things the record
 * already understands.
 */

export interface ActionField {
  name: string;
  type: string;
  values: readonly number[];
}

export interface ActionOption {
  id: string;
  label: string;
  aboutAnAccount: boolean;
  fields: ActionField[];
  undoable: boolean;
  note: string;
}

type FieldValue = string | number | boolean;

function humanise(name: string): string {
  const spaced = name.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function hoursLabel(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) return `${hours / 24} day${hours === 24 ? "" : "s"}`;
  return `${hours} hours`;
}

/** Same shape the server insists on, said out loud so an operator is not guessing. */
export function reasonProblem(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 8) return "Say why in a sentence — at least eight characters.";
  if (new Set(trimmed.replace(/\s/g, "")).size < 2) return "That is not a reason. Write what happened.";
  if (trimmed.length > 512) return "Too long — keep it under 512 characters.";
  return "";
}

export function ActionForm({
  actions,
  subjectId,
  reason,
  actorId,
  busy,
  onSubmit,
}: {
  actions: ActionOption[];
  subjectId: string;
  reason: string;
  actorId: string;
  busy: boolean;
  onSubmit: (actionId: string, fields: Record<string, FieldValue>) => void;
}) {
  const [chosen, setChosen] = useState("");
  const [fields, setFields] = useState<Record<string, FieldValue>>({});

  const action = useMemo(() => actions.find((a) => a.id === chosen) ?? null, [actions, chosen]);

  function choose(id: string): void {
    setChosen(id);
    // Fields are cleared whenever the button changes. Carrying a number over from the last action is how an
    // amount typed for one thing ends up filed against another.
    setFields({});
  }

  const missing = action === null ? [] : action.fields.filter((f) => fields[f.name] === undefined || fields[f.name] === "");
  const needsAccount = action !== null && action.aboutAnAccount && subjectId.trim() === "";
  const refusesAccount = action !== null && !action.aboutAnAccount && subjectId.trim() !== "";
  const badReason = reasonProblem(reason);
  const blocked = action === null || busy || missing.length > 0 || needsAccount || refusesAccount || badReason !== "" || actorId.trim() === "";

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {actions.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => choose(option.id)}
            className={
              option.id === chosen
                ? "rounded border border-amber-600 bg-amber-950/60 px-3 py-1.5 text-sm text-amber-200"
                : "rounded border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-600"
            }
          >
            {option.label}
            {option.undoable ? "" : " ↯"}
          </button>
        ))}
      </div>

      {action === null ? (
        <p className="text-sm text-zinc-500">Pick something to do. Anything marked ↯ cannot be undone afterwards.</p>
      ) : (
        <div className="space-y-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-sm font-semibold text-zinc-100">{action.label}</div>

          {action.note === "" ? null : (
            <p className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">
              This cannot be undone. {action.note}
            </p>
          )}

          {action.fields.length === 0 ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              {action.fields.map((field) => (
                <label key={field.name} className="block text-sm">
                  <span className="text-zinc-400">{humanise(field.name)}</span>
                  {field.type === "oneOf" ? (
                    <select
                      aria-label={humanise(field.name)}
                      value={String(fields[field.name] ?? "")}
                      onChange={(event) => setFields((prev) => ({ ...prev, [field.name]: Number(event.target.value) }))}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                    >
                      <option value="">Choose…</option>
                      {field.values.map((value) => (
                        <option key={value} value={value}>
                          {field.name === "hours" ? hoursLabel(value) : value}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={humanise(field.name)}
                      type={field.type === "amount" ? "number" : "text"}
                      value={String(fields[field.name] ?? "")}
                      onChange={(event) =>
                        setFields((prev) => ({
                          ...prev,
                          [field.name]: field.type === "amount" ? Number(event.target.value) : event.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                    />
                  )}
                </label>
              ))}
            </div>
          )}

          <div className="space-y-1 text-xs text-red-300">
            {needsAccount ? <div>This one is about a player. Look an account up first.</div> : null}
            {refusesAccount ? <div>This one is not about a player. Clear the account box before filing it.</div> : null}
            {missing.length > 0 ? <div>Still needed: {missing.map((f) => humanise(f.name).toLowerCase()).join(", ")}.</div> : null}
            {actorId.trim() === "" ? <div>Put your own name in the operator box, so the record knows who did this.</div> : null}
            {badReason === "" ? null : <div>{badReason}</div>}
          </div>

          <Button disabled={blocked} onClick={() => onSubmit(action.id, fields)}>
            {busy ? "Filing…" : action.undoable ? "File it" : "File it — one way"}
          </Button>
        </div>
      )}
    </section>
  );
}
