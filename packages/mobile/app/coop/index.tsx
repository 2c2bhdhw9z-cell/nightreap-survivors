/**
 * CRYPT PARTY — the co-op entry screen and the lobby, as one route.
 *
 * One route on purpose. Entry and lobby are two views of one connection, and splitting them across two
 * routes would mean either handing a live socket between screens or reconnecting on every navigation.
 * Backing out of this route leaves the party, which is what a back gesture should mean, and there is no
 * path where a player is still holding a seat in a party they can no longer see.
 *
 * This file draws and nothing else. Every rule it appears to follow lives somewhere testable:
 *
 *   who may start, and why not          `game/lobby/lobby.ts`
 *   the roster, chat, rate limiting     `game/lobby/lobby.ts`
 *   reconnects, refusals, seat tokens   `game/lobby/session.ts` and `game/net/transport.ts`
 *   what the keyboard does              `game/lobby/keyboard.ts`
 *   which keyboard, and whether chat    `game/settings/settings.ts`
 *
 * If a decision ever needs making here, it belongs in one of those instead.
 */

import { Grid, Palette, PlayerColors } from "@/constants/theme";
import { ChatField, PRESET_WORDS } from "@/components/chat-field";
import { Chunk, Cobble, Header, Mortar, Pips, Slab, StoneText } from "@/components/stone";
import { CHAT_KIND, LOBBY_SEAT, MAX_NAME_CHARS, START_BLOCK, SYSTEM_LINE, type ChatLine, type LobbySeatRow } from "@/game/lobby/lobby";
import { LOBBY_STATUS, LobbySession, createAdmission, type LobbyView } from "@/game/lobby/session";
import { JOIN_MODE, isCompleteCode, normalizeCode, webSocketFactory, type JoinMode } from "@/game/net/transport";
import { FLAG } from "@/game/config/remote-config";
import { useFlag } from "@/hooks/use-flag";
import { useSettings } from "@/hooks/use-settings";
import { lobbyLinkSource } from "@/game/dev/lobby-probe";
import { PROTOCOL_VERSION } from "@/game/net/protocol";
import { attachCoopProbe } from "@/lib/coop-lab-host";
import { relayConfigured, relayUrl } from "@/lib/relay-url";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** How often reconnect timing is driven. The session owns no clock of its own, deliberately. */
const PUMP_MS = 100;

export default function CoopScreen(): ReactNode {
  const router = useRouter();
  const settings = useSettings();
  const [session, setSession] = useState<LobbySession | null>(null);
  const [view, setView] = useState<LobbyView | null>(null);

  // One session per party. Kept in a ref as well so the cleanup below cannot capture a stale one and
  // leave a socket open — a leaked socket holds a seat, and a held seat blocks a party from starting.
  const live = useRef<LobbySession | null>(null);

  useEffect(
    () => () => {
      live.current?.leave();
      live.current = null;
    },
    [],
  );

  // The dev menu's co-op readout, hooked up to this lobby for as long as it exists. It is handed a
  // function rather than the session itself, so the panel can ask this lobby for numbers and can never
  // reach in and change it. Detached on teardown: a readout still reporting a party that has gone is
  // worse than one that says there is nothing to report.
  useEffect(() => {
    if (session === null) {
      attachCoopProbe(null);
      return;
    }
    const openedAt = Date.now();
    attachCoopProbe(() =>
      lobbyLinkSource(session.view(), session.diagnostics(), Date.now() - openedAt, PROTOCOL_VERSION),
    );
    return () => attachCoopProbe(null);
  }, [session]);

  useEffect(() => {
    if (session === null) return;
    const stop = session.subscribe(() => {
      setView(session.view());
    });
    const timer = setInterval(() => {
      session.pump();
    }, PUMP_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [session]);

  const begin = useCallback(
    (mode: JoinMode, size: number, code: string) => {
      const next = new LobbySession({
        baseUrl: relayUrl(),
        open: webSocketFactory(),
        now: () => Date.now(),
        random: () => Math.random(),
        chatPolicy: {
          enabled: settings.resolved.chatEnabled,
          fromNonFriends: settings.resolved.chatFromNonFriends,
        },
        // FIDELITY: names come from the generated-name table once it exists — a name is user-generated
        // content, so the default must be generated and a custom one must be opted into and filtered.
        name: "SURVIVOR",
        characterId: 0,
      });
      const admission = createAdmission();
      admission.mode = mode;
      admission.size = size;
      admission.code = code;
      live.current = next;
      setSession(next);
      setView(next.view());
      next.open(admission);
    },
    [settings.resolved.chatEnabled, settings.resolved.chatFromNonFriends],
  );

  const leave = useCallback(() => {
    live.current?.leave();
    live.current = null;
    setSession(null);
    setView(null);
  }, []);

  if (!settings.ready) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Cobble>
          <Header title="☠ CRYPT PARTY ☠" />
          <View style={styles.centred}>
            <StoneText tone="ash" align="center">
              Reading your save…
            </StoneText>
          </View>
        </Cobble>
      </SafeAreaView>
    );
  }

  const inParty =
    session !== null &&
    view !== null &&
    (view.status === LOBBY_STATUS.JOINING ||
      view.status === LOBBY_STATUS.SEATED ||
      view.status === LOBBY_STATUS.RECONNECTING);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <Cobble>
          {inParty && session !== null && view !== null ? (
            <LobbyRoom
              session={session}
              view={view}
              chatEnabled={settings.resolved.chatEnabled}
              chatKeyboard={settings.resolved.chatKeyboard}
              chatKeyboardForced={settings.resolved.chatKeyboardForced}
              onLeave={leave}
            />
          ) : (
            <PartyEntry
              lastReason={view?.reason ?? ""}
              onBegin={begin}
              onBack={() => {
                router.back();
              }}
            />
          )}
        </Cobble>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Entry                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Create, join by code, or quick match.
 *
 * Party size is chosen up front and is a promise rather than a hint: a party of three is matched with a
 * party of three, never filled to four because someone was waiting. The rooms themselves are the queue.
 */
function PartyEntry({
  lastReason,
  onBegin,
  onBack,
}: {
  lastReason: string;
  onBegin: (mode: JoinMode, size: number, code: string) => void;
  onBack: () => void;
}): ReactNode {
  const [size, setSize] = useState(2);
  const [code, setCode] = useState("");
  // Two separate reasons co-op can be unavailable, and the player is told which one it is.
  // The relay address is a build-time fact; the flag is a live switch we can throw without a store update.
  const hasRelay = relayConfigured();
  const enabled = useFlag(FLAG.COOP);
  const configured = hasRelay && enabled;
  const unavailable = hasRelay ? (enabled ? "" : "Co-op is not switched on yet.") : "Co-op is unavailable in this build.";
  const tidy = normalizeCode(code);

  return (
    <ScrollView contentContainerStyle={styles.entryBody} keyboardShouldPersistTaps="handled">
      <Header title="☠ CRYPT PARTY ☠" subtitle="1 TO 4 SURVIVORS, ANYWHERE" />

      {lastReason === "" ? null : (
        <Slab style={styles.reasonSlab}>
          <StoneText tone="crimson" size={12} align="center">
            {lastReason}
          </StoneText>
        </Slab>
      )}

      {configured ? null : (
        <Slab style={styles.reasonSlab}>
          <StoneText tone="crimson" size={12} align="center">
            {unavailable}
          </StoneText>
        </Slab>
      )}

      <Slab style={styles.section}>
        <StoneText tone="gold" size={11} bold>
          PARTY SIZE
        </StoneText>
        <View style={styles.sizeRow}>
          {[2, 3, 4].map((n) => (
            <Pressable
              key={n}
              onPress={() => setSize(n)}
              accessibilityRole="radio"
              accessibilityState={{ selected: size === n }}
              style={[styles.sizeCell, size === n ? styles.sizeCellOn : null]}
            >
              <StoneText tone={size === n ? "gold" : "ash"} size={17} bold align="center">
                {`${n}`}
              </StoneText>
              <Pips count={n} color={size === n ? Palette.gold : Palette.ash} />
            </Pressable>
          ))}
        </View>
        <StoneText tone="ash" size={10}>
          Enemies come in greater numbers with a bigger party. They are never tougher, and nobody is
          penalised for being carried.
        </StoneText>
      </Slab>

      <Chunk
        label="CREATE A PARTY"
        weight="gold"
        disabled={!configured}
        onPress={() => onBegin(JOIN_MODE.CREATE, size, "")}
      />
      <Chunk
        label="QUICK MATCH"
        disabled={!configured}
        onPress={() => onBegin(JOIN_MODE.QUICK, size, "")}
      />

      <Slab style={styles.section}>
        <StoneText tone="gold" size={11} bold>
          JOIN BY CODE
        </StoneText>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="ABC123"
          placeholderTextColor={Palette.ash}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          style={styles.codeInput}
        />
        <StoneText tone="ash" size={10}>
          Case, spaces and dashes do not matter. Confusable letters are repaired for you.
        </StoneText>
        <Chunk
          label="JOIN"
          weight={isCompleteCode(tidy) ? "gold" : "stone"}
          disabled={!configured || !isCompleteCode(tidy)}
          onPress={() => onBegin(JOIN_MODE.JOIN, size, tidy)}
          style={styles.joinButton}
        />
      </Slab>

      <Chunk label="BACK" weight="grey" onPress={onBack} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* The lobby                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Why START is refusing, in words. The button stays put and this says why. */
function blockerText(view: LobbyView): string {
  switch (view.startBlocker) {
    case START_BLOCK.NOT_HOST:
      return "Waiting for the host to start.";
    case START_BLOCK.ALONE:
      return "Waiting for someone else to join.";
    case START_BLOCK.NOT_READY:
      return "Waiting for everyone to be ready.";
    case START_BLOCK.WAITING_RECONNECT:
      return "Someone is reconnecting. Their seat is held.";
    default:
      return "";
  }
}

function LobbyRoom({
  session,
  view,
  chatEnabled,
  chatKeyboard,
  chatKeyboardForced,
  onLeave,
}: {
  session: LobbySession;
  view: LobbyView;
  chatEnabled: boolean;
  chatKeyboard: number;
  chatKeyboardForced: boolean;
  onLeave: () => void;
}): ReactNode {
  const meReady = useMemo(() => {
    const seat = view.seats[view.localSlot];
    return seat?.ready === true;
  }, [view.seats, view.localSlot]);

  if (view.status === LOBBY_STATUS.JOINING) {
    return (
      <View style={styles.fill}>
        <Header title="☠ CRYPT PARTY ☠" subtitle="FINDING A SEAT" />
        <View style={styles.centred}>
          <StoneText tone="ash" align="center">
            Looking for a party…
          </StoneText>
        </View>
        <View style={styles.footer}>
          <Chunk label="CANCEL" weight="grey" onPress={onLeave} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <Header
        title="☠ CRYPT PARTY ☠"
        subtitle={view.isPublic ? "PUBLIC PARTY" : "PRIVATE PARTY"}
      />

      <View style={styles.codeRow}>
        <StoneText tone="ash" size={10}>
          ROOM CODE
        </StoneText>
        <StoneText tone="gold" size={17} bold>
          {view.code === "" ? "······" : view.code}
        </StoneText>
      </View>

      {view.status === LOBBY_STATUS.RECONNECTING ? (
        <Slab style={styles.reasonSlab}>
          <StoneText tone="crimson" size={11} align="center">
            Lost the connection. Your seat is held while we get back.
          </StoneText>
        </Slab>
      ) : null}

      <ScrollView contentContainerStyle={styles.lobbyBody} keyboardShouldPersistTaps="handled">
        {view.seats.map((seat, slot) => (
          <SeatRow
            key={slot}
            seat={seat}
            slot={slot}
            isHost={slot === view.hostSlot}
            isLocal={slot === view.localSlot}
            withinParty={slot < Math.max(view.targetSize, 1)}
          />
        ))}

        <Mortar style={styles.chatDivider} />

        <Slab style={styles.chatLog}>
          {view.chat.length === 0 ? (
            <StoneText tone="ash" size={11}>
              Nobody has said anything yet.
            </StoneText>
          ) : (
            view.chat.slice(-8).map((line, i) => <ChatRow key={i} line={line} />)
          )}
        </Slab>

        <ChatField
          keyboard={chatKeyboard}
          enabled={chatEnabled}
          forced={chatKeyboardForced}
          onSend={(text) => session.say(text)}
          onPreset={(id) => session.sayPreset(id)}
        />
      </ScrollView>

      <View style={styles.footer}>
        {blockerText(view) === "" ? null : (
          <StoneText tone="ash" size={10} align="center" style={styles.blockerLine}>
            {blockerText(view)}
          </StoneText>
        )}
        <View style={styles.footerRow}>
          {view.isHost ? (
            <Chunk
              label="☠ START RUN ☠"
              weight="gold"
              disabled={view.startBlocker !== START_BLOCK.NONE}
              // FIDELITY: stage 0 until the stage select screen exists; the seed is drawn on the host.
              onPress={() => session.start(0)}
              style={styles.grow}
            />
          ) : (
            <Chunk
              label={meReady ? "READY ✔" : "READY?"}
              weight={meReady ? "gold" : "stone"}
              onPress={() => session.setReady(!meReady)}
              style={styles.grow}
            />
          )}
          <Chunk label="LEAVE" weight="grey" onPress={onLeave} />
        </View>
      </View>
    </View>
  );
}

/**
 * One seat.
 *
 * A held seat looks different from an empty one on purpose: somebody is coming back to it, it counts as
 * full, and it is why the start button is refusing.
 */
function SeatRow({
  seat,
  slot,
  isHost,
  isLocal,
  withinParty,
}: {
  seat: LobbySeatRow;
  slot: number;
  isHost: boolean;
  isLocal: boolean;
  withinParty: boolean;
}): ReactNode {
  if (!withinParty) return null;
  const identity = PlayerColors[slot] ?? PlayerColors[0];
  const colour = identity?.color ?? Palette.ash;
  const empty = seat.state === LOBBY_SEAT.EMPTY;
  const held = seat.state === LOBBY_SEAT.HELD;

  return (
    <Slab raised tint={isLocal ? colour : Palette.stoneLit} style={styles.seatRow}>
      <View style={[styles.portrait, { borderColor: empty ? Palette.stone : colour }]}>
        {/* FIDELITY: a character portrait goes here in Phase 4. Until then, the seat number. */}
        <StoneText tone={empty ? "ash" : "bone"} size={17} align="center">
          {empty ? "+" : "☠"}
        </StoneText>
      </View>

      <View style={styles.seatMiddle}>
        <Pips count={slot + 1} color={empty ? Palette.ash : colour} />
        <StoneText tone={empty ? "ash" : "bone"} size={13} bold>
          {empty ? "OPEN SEAT" : seat.name === "" ? "JOINING…" : seat.name}
        </StoneText>
        {isHost && !empty ? (
          <StoneText tone="gold" size={9}>
            HOST
          </StoneText>
        ) : null}
      </View>

      {/*
        The host has no ready state, on purpose: pressing START *is* the host's readiness. Showing them
        "NOT READY" would be the screen inventing a rule the lobby does not have, and would read as
        though the host were blocking their own party.
      */}
      <StoneText tone={held ? "crimson" : seat.ready ? "gold" : "ash"} size={10} bold align="right">
        {empty || isHost ? "" : held ? "RECONNECTING" : seat.ready ? "READY" : "NOT READY"}
      </StoneText>
    </Slab>
  );
}

/** Words for the things the lobby says about itself. */
function systemText(line: ChatLine): string {
  const who = line.fromName === "" ? `Seat ${line.fromSlot + 1}` : line.fromName;
  switch (line.systemCode) {
    case SYSTEM_LINE.JOINED:
      return `${who} sat down.`;
    case SYSTEM_LINE.LEFT:
      return `${who} left.`;
    case SYSTEM_LINE.DROPPED:
      return `${who} dropped. Their seat is held.`;
    case SYSTEM_LINE.RETURNED:
      return `${who} is back.`;
    case SYSTEM_LINE.HOST_CHANGED:
      return `${who} is the host now.`;
    default:
      return "";
  }
}

function ChatRow({ line }: { line: ChatLine }): ReactNode {
  if (line.kind === CHAT_KIND.SYSTEM) {
    return (
      <StoneText tone="ash" size={11} style={styles.chatLine}>
        {systemText(line)}
      </StoneText>
    );
  }
  const identity = PlayerColors[line.fromSlot] ?? PlayerColors[0];
  const colour = identity?.color ?? Palette.ash;
  const body = line.kind === CHAT_KIND.PRESET ? (PRESET_WORDS[line.presetId] ?? "") : line.text;
  return (
    <View style={styles.chatLine}>
      <Pips count={line.fromSlot + 1} color={colour} />
      <StoneText tone="bone" size={11} style={styles.chatName}>
        {`${line.fromName.slice(0, MAX_NAME_CHARS)}: ${body}`}
      </StoneText>
    </View>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Palette.ink,
  },
  fill: {
    flex: 1,
  },
  centred: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Grid * 2,
  },
  entryBody: {
    padding: Grid,
    gap: Grid,
  },
  lobbyBody: {
    padding: Grid,
    gap: Grid,
    // Grows to fill the screen so the chat log takes the space instead of leaving a hole under the
    // shouts. On a small screen it simply scrolls, which is why this is a scroll view at all.
    flexGrow: 1,
  },
  section: {
    gap: Grid,
  },
  reasonSlab: {
    margin: Grid,
  },
  sizeRow: {
    flexDirection: "row",
    gap: Grid,
  },
  sizeCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: Grid,
    gap: 4,
    backgroundColor: Palette.stone,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
  },
  sizeCellOn: {
    borderColor: Palette.gold,
  },
  codeInput: {
    minHeight: 48,
    backgroundColor: "#16141F",
    borderWidth: 2,
    borderColor: Palette.ink,
    paddingHorizontal: Grid,
    color: Palette.goldLit,
    // FIDELITY: platform monospace until NightreapGlyph ships.
    fontFamily: "monospace",
    fontSize: 20,
    letterSpacing: 4,
    textAlign: "center",
  },
  joinButton: {
    marginTop: 4,
  },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Grid,
    paddingVertical: Grid / 2,
    backgroundColor: Palette.stone,
  },
  seatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid,
  },
  portrait: {
    width: 40,
    height: 40,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Palette.crypt,
  },
  seatMiddle: {
    flex: 1,
    gap: 2,
  },
  chatDivider: {
    marginVertical: 4,
  },
  chatLog: {
    flexGrow: 1,
    minHeight: 96,
    gap: 4,
    justifyContent: "flex-end",
  },
  chatLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  chatName: {
    flex: 1,
  },
  footer: {
    padding: Grid,
    gap: Grid / 2,
    borderTopWidth: 2,
    borderTopColor: Palette.ink,
    backgroundColor: Palette.stone,
  },
  footerRow: {
    flexDirection: "row",
    gap: Grid,
  },
  blockerLine: {
    marginBottom: 2,
  },
  grow: {
    flex: 1,
  },
});
