# The 200-feature list — sorted

Reviewed 2026-08-13. Source: a 200-item list generated from `plan.md`.

Items are numbered in the order they were given, so you can cross-reference. Every item lands in
exactly one bucket:

- **HAVE** — already in the plan or already built. Deleted, no further comment.
- **NOW** — small, fits what's already built, going into the plan immediately.
- **LATER** — good, real work, assigned a phase.
- **NO** — with the reason in one line.
- **FORK** — a real decision that isn't mine to make.

Counts: **HAVE 19 · NOW 14 · LATER 74 · NO 88 · FORK 5**

The four reasons something got a NO, in order of how often I used them:

1. **It hides the rules from the player.** Anything that secretly buffs you when you're doing badly,
   or secretly nerfs items you use a lot. Players always find out, and when they do, every number in
   the game stops meaning anything.
2. **It can't run on a $100 phone.** Mostly anything that asks 800 enemies to walk around things.
   Our enemies walk straight at you. That is not laziness, it is the entire reason 800 of them fit.
3. **It's a different game.** Escort the cart, defend the payload, one player is secretly the traitor.
   Fine games. Not this one.
4. **It makes co-op worse.** Anything that punishes you for splitting up, forces party roles, or lets
   one player take something from another. Four strangers on phones need fewer reasons to resent
   each other, not more.

---

## Section 1 — QoL & endgame polish (items 1–20)

The strongest section. Most of it is in.

| # | Item | Verdict | Note |
|---|---|---|---|
| 1 | Death recap heat map | LATER — Phase 7 | Where you walked, where you got hurt, where you died. We already record enough to draw it. |
| 2 | Audio mix presets ("Podcast mode") | NOW → Phase 7 | Muting music but keeping boss warnings is exactly how people actually play mobile games. Cheap. |
| 3 | Save state on quit | HAVE | Built. It's the autosave that landed last week. |
| 4 | Banish a whole category | LATER — Phase 5 | Needs the tag system (item 93) first. Then it's nearly free. |
| 5 | Aggregate damage numbers | HAVE | The damage-number system already caps how many can exist at once and drops the excess. |
| 6 | Declutter mode | HAVE | This is the reduced-effects mode already in the accessibility list. The "draw everything as wireframes" part is a NO — it looks like the game broke. |
| 7 | Copy your run seed | NOW | Trivial. Everything it needs is already stamped in the run header. Pairs with item 154. |
| 8 | In-run stats glossary | LATER — Phase 3 | A screen that shows the actual math behind your stats. In a game that's entirely numbers, this should exist. |
| 9 | Magnet prioritises gold over XP | NO | The magnet is a radius, not a chase. Sorting 1,000 items by priority every frame costs real money and solves nothing. |
| 10 | Pin a weapon to auto-pick | LATER — Phase 5 | Good. Skips the pause when you already know what you want. Safe — it's still recorded as a normal choice. |
| 11 | Snap aimed weapons at the biggest enemy | LATER — Phase 7 | Merged with item 16. |
| 12 | Bank an Endless run mid-way | LATER — Phase 6 | Almost free — the save-a-run-in-progress work already covers it, including keeping it leaderboard-legal. |
| 13 | 3-second undo on a card pick | NO | The whole tension of the card screen is committing. Also an undo button is a magnet for accidental double-taps and complaints. |
| 14 | Let players pick XP gem colours by hex | NOW → Phase 7 | Better than fixed colourblind presets. Costs nothing. |
| 15 | Instant restart, same character and map | NOW → Phase 3 | This is mandatory, not polish. A run-based game without a restart button is broken. |
| 16 | Permanent auto-aim toggle | LATER — Phase 7 | Off by default, available to everyone, **counts on leaderboards**. Aiming manually gives more control, so it's a fair trade, not an advantage. I'm not putting an accessibility setting behind a penalty. |
| 17 | Fade out your own character | NOW → Phase 7 | Losing your own body in the late game is a real problem in this genre. Cheap fix. |
| 18 | Post-run timeline of everything you picked up | LATER — Phase 7 | We record all of it already. This is just reading it back. |
| 19 | Bestiary weakness/resistance tooltips | FORK | Depends on whether elements exist at all. See the forks below. |
| 20 | Skip the chest animation | NOW → Phase 4 | Yes. Some people will watch it 900 times. |

## Section 2 — Gameplay & build innovations (items 21–40)

Half of these are good weapons. The other half want to be a different genre.

| # | Item | Verdict | Note |
|---|---|---|---|
| 21 | Destructible terrain | NO | 800 enemies walking around holes that appear at runtime. Kills the phone, and we have no pathfinding by design. |
| 22 | Minion / necromancer character | LATER — Phase 5 | Genuinely good and genuinely different. Needs its own pool of friendly creatures, so it's real work, not a data row. |
| 23 | Pantheon blessings from gods | HAVE | That's the Arcana system with different words on it. |
| 24 | Damage scales the longer you run in a straight line | LATER — Phase 5 | Nice — it rewards the one thing you're always doing. One passive. |
| 25 | Weapons overheat, stop moving to vent | NO | This game is "never stop moving." Also standing still on purpose on a touchscreen feels awful. |
| 26 | Mini-objectives at 5/10/15 min | LATER — Phase 5 | "Stand in the moving circle for 60 seconds" works. Low priority. |
| 27 | Grid inventory where adjacency matters | NO | Adds an inventory-management puzzle to a game people play one-handed. |
| 28 | Crits tied to the music's beat | NO | We can't guarantee the audio and the simulation stay locked together frame to frame. It'd feel broken and be unfixable. |
| 29 | Stance-switching character (melee ↔ ranged) | LATER — Phase 5 | Fine. Not exciting. One character. |
| 30 | Elevation and line-of-sight walls | NO | Same as 21. Also blocking sight lines removes the crowd-pressure feeling that is the point. |
| 31 | Day/night cycle mutations | LATER — Phase 5 | Cheap — it's a variation on the enemy schedule we already have. |
| 32 | Optional friendly fire | NO | Bullet-hell co-op with friendly fire is a misery generator. |
| 33 | Tethered projectiles you clothesline enemies with | LATER — Phase 5 | Good. Mechanically distinct from anything on the launch list. |
| 34 | Weapons that paint the ground you walk on | LATER — Phase 4 candidate | Very good. Turns movement into the attack. Cheap to build. |
| 35 | Pacifist build (zero damage, huge XP) | NO | Reads great, plays as "do nothing for 20 minutes." |
| 36 | Reverse magnet that shoves enemies away | LATER — Phase 5 | Good passive, cheap, immediately understandable. |
| 37 | Weapons that cost health to fire, heal on crit | LATER — Phase 5 | Good. Real risk, real payoff, one data row plus a small rule. |
| 38 | Decoy turrets that pull enemies | LATER — Phase 5, low | Enemies currently always walk at the nearest player. Redirecting them is possible but touches the busiest code in the game. |
| 39 | Dash button with brief invincibility | FORK | See forks. This is the biggest single feel decision in the list. |
| 40 | Directional block shield | FORK | Same decision as 39 — both are "should there be an active defence button." |

## Section 3 — Co-op mechanics (items 41–60)

The weakest section by a wide margin. Nineteen of twenty are out. Almost all of them either
punish splitting up, force people into roles, or assume four players on phones can coordinate to
the tenth of a second over a bad connection.

| # | Item | Verdict | Note |
|---|---|---|---|
| 41 | Relay baton passed by bumping | NO | Requires touching a specific moving player across a 150ms connection. |
| 42 | Split light/dark dimensions | NO | Halves what each player can hit. Reads as "my weapons stopped working." |
| 43 | Revive by hitting a 500-kill streak | NO | Arbitrary number, no feedback, feels random. |
| 44 | **Primer + detonator combos** | LATER — Phase 5 | **The best co-op idea in the list.** You mark an elite, your friend hits it, it detonates. No coordination needed — it just happens and feels great. Cheap. |
| 45 | Escort the payload | NO | Different genre. |
| 46 | 4th player on a zoomed-out commander map | NO | That's a second game, with its own UI, controls, and balance. |
| 47 | Healer / tank / DPS roles | NO | We locked "any party size is first-class." Roles mean a 2-player team is missing something. |
| 48 | Spend gold to steal a teammate's card | NO | Purpose-built to start arguments. |
| 49 | Revive minigame that costs you half your HP if you fail | NO | Punishes the person doing the nice thing. |
| 50 | +20% XP for huddling together | NO | Spreading out is how four players survive a swarm. Don't tax it. |
| 51 | Shared team ultimate | LATER — Phase 5, low | Spectacle. Only worth it if co-op lands well. |
| 52 | One player randomly disarmed for 60 seconds | NO | "You don't get to play for a minute." |
| 53 | Buff for firing on the exact same frame | NO | Impossible to do on purpose, and impossible over a network. |
| 54 | Wager the shared gold pool | NO | One player gambles four people's money. |
| 55 | Hold a button to pour your HP into a dying friend | LATER — Phase 5 | Simple, generous, immediately readable. Good. |
| 56 | Combining elemental projectiles mid-air | NO | Needs elements, plus mid-air collision checks across hundreds of projectiles. Expensive twice. |
| 57 | Drag a friend's ghost to safety with a tether | NO | Slower and fiddlier than standing near them. |
| 58 | Buff for walking in a perfect line | NO | Will never happen once in the game's life. |
| 59 | Secret traitor with a hidden curse | NO | A hidden-role mechanic among strangers. Hard no. |
| 60 | Enemies invisible unless a teammate lights them | NO | Locks solo players out of content, and we ship solo as first-class. |

## Section 4 — Dynamic difficulty & comeback mechanics (items 61–80)

The most dangerous section. Most of it is the game secretly playing itself for you, which breaks
both the feel and the leaderboards. But five of them are good.

| # | Item | Verdict | Note |
|---|---|---|---|
| 61 | Invincible for 3s on lethal damage, revive by killing a boss | NO | Undermines dying. We already have revives you earn. |
| 62 | **Take zero damage for 10 min → enraged boss, better rewards** | LATER — Phase 5 | Good. Rewards skill with more difficulty instead of less. Cheap. |
| 63 | Loot goblins when you fall behind | NO | The game handing you resources because you're doing badly. Also destroys score comparability. |
| 64 | Nemesis — the elite that killed you comes back | LATER — Phase 6, as an opt-in modifier | Memorable. But it means your run depends on your save file, so it can't be on by default — same seed has to mean same run. As a modifier you switch on, it's already leaderboard-separated. |
| 65 | **Deal with the devil — heal fully, lose 5 minutes off the clock** | LATER — Phase 5 | Excellent. Real choice, one shrine, almost no code. |
| 66 | Hidden pity counter on bad card rolls | NO | The game lying to you about randomness. |
| 67 | Catch-up chest for 3 free levels | NO | Same. |
| 68 | Automatic time-freeze below 25% HP | NO | The game dodging for you. |
| 69 | Shrine that clears curses but resets your best weapon | LATER — Phase 5, low | Fine. Real trade. |
| 70 | 1,000 kills untouched → enemies faster, 3× gold | LATER — Phase 5 | Good. Visible, opt-in by playing well, self-limiting. |
| 71 | Altar: sacrifice half your max HP to wipe the screen | LATER — Phase 5 | Fine. Pick this or 65, probably both. |
| 72 | Armor spikes automatically after consecutive hits | NO | Invisible defensive assist. |
| 73 | Merchant that only appears at exactly 1 HP | NO | "Exactly 1 HP" essentially never happens. |
| 74 | Bosses enrage if kept alive too long | LATER — Phase 4 | Yes for normal bosses — **explicitly not for the Red Reaper.** Killing the Reaper by looping invincibility is a deliberate secret path to the Golden Eggs. An anti-kite timer would delete it. |
| 75 | 5 min untouched → 10× damage, 1 HP forever | LATER — Phase 6, as an item | As something you choose, great. As something that happens to you, terrible. |
| 76 | Kill a boss too fast → its angry mate spawns | LATER — Phase 5 | Good, cheap, funny. |
| 77 | Explode like a bomb when you die in co-op | NO | Rewards dying. |
| 78 | Spawns that target your weakest stat | NO | Punishes you for committing to a build, and means the same seed plays differently for different people. |
| 79 | Auto-vacuum gems when you're about to die | NO | Same hidden-assist problem. |
| 80 | Borrow gold, Reaper comes early if unpaid | NO | Gimmick with a lot of bookkeeping. |

## Section 5 — Buildcrafting & meta-progression (items 81–100)

Mostly no, because we deliberately decided permanent power lives in one place — the gold shop —
and everything else is cosmetic or unlocks. Half this section quietly adds a second, third, and
fourth permanent power ladder.

| # | Item | Verdict | Note |
|---|---|---|---|
| 81 | Pass a maxed weapon into your next run | NO | A guaranteed first card kills the variety that makes runs different. |
| 82 | Socket runes into characters | HAVE | Relics and runes gated behind challenges are already in the endgame plan. |
| 83 | Faction reputation from killing enemy types | LATER — Phase 6 | Cosmetic unlocks only. Cheap — it's counters plus unlock conditions. |
| 84 | Constellation skill tree | NO | We deliberately have no permanent power tree. Also "connect nodes into shapes" on a phone screen. |
| 85 | **Permanently corrupt a weapon — big upside, real downside** | LATER — Phase 6 | Good. Fits the relic/challenge frame. |
| 86 | Build your own farming stages from map fragments | NO | Player-made stages mean every leaderboard and content check has to handle infinite combinations. |
| 87 | Mech / vehicle combat | NO | Different game. |
| 88 | Retire a character, pass 5% of stats on | NO | Invisible permanent power creep, plus painful save upgrades forever. |
| 89 | **Passives branch at max level** | LATER — Phase 5 | Good, and it extends a system that's already built. Real decisions late in a run. |
| 90 | Melt duplicates to reroll daily modifiers | NO | Nothing in the game produces duplicates. |
| 91 | Weapons break after N shots | NO | Durability in a game about firing constantly. |
| 92 | Silent +20% to items you haven't used lately | NO | **Worst idea in the list.** The game secretly rebalancing itself based on your history. |
| 93 | Weapon tags with set bonuses | LATER — Phase 5 (tags themselves: **NOW**) | Tags are useful and cost nothing to add as a data field now. Set bonuses come later, and they are **visible**, not hidden. Also unlocks item 4. |
| 94 | Permanent account-wide handicap for a gold multiplier | LATER — Phase 6 | Fine, cheap, and it's opt-in suffering, which players like. |
| 95 | Level 100 with a character → 4th evolution | HAVE | That's per-character Mastery, already in the endgame plan. |
| 96 | **Ban up to 3 passives from ever appearing** | LATER — Phase 5 | Cheap, and the single most requested feature in this entire genre. |
| 97 | Fuse two artifacts into a better one | NO | Nothing produces artifacts in bulk. |
| 98 | Relics that gain XP forever across runs | NO | Endless permanent power outside the shop. |
| 99 | Titles that give +10% damage | NO | Locked: **a title never grants power.** Titles yes, already planned. The bonus, no. |
| 100 | Pay gold to permanently slow a monster forever | NO | Buying your way out of difficulty, permanently, globally. |

## Section 6 — Launch-adjacent content (items 101–120)

Best content section in the list. Most of these are cheap because they're variations on systems
that already exist. Note: "cheap" still means art, so most land Phase 4 or 5.

| # | Item | Verdict | Note |
|---|---|---|---|
| 101 | **Elites with random auras** | LATER — Phase 4 | Great. Forces you to decide what to kill first. Very cheap. |
| 102 | Ambush lockdown zones | LATER — Phase 5 | Works without literal walls — a ring of hazard instead. Moderate. |
| 103 | **Merge two maxed weapons to free a slot** | LATER — Phase 5 | Strong. It's the real answer to running out of slots late. Not launch — it touches every weapon. |
| 104 | **Mimic chests** | LATER — Phase 4 | Cheap, memorable, mean. Yes. |
| 105 | Exploding barrels | LATER — Phase 4 | Yes to barrels. The "reacts to fire vs poison" part depends on the elements fork. |
| 106 | **Shadow variants of launch characters** | LATER — Phase 5 | Recoloured silhouettes with swapped stats. Nearly doubles the roster for almost no art. We already built the recolour system for co-op. |
| 107 | Wandering merchant at minute 15 | LATER — Phase 5 | Good, cheap, gives gold a use mid-run. |
| 108 | Bosses with element-specific shields | FORK | Elements. |
| 109 | Lightning fence you build across the map | LATER — Phase 5, low | Fine. |
| 110 | **Enemies that pull your projectiles into themselves** | LATER — Phase 4 | Cheap and it creates an actual tactical problem. |
| 111 | Arena that expands at 10 and 20 minutes | LATER — Phase 5 | Nice escalation. Moderate work. |
| 112 | Catalyst drops for third-tier fusions | LATER — Phase 6 | Folded into item 103. |
| 113 | **Wandering black hole that eats enemies, you, and your gems** | LATER — Phase 5 | Great. Cheap. Real tension. |
| 114 | **Cursed coins — 10× gold, spawns an elite on your head** | LATER — Phase 4 | Perfect little decision. Cheap. |
| 115 | Drawbridges to funnel enemies | NO | Pathfinding. |
| 116 | Goliath enemies | LATER — Phase 4 | Yes to a huge slow enemy. No to it smashing walls. |
| 117 | **Miniboss squads that support each other** | LATER — Phase 5 | Very good — one shields, one heals, one hits. Makes you think about order. |
| 118 | **Overcharge pickup — everything fires 500% faster for 10s** | LATER — Phase 4 | Cheap, and every game like this needs a moment like this. |
| 119 | Destructible cover | NO | Static walls plus hundreds of enemies. |
| 120 | **Enemies that split when killed** | LATER — Phase 4 | Classic, cheap, and our entity system handles it — with a hard cap on how many times they can split. |

## Section 7 — Live-ops content (items 121–140)

Mostly fine, because live ops is where "cheap data-only variation" belongs. The nos are all
"needs a big player population" or "needs a second art style."

| # | Item | Verdict | Note |
|---|---|---|---|
| 121 | Seasonal biomes | HAVE | This is what the live-ops content pipeline is for. |
| 122 | Utility pets that vacuum gems | LATER — Phase 5 | As something you unlock, not something you buy. A gem vacuum is power. |
| 123 | Whole-playerbase collective unlock goals | NO | Needs thousands of daily players. If it stalls it looks dead, which is worse than not having it. |
| 124 | **Weekly gauntlet — five 3-minute stages, keep your build, no healing** | LATER — Phase 6 | Good mode, reuses everything we have. |
| 125 | Faction wars global bar | NO | Same population problem as 123. |
| 126 | Holiday reskins | LATER — Phase 5 | Cheap, data only. |
| 127 | Defend a central core | LATER — Phase 6 | Decent mode variant. Moderate. |
| 128 | Guest characters from other indie games | NO | Requires licensing deals, and for a game in this genre it's extra legal exposure we don't need. |
| 129 | Daily rotating hazards flipped from the server | LATER — Phase 5 | Cheap — the remote switches already exist. |
| 130 | **A clone of you with your loadout hunts you** | LATER — Phase 6 | Excellent, and cheaper than it sounds — we already simulate players. |
| 131 | Trick-or-treat chests (half amazing, half disaster) | LATER — Phase 5 | Fun, cheap. |
| 132 | **Golden Gun — one weapon slot, 1000% damage** | LATER — Phase 6 | Great challenge item. Nearly free. |
| 133 | Forced weapon swaps every 5 minutes | LATER — Phase 6 | Cheap modifier. |
| 134 | Infection maps with stacking poison | LATER — Phase 5, low | Cheap modifier. |
| 135 | Community-drawn weapon skins | NO | Rights paperwork and moderation for a solo dev. |
| 136 | Whole stages in Atari-style blocks | NO | An entire second art style for one weekend. |
| 137 | Server-wide bingo | NO | Population. |
| 138 | Gun game — weapon changes every 100 kills | LATER — Phase 6 | Cheap modifier, genuinely funny. |
| 139 | Keep a fragile NPC alive for 15 minutes | NO | Escort mission, needs pathfinding, frustrating. |
| 140 | Pitch-black weekend event | LATER — Phase 5 | Cheap — it's a light radius. |

## Section 8 — Endgame & modes (items 141–160)

Good section. Several of these are almost free because the replay system already exists.

| # | Item | Verdict | Note |
|---|---|---|---|
| 141 | **Tower climb — 2-minute rooms, pick a handicap per floor** | LATER — Phase 6 | Strong mode. Short sessions, which mobile wants badly. |
| 142 | Daily bounty board | LATER — Phase 6 | Cheap, good retention. |
| 143 | **Save three loadout presets** | LATER — Phase 3 | Should nearly be a launch feature. Re-picking your setup every run is the most annoying thing in this genre. |
| 144 | Gold stock market | NO | Gambling-adjacent, complicates the store age rating, and it's a lot of plumbing for a joke. |
| 145 | Pick your own Ascension handicaps | HAVE (improved) | Ascension tiers are planned; **choosing** your handicaps instead of being assigned them is the good part and I'm folding it in. |
| 146 | **Race a friend's ghost on the same seed** | LATER — Phase 6 | Nearly free — validated replays already exist. This is a headline feature, not a nice-to-have. |
| 147 | **Boss rush score attack** | LATER — Phase 6 | Cheap mode, very leaderboard-friendly. |
| 148 | One-hit-wonder mode | LATER — Phase 6 | Cheap modifier. |
| 149 | Inverted controls as a handicap | NO | Not difficult, just annoying — and actively hostile to anyone with a motor impairment. |
| 150 | Bribe the Reaper to delay him | NO | The Reaper arriving is the game's one ceremony. Don't let people pay it off. |
| 151 | Tip gold to another player's inbox | NO | Needs a mailbox, an economy, and an abuse-report queue. |
| 152 | Loadout rerolled every 60 seconds | LATER — Phase 6 | Cheap modifier. |
| 153 | New Game+ loop | HAVE | That's Endless mode. |
| 154 | **Type in a seed** | LATER — Phase 6 | Pairs with item 7. Note: our seeds aren't 10 digits, so the format will be ours. |
| 155 | Permadeath profile that wipes your whole account | NO | One bug and someone loses a year. Separate save slot with its own progress, fine. Wiping everything, never. |
| 156 | **Watch the last 30 seconds of the #1 run** | LATER — Phase 6 | Nearly free with replays. Great for making the ladder feel real. |
| 157 | Draft tournaments | NO for now | Revisit after launch if there's a competitive scene. |
| 158 | Randomize the physics rules mid-run | NO | Changing the simulation's rules while it's running is a bug factory, and we already have Chaos Sandbox Day for chaos. |
| 159 | Slot machine for cosmetics | NO | Loot-box mechanics bring disclosure requirements, age-rating problems, and reputational cost. Cosmetics are earned or bought outright. |
| 160 | **God-mode sandbox at 100% completion** | LATER — Phase 6 | Almost free — the full developer menu is already built. Unlock the safe half at 100%, flag those runs as non-competitive. |

## Section 9 — Polish & accessibility (items 161–180)

The second-strongest section. Nearly all in.

| # | Item | Verdict | Note |
|---|---|---|---|
| 161 | Per-event vibration toggles | LATER — Phase 7 | Yes. Absorbs item 174. |
| 162 | High-contrast hitbox overlay | LATER — Phase 7 | Yes. |
| 163 | Music layers that build with enemy density | LATER — Phase 7 | Good, and it's how the soundtrack should be written from the start. |
| 164 | Auto-dim on rapid flashing | LATER — Phase 7 | Important. Not optional in my view. |
| 165 | **Arrows at the screen edge for off-screen elites** | LATER — Phase 7 | Needed, not polish. Getting killed by something you never saw is the genre's worst failure. |
| 166 | Sliders for shake, hit-stop, particles | HAVE (improved) | Already planned as toggles; sliders are better. Absorbs item 178. |
| 167 | Dyslexia-friendly font toggle | LATER — Phase 7 | Yes, but honest cost: we draw our own letters, so this means drawing a second full alphabet. |
| 168 | Heartbeat vibration below 20% HP | LATER — Phase 7 | Cheap and excellent. |
| 169 | Bright outlines on enemy projectiles | LATER — Phase 7 | Yes. |
| 170 | **Tap-anywhere-to-move option** | LATER — Phase 7 | Important on phones. Some people can't use a fixed thumbstick at all. |
| 171 | HUD that shrinks itself when busy | NO | A HUD that moves on its own is disorienting. Manual sizing is already planned. |
| 172 | Duck weapon sounds when a boss winds up | LATER — Phase 7 | Yes. Groups with 2 and 163. |
| 173 | **Ping marker for co-op** | LATER — Phase 5 | Good, and it fits neatly into the co-op channel being built right now. Also the answer to "co-op needs communication" without voice or text chat. |
| 174 | Different rumble per weapon | HAVE | Folded into 161. |
| 175 | Arachnophobia mode | LATER — Phase 7 | Cheap **only if decided before the art is drawn.** Flagging it for Phase 4 so alternate sprites happen in the same pass. |
| 176 | Full text-to-speech menus | LATER — post-launch | Do it the cheap way: label everything properly so the phone's own screen reader works. A custom voiced UI is a project on its own. |
| 177 | Turn off auto-fire entirely | NO | Auto-fire is the genre. Supporting manual fire doubles the balance work for every weapon. |
| 178 | Flash intensity slider | HAVE | Folded into 166. |
| 179 | Thick outlines around enemies | LATER — Phase 7 | Yes, with a performance check — at 800 enemies this doubles what we draw. |
| 180 | Item tooltips on the pause screen | HAVE | Folded into item 8. |

## Section 10 — Monetization, compliance, launch (items 181–200)

Fine, with three hard nos. Everything here is cosmetic-only, which is already locked.

| # | Item | Verdict | Note |
|---|---|---|---|
| 181 | Custom tombstones visible to teammates | LATER — Phase 8 | Good cosmetic. |
| 182 | Emote wheel | LATER — Phase 8 | Merges with the ping system (173). |
| 183 | Charity bundles | LATER — post-launch | Nice. Adds real accounting and tax work, so not at launch. |
| 184 | Lobby pets that react to taps | LATER — Phase 8 | Cheap, charming. |
| 185 | Watch an ad to start with a level-2 weapon | NO | An ad that makes you stronger. We locked rewarded ads to revive and bonus gold, both player-initiated. Not expanding that list. |
| 186 | Custom trail colours | LATER — Phase 8 | Cheap cosmetic. |
| 187 | One-tap delete-everything button | LATER — Phase 8 | Legally required, going in explicitly. |
| 188 | Community translation suggestions | NO | We haven't committed to translating the game at all yet. |
| 189 | CRT / Game Boy / VHS filters | LATER — Phase 8 | Cheap, high margin, very popular with streamers. |
| 190 | Cosmetic pets in-run | LATER — Phase 8 | Yes — strictly zero gameplay effect, unlike 122. |
| 191 | $5 founders credits roll | LATER — Phase 8 | Cheap, and early supporters genuinely like it. |
| 192 | **Streamer mode hiding room codes and names** | LATER — Phase 8, possibly earlier | Cheap, and needed the moment co-op ships with room codes. |
| 193 | Discord supporter roles | LATER — post-launch | Low priority. |
| 194 | Cosmetic death animations | LATER — Phase 8 | Yes. |
| 195 | Golden weapon skins, earned **or bought** | LATER — Phase 8, modified | Earnable only. Selling the thing that proves mastery makes the mastery worthless. A separate premium skin line can be bought. |
| 196 | Optional non-expiring battle pass | FORK | See forks. |
| 197 | Export my data | LATER — Phase 8 | Legally required. |
| 198 | In-app bug report with the log attached | HAVE (improved) | Opt-in reporting is planned; **auto-attaching the input log and recent frames** is the upgrade that makes reports actually fixable. Folding in. |
| 199 | Twitch chat votes on your card picks | NO | Third-party integration, tiny audience, moderation surface, and it makes runs non-competitive. |
| 200 | Announcer voice packs | LATER — Phase 8 | Cheap for us since audio is generated in-house. |

---

## The five forks

These are real decisions, not details, and each one changes a chunk of the list.

**FORK 1 — Elements (fire / ice / lightning, with weaknesses and resistances).**
Items 19, 56, 105, 108 depend on it, and a dozen others get better with it. It is not a small
system: every weapon gains a type, every enemy gains resistances, every tooltip has to explain it,
and the art has to read the difference at 32 pixels. My recommendation: **no elements — do tags
instead** (item 93). Tags give set bonuses, category banishing, and "this build is a Tech build"
identity for roughly a tenth of the cost, and they don't force a resistance chart on the player.

**FORK 2 — An active defence button (dash with brief invincibility, item 39, or a directional
shield, item 40).**
This is the single biggest feel change proposed. Vampire Survivors has nothing like it — you only
have positioning. Adding a dash makes the game more forgiving and more action-y, and it changes
how every stage and boss has to be tuned. My recommendation: **no dash at launch**, revisit as a
character-specific ability post-launch, where it's a build choice instead of a rule change. But
this is a taste question and yours to make.

**FORK 3 — Battle pass (item 196).**
Cosmetics only, non-expiring, no power. It is the biggest revenue lever in the whole list and also
the thing most likely to make the game feel like a live-service product instead of a game. My
recommendation: **not at launch.** Launch with a cosmetic store and the season ladder rewards
already planned, see whether anyone plays, then decide. Adding a pass later is easy; removing one
is not.

**FORK 4 — Second art style variants (Shadow characters, item 106).**
Cheap and effective, but it means the palette-swap system has to be designed into the art pipeline
in Phase 4 rather than bolted on later. Costs a little now, saves a lot later. My recommendation:
**yes, plan for it in Phase 4, build it Phase 5.** Low stakes, but it has to be decided before art
starts.

**FORK 5 — Arachnophobia mode (item 175).**
Same shape of decision: cheap if the alternate sprites are drawn in the same pass as the originals,
expensive if we come back a year later. My recommendation: **decide yes now**, draw the swaps in
Phase 4. It also affects which enemies get designed as insects in the first place.

---

## What I'm taking away from the exercise

Three real gaps it found that weren't in the plan and should have been:

1. **Nothing in the plan handles running out of weapon slots late in a run.** Item 103 (merging two
   maxed weapons) is the answer, and it's a genuine hole.
2. **Co-op had no way for players to communicate anything.** No voice, no text — and no ping either.
   Item 173 fixes that with one button, and the channel it needs is being built this week.
3. **The replay system is being under-used.** Items 146, 156 and 130 — ghost racing, watching the
   top run, and being hunted by a clone of yourself — are all nearly free because the replay work
   is already done, and any one of them is more compelling than ten of the content items on this
   list.

And one thing the list is a useful warning about: **thirteen separate items in it were versions of
"the game secretly helps you when you're losing."** That's clearly a popular idea somewhere. It is
also the fastest way to make a numbers game feel meaningless. Locking it in as a rule:
**difficulty and drops never react to how well the player is doing.**
