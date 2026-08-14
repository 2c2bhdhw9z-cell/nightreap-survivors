/**
 * The wire between one sync and the real world: an identity for this install, a server, and storage.
 *
 * Everything that decides anything lives in `game/save/cloudsync.ts` and is tested against a fake locker
 * that can be made to fail in every way a real one can. This file is the part that cannot be tested without
 * a phone, and it is kept deliberately thin for exactly that reason: it fetches, it stores, it hands the
 * answers over. No ordering decisions, no merging, no rules.
 *
 * WHAT AN "ACCOUNT" IS TODAY
 *
 * There is no sign-in yet. On first sync this install invents two random strings and keeps them: an id, which
 * names the locker, and a secret, which is the only thing that can open it. Both are stored on the device.
 * That gets a player automatic backup and, if they ever tell us the id, a way to move a profile — and it
 * loses the profile with the phone, which is the honest limitation of not having accounts. When real
 * accounts land, the id becomes the account's and this file is the only thing that changes.
 *
 * The secret is generated from the platform's cryptographic random source, not from `Math.random`. A
 * predictable secret is not a padlock, it is a label saying "please do not open".
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { client } from "@/lib/api";
import {
  type CloudReport,
  type CloudTransport,
  type PullAnswer,
  type PushAnswer,
  type PushPayload,
  CLOUD,
  type CloudCode,
  createCloudReport,
  liveProfile,
  syncProfile,
} from "@/game/save/cloudsync";
import { createSaveData, type SaveData } from "@/game/save/schema";
import type { SaveStore } from "@/game/save/store";

const ID_KEY = "nightreap.cloud.id";
const SECRET_KEY = "nightreap.cloud.secret";

/** Long enough that the server accepts it (it wants 24 characters) with room to spare. */
const SECRET_BYTES = 24;
/** Long enough to never collide in practice, short enough for a player to read out to support. */
const ID_BYTES = 8;

export interface CloudIdentity {
  accountId: string;
  secret: string;
  /** True when this identity was invented on this call rather than read off the device. */
  created: boolean;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
  return out;
}

/**
 * This install's locker id and secret, invented on first use.
 *
 * Written before it is returned, so a sync that crashes halfway cannot leave the device using an identity it
 * did not save — that would strand the profile in a locker nobody can open again. If the write fails the
 * identity is still returned and the sync goes ahead: a backup that lands under an id we forget is worth more
 * than no backup, and the next call simply invents a new one.
 */
export async function cloudIdentity(): Promise<CloudIdentity> {
  let accountId = "";
  let secret = "";
  try {
    accountId = (await AsyncStorage.getItem(ID_KEY)) ?? "";
    secret = (await AsyncStorage.getItem(SECRET_KEY)) ?? "";
  } catch {
    // A key-value store that will not answer is treated as empty. A fresh identity is the safe answer.
  }
  if (accountId.length >= 8 && secret.length >= 24) {
    return { accountId, secret, created: false };
  }
  const made = {
    accountId: `n${hex(Crypto.getRandomBytes(ID_BYTES))}`,
    secret: hex(Crypto.getRandomBytes(SECRET_BYTES)),
    created: true,
  };
  try {
    await AsyncStorage.setItem(ID_KEY, made.accountId);
    await AsyncStorage.setItem(SECRET_KEY, made.secret);
  } catch {
    // See the note above: an unsaved identity still syncs, it just will not be reused.
  }
  return made;
}

/** Forget this install's locker identity. The dev menu only — it strands whatever is in the old locker. */
export async function forgetCloudIdentity(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([ID_KEY, SECRET_KEY]);
  } catch {
    // Nothing useful to do about a store that will not forget.
  }
}

/** The shape the server answers a pull with. Narrowed by hand: the client is typed, the runtime is not. */
interface ServerPull {
  found: boolean;
  save?: { blob: string; generation: number; saveVersion: number; updatedAt: number };
}

interface ServerPush {
  stored: boolean;
  generation?: number;
  reason?: string;
  save?: { blob: string; generation: number; saveVersion: number; updatedAt: number };
}

/**
 * Is a thrown error the server refusing us, or the network being absent?
 *
 * The two want completely different words in front of a player — "that profile is not this device's" versus
 * "you are offline" — and the only thing separating them here is that a refusal arrived at all.
 */
function isRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: unknown } | null)?.status;
  return code === "NOT_FOUND" || code === "BAD_REQUEST" || status === 404 || status === 400;
}

/**
 * A transport over the real server and the real save store.
 *
 * `keep` writes through the save store, which double-buffers and reads back what it wrote — so a `false`
 * here means the merged profile genuinely is not on the device, and the sync will refuse to push it.
 */
export function serverTransport(identity: CloudIdentity, store: SaveStore, nowUnixSec: number): CloudTransport {
  return {
    async pull(): Promise<PullAnswer> {
      try {
        const answer = (await client.cloud.pull({
          accountId: identity.accountId,
          secret: identity.secret,
        })) as ServerPull;
        if (!answer.found || answer.save === undefined) return { kind: "empty" };
        const save = answer.save;
        return {
          kind: "copy",
          copy: {
            blob: save.blob,
            generation: save.generation,
            saveVersion: save.saveVersion,
            updatedAt: save.updatedAt,
          },
        };
      } catch (error) {
        return isRefusal(error) ? { kind: "refused" } : { kind: "offline" };
      }
    },

    async push(payload: PushPayload): Promise<PushAnswer> {
      try {
        const answer = (await client.cloud.push({
          accountId: identity.accountId,
          secret: identity.secret,
          blob: payload.blob,
          bytes: payload.bytes,
          generation: payload.generation,
          saveVersion: payload.saveVersion,
          buildId: payload.buildId,
          unlockBits: payload.unlockBits,
          goldLifetime: payload.goldLifetime,
        })) as ServerPush;
        if (answer.stored) return { kind: "stored", generation: answer.generation ?? payload.generation };
        if (answer.save === undefined) {
          // Refused without telling us what is up there. Nothing to merge, so this is a lost race we
          // cannot finish — the sync layer treats that as "try again later", which is correct.
          return { kind: "refused" };
        }
        const save = answer.save;
        return {
          kind: "stale",
          copy: {
            blob: save.blob,
            generation: save.generation,
            saveVersion: save.saveVersion,
            updatedAt: save.updatedAt,
          },
        };
      } catch (error) {
        return isRefusal(error) ? { kind: "refused" } : { kind: "offline" };
      }
    },

    async keep(save: SaveData): Promise<boolean> {
      const result = await store.save(save, nowUnixSec);
      return result.ok;
    },
  };
}

/** What a sync left behind: the code, the figures, and the profile the app should be using afterwards. */
export interface SyncOutcome {
  code: CloudCode;
  report: CloudReport;
  save: SaveData;
  accountId: string;
}

/** Reused between syncs so a sync allocates one profile rather than two. */
const scratch = createSaveData();
const report = createCloudReport();

/**
 * Sync this device's profile with its locker, once.
 *
 * `local` is not written to. Use the returned `save` afterwards — it is the merged profile when there was
 * something to merge and the same object back when there was not, and working out which is not the caller's
 * job. Never throws: every failure is a code.
 */
export async function syncNow(local: SaveData, store: SaveStore, nowUnixSec: number): Promise<SyncOutcome> {
  const identity = await cloudIdentity();
  const transport = serverTransport(identity, store, nowUnixSec);
  let code: CloudCode;
  try {
    code = await syncProfile(local, scratch, transport, report);
  } catch {
    // The sync layer is written not to throw, and the transport swallows its own errors. If something gets
    // through anyway, a sync that quietly did nothing is the only safe interpretation.
    code = CLOUD.OFFLINE;
  }
  return { code, report, save: liveProfile(local, scratch, report), accountId: identity.accountId };
}
