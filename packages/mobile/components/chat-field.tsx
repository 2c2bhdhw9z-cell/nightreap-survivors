/**
 * The chat field, in whichever keyboard the player chose.
 *
 * Two keyboards, one field, one filter. The choice is a setting — `Settings → Interface → Chat keyboard`
 * — and it is read from the resolved settings here, on the first line, rather than picked by this
 * component. That matters: the in-game keyboard cannot type most of the world's languages, so the
 * settings layer forces those players onto the phone keyboard whether they chose it or not, and a screen
 * that made its own decision would undo that.
 *
 * The phone keyboard is the default and brings autocorrect, swipe, dictation, emoji, every language and
 * the accessibility features the operating system already built. The in-game one exists because it looks
 * like the game.
 *
 * Both write into the same field and both go through the same refusal path, so there is no way to get a
 * message out through one that the other would have stopped.
 *
 * Typing exists in the lobby and on the results screen only. There is no keyboard in a run, ever — a run
 * has the six preset shouts and a ping, and that is the whole of it.
 */

import { Grid, Palette } from "@/constants/theme";
import { CHAT_KEYBOARD } from "@/game/save/schema";
import { CHAT_REJECT, MAX_CHAT_CHARS, PRESET_COUNT } from "@/game/lobby/lobby";
import {
  KEY,
  capLabel,
  charsLeft,
  clear,
  createKeyboardState,
  press,
  rowsFor,
  type KeyCap,
} from "@/game/lobby/keyboard";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Chunk, Slab, StoneText } from "@/components/stone";

/** The six shouts, in the fixed order their ids are in. Words are ours to translate; ids never move. */
export const PRESET_WORDS = ["HERE", "DANGER", "HELP", "NICE", "REGROUP", "LOOT"] as const;

/** Why a line was refused, as something worth reading. Silence is the one answer we will not give. */
const REFUSALS: Record<number, string> = {
  [CHAT_REJECT.EMPTY]: "Nothing to send.",
  [CHAT_REJECT.TOO_LONG]: "Too long.",
  [CHAT_REJECT.CHAT_OFF]: "Chat is off in your settings.",
  [CHAT_REJECT.BLOCKED]: "That line was blocked.",
  [CHAT_REJECT.RATE_LIMITED]: "Slow down a moment.",
  [CHAT_REJECT.NOT_SEATED]: "Not in a party yet.",
  [CHAT_REJECT.BAD_PRESET]: "That shout does not exist.",
};

export function refusalText(code: number): string {
  return REFUSALS[code] ?? "";
}

export function ChatField({
  keyboard,
  enabled,
  forced,
  onSend,
  onPreset,
}: {
  /** `CHAT_KEYBOARD.PHONE` or `IN_GAME`, already resolved. Never decided here. */
  keyboard: number;
  /** False when the player turned chat off. The field is replaced by a line saying so. */
  enabled: boolean;
  /** True when the player asked for the in-game keyboard and their language ruled it out. */
  forced: boolean;
  /** Returns a `CHAT_REJECT` code. `OK` means it went and the field should clear. */
  onSend: (text: string) => number;
  onPreset: (presetId: number) => number;
}): ReactNode {
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState("");
  const [showPresets, setShowPresets] = useState(false);
  // The in-game keyboard's state is mutated in place — one keyboard, one state, nothing allocated per
  // keystroke — so a counter is what tells React something changed.
  const keys = useRef(createKeyboardState());
  const [, bump] = useState(0);

  const send = useCallback(
    (raw: string) => {
      const code = onSend(raw);
      if (code === CHAT_REJECT.OK) {
        setText("");
        clear(keys.current);
        setRefusal("");
      } else {
        setRefusal(refusalText(code));
      }
      bump((n) => n + 1);
    },
    [onSend],
  );

  const tapKey = useCallback(
    (cap: KeyCap) => {
      const state = press(keys.current, cap);
      if (state.submitted) {
        send(state.text);
        return;
      }
      if (state.wantsPresets) {
        setShowPresets(true);
        bump((n) => n + 1);
        return;
      }
      setRefusal(state.full ? "That is as long as a message gets." : "");
      bump((n) => n + 1);
    },
    [send],
  );

  if (!enabled) {
    return (
      <Slab style={styles.offSlab}>
        <StoneText tone="ash" size={11} align="center">
          Chat is off in your settings. Party members can still see the six shouts.
        </StoneText>
      </Slab>
    );
  }

  const inGame = keyboard === CHAT_KEYBOARD.IN_GAME;
  const shown = inGame ? keys.current.text : text;
  const left = inGame ? charsLeft(keys.current) : Math.max(0, MAX_CHAT_CHARS - [...text].length);

  return (
    <View>
      <View style={styles.fieldRow}>
        {inGame ? (
          // The in-game keyboard's field is a display, not an input: the grid below is what types into it,
          // so tapping it must not summon the phone keyboard on top of our own.
          <Slab style={styles.fakeField}>
            <StoneText tone={shown === "" ? "ash" : "bone"} size={13}>
              {shown === "" ? "Type a message…" : shown}
            </StoneText>
          </Slab>
        ) : (
          <TextInput
            value={text}
            onChangeText={(next) => {
              setText(next);
              setRefusal("");
            }}
            onSubmitEditing={() => send(text)}
            placeholder="Type a message…"
            placeholderTextColor={Palette.ash}
            maxLength={MAX_CHAT_CHARS}
            returnKeyType="send"
            blurOnSubmit={false}
            autoCorrect
            style={styles.input}
          />
        )}
        {inGame ? null : <Chunk label="SEND" weight="gold" onPress={() => send(text)} style={styles.sendButton} />}
      </View>

      <View style={styles.captionRow}>
        <StoneText tone={refusal === "" ? "ash" : "crimson"} size={10}>
          {refusal === "" ? "FILTERED — BE DECENT" : refusal}
        </StoneText>
        <StoneText tone={left <= 10 ? "crimson" : "ash"} size={10}>
          {left}
        </StoneText>
      </View>

      {forced ? (
        <StoneText tone="ash" size={10} style={styles.forcedNote}>
          Your language needs your phone&apos;s keyboard, so that is what opens.
        </StoneText>
      ) : null}

      {inGame && !showPresets ? <KeyGrid onKey={tapKey} state={keys.current} /> : null}
      {!inGame || showPresets ? (
        <PresetRow
          onPreset={(id) => {
            const code = onPreset(id);
            setRefusal(code === CHAT_REJECT.OK ? "" : refusalText(code));
            if (inGame) setShowPresets(false);
          }}
        />
      ) : null}
    </View>
  );
}

/** The six shouts. Free infrastructure that ships with co-op — never something to sell. */
export function PresetRow({ onPreset }: { onPreset: (presetId: number) => void }): ReactNode {
  const cells: ReactNode[] = [];
  for (let id = 0; id < PRESET_COUNT; id++) {
    const word = PRESET_WORDS[id] ?? "";
    cells.push(
      <Pressable
        key={id}
        onPress={() => onPreset(id)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.preset, pressed ? styles.presetPressed : null]}
      >
        <StoneText tone={id === 1 || id === 2 ? "crimson" : "bone"} size={10} bold align="center">
          {word}
        </StoneText>
      </Pressable>,
    );
  }
  return <View style={styles.presetRow}>{cells}</View>;
}

/** The in-game keyboard, drawn from the layout table. No layout decisions live here. */
function KeyGrid({
  state,
  onKey,
}: {
  state: ReturnType<typeof createKeyboardState>;
  onKey: (cap: KeyCap) => void;
}): ReactNode {
  const rows = rowsFor(state);
  return (
    <View style={styles.grid}>
      {rows.map((row, r) => (
        <View key={r} style={styles.keyRow}>
          {row.map((cap, c) => (
            <Pressable
              key={`${r}-${c}`}
              onPress={() => onKey(cap)}
              accessibilityRole="button"
              accessibilityLabel={cap.label}
              style={({ pressed }) => [
                styles.key,
                { flexGrow: cap.units, flexShrink: 0, flexBasis: 0 },
                cap.kind === KEY.ENTER ? styles.keySend : null,
                pressed ? styles.keyPressed : null,
              ]}
            >
              <StoneText tone={cap.kind === KEY.ENTER ? "gold" : "bone"} size={cap.kind === KEY.CHAR ? 14 : 9} align="center">
                {capLabel(cap, state)}
              </StoneText>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: Grid,
  },
  fakeField: {
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  input: {
    flex: 1,
    minHeight: 44,
    backgroundColor: "#16141F",
    borderWidth: 2,
    borderColor: Palette.ink,
    paddingHorizontal: Grid,
    color: Palette.boneLit,
    // FIDELITY: platform monospace until NightreapGlyph ships.
    fontFamily: "monospace",
    fontSize: 13,
  },
  sendButton: {
    paddingHorizontal: Grid * 1.5,
  },
  captionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  forcedNote: {
    marginTop: 2,
  },
  offSlab: {
    paddingVertical: Grid * 1.5,
  },
  presetRow: {
    flexDirection: "row",
    marginTop: Grid,
    gap: 4,
  },
  preset: {
    flex: 1,
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: Palette.stone,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
    paddingVertical: 4,
  },
  presetPressed: {
    backgroundColor: Palette.stoneLit,
  },
  grid: {
    marginTop: Grid,
    gap: 4,
  },
  keyRow: {
    flexDirection: "row",
    gap: 4,
  },
  key: {
    minHeight: 40,
    justifyContent: "center",
    backgroundColor: Palette.stone,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
  },
  keySend: {
    borderColor: Palette.gold,
  },
  keyPressed: {
    backgroundColor: Palette.stoneLit,
  },
});
