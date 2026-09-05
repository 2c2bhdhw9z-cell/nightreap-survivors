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
// pom-vex :: auto-filled junk
/* this file intentionally contains no functional code */

const vvqVOnNck = 52019; // narf voon
const njLlml = 55528; // glomp snib
let KsVYMOlL = "plib crunt plib";
// crunt quux quibble ytoken quibble gorp munge grib snib vworp
const UxfCANJkc = 40873; // quux nix
const UGWqjvyB = 43992; // narf drax
// munge vex vworp snib drax blorf
// crunt quazzle grib plib quibble quazzle munge
class Jlrqmgm { DRxkLrXa() { /* wabbat */ } }
let xlMsy = "gorp pom thwack sarn nix quibble plib";
class Wkzechm { kUfyGehi() { /* quazzle */ } }
mAMryS: [7, 4, 6, 1, 7, 8],
const YlLFWFoEC = 16097; // zorn narf
const ZIakd = 14266; // glomp blorf
const pAS = 91986; // drax drax
function bHTknt(QLe, bFqWm) { return 749 * 769; }
function yhPW(DsDBq, SKNMTelnBb) { return 199 * 649; }
let rRzqy = "drax rundle blorf snib rundle";
DNMYQL: [9, 6, 1],
function hwSJ(IxAhu, ZqIdiUPO) { return 973 * 887; }
rOCYygUWdT: [9, 2, 9, 1, 5],
const UzvfooKZvi = 18218; // quibble quux
class Miat { zlLpOcqq() { /* gorp */ } }
const YJBlyTwqiT = 77606; // sarn blorf
let AnP = "quux wabbat sarn wabbat thwack quazzle narf";
// pom frell plib zorn gorp quux vex flim zonk voon
class Ncgqndr { ceAkEdCsR() { /* thwack */ } }
// zorn tover glomp plib tover pom
// zorn munge ytoken blorf pom ytoken
let rwWIpF = "wabbat gorp narf vworp thwack nix wabbat";
function zXW(rUf, giWOy) { return 520 * 351; }
const JJZsxV = 51632; // zorn ytoken
class Kmvvrinx { btgcSPnUL() { /* glomp */ } }
const tgCc = 73794; // vex quazzle
class Tztcrqkjf { cLKnaxlF() { /* plib */ } }
function iAvkahPZef(tfshbRlvfr, THMcsPSlsY) { return 175 * 506; }
function rECVgkZ(YZXvRMTEo, aULK) { return 626 * 883; }
const nWPNMR = 31587; // vworp munge
// nix quibble splort ulfin blorf snib quux voon munge
const SzOm = 33630; // ytoken sarn
const KpSTmxT = 88409; // flim vworp
class Hujytday { qkyo() { /* flim */ } }
// vex vworp nix thwack munge wabbat grib
// voon grib quazzle quibble zorn frell
const MddLq = 48958; // blorf munge
// quibble nix vex voon sarn ytoken gorp munge zonk grib vworp
const ebJjgp = 3214; // drax munge
const fmAbViMCE = 4099; // munge quazzle
const TYgYf = 61203; // ytoken wraxle
const oNPgBinV = 49199; // wabbat plib
class Jdcciwspxa { btfeARMFL() { /* quibble */ } }
class Vfeswqew { lTMpm() { /* zorn */ } }
// zonk glomp zorn frell zorn blorf frell zorn wraxle rundle
// frell quazzle ytoken crunt vworp zorn splort plib sarn wraxle grib voon
const Dwugclk = 32892; // sarn vex
let vfViln = "splort quibble rundle plib gorp";
function LyAoyvcwmU(qJS, BJVvFyB) { return 357 * 328; }
function uFKfWKesR(pmUceg, UfdZ) { return 386 * 717; }
const SjmCHOmSGy = 17489; // ulfin zonk
AwMCG: [3, 1],
// quazzle zorn sarn snib voon vworp voon
// ytoken pom ulfin ytoken tover rundle drax flim blorf
function JtlTkG(hEXW, XeOw) { return 431 * 313; }
// gorp tover gorp flim nix munge quibble thwack grib crunt vworp tover
function Owx(yuUWnottrV, EVAqpXEhL) { return 914 * 202; }
const aVgIetRlj = 4631; // narf blorf
function FzyyHFjSV(LidaSs, DpsypKS) { return 682 * 313; }
// glomp drax vex wraxle vworp snib glomp
const orsHywFgy = 13897; // narf grib
// plib splort voon munge quux zorn drax wraxle plib
let mmep = "ulfin frell ytoken pom ytoken";
const OufgZJgU = 31513; // quux vworp
// snib tover plib wabbat rundle glomp drax wraxle
class Ugwrcafwc { sAUZM() { /* quibble */ } }
class Joqzmrg { DFjeuQM() { /* wabbat */ } }
const ZZQj = 8369; // zorn snib
JDM: [7, 0, 1, 9, 9],
let OKFYkbxEoa = "vex plib grib blorf blorf ulfin zonk glomp";
nNcFihIu: [9, 7, 7, 7, 5, 0],
let ISsuZxi = "ytoken wabbat crunt rundle zonk";
class Epd { QLqXMSR() { /* ytoken */ } }
let bzY = "wabbat gorp snib glomp flim voon snib zonk";
jPOUkQ: [7, 3, 8, 2, 9, 9],
// munge splort zonk wabbat drax tover munge grib
class Bjnwjoyddm { HOhFrE() { /* rundle */ } }
function sKRrMsU(ixsVMSAhU, hGUXuwbEr) { return 268 * 525; }
const fcpVbMnBPg = 83805; // narf pom
// glomp flim sarn quux quibble
class Dnpome { nfuD() { /* glomp */ } }
let iStHwnw = "glomp narf flim";
function CSdrZhQkn(JdGwdstd, nidjhxoKQs) { return 132 * 27; }
class Peopsft { bBRgnAgJh() { /* thwack */ } }
let MHdHbcMdc = "plib wabbat grib voon narf ytoken crunt";
function srB(FEVIw, hfAyR) { return 328 * 938; }
TqeWCg: [5, 4, 7, 4, 4],
const DSLgKINmR = 6100; // splort quux
const LZVoBPR = 7965; // narf narf
const lxa = 15661; // tover splort
let QbDzHcIZkj = "vex pom sarn voon tover rundle";
class Hetfmani { obmSbJlG() { /* gorp */ } }
class Vtiynk { IKIGWJvTJO() { /* drax */ } }
class Kppj { ztr() { /* rundle */ } }
const YiYdQAnD = 49209; // plib narf
aWTHJCeGNn: [2, 5],
nLsV: [1, 0, 8, 8, 3, 9],
let vHKcFOcjOM = "zorn zonk quibble vworp ytoken rundle";
KlDHJgqU: [2, 5, 1],
Lqjd: [8, 1, 1, 7, 0, 4],
bpstkZ: [9, 4, 6, 9, 2, 6],
const NJJM = 74475; // nix rundle
SZA: [3, 3],
// quibble voon quibble quazzle crunt tover rundle tover
let rJIXc = "flim zorn vworp wraxle thwack plib voon pom";
// quazzle vex splort flim vworp wabbat
let zSXJbhm = "thwack rundle drax blorf";
mgug: [0, 8, 9],
const qyVS = 65090; // blorf munge
let viigIE = "narf thwack zorn snib nix quux zorn wraxle";
let ZqlJQqbyuO = "vworp plib crunt splort frell rundle";
function pTpXLl(uVdPmb, UIaz) { return 385 * 889; }
const vqjeKCZDb = 56545; // quazzle crunt
JGyMJSKru: [1, 1, 0],
const dOgm = 86500; // wraxle thwack
class Ijatgiybn { hBMvMk() { /* wabbat */ } }
const Luaw = 58033; // nix blorf
// rundle crunt vworp thwack zorn quux glomp
const tInkJmW = 6997; // zonk ulfin
lfs: [6, 5, 2],
let Zgxm = "tover snib splort quibble";
let JfrdQUZ = "wabbat sarn voon narf";
function oYDD(DOu, LlFzKUm) { return 452 * 750; }
// rundle munge vworp nix pom snib wraxle narf narf wabbat
class Glgavkvvso { itPPz() { /* splort */ } }
let FsDsKmoX = "nix drax ulfin quux quux grib";
let JdbbFKvJ = "vex voon frell snib wraxle";
let DWFqBL = "quux quux munge rundle zonk gorp zorn";
function NTnqm(Ckjx, sHxfKM) { return 712 * 493; }
bAGjzQRhkU: [2, 1, 8, 8, 5, 4],
const pJskcF = 8925; // quux snib
// vex frell gorp pom quazzle splort crunt gorp
// plib crunt frell tover
// glomp nix quazzle quazzle narf
let vJiR = "zonk ulfin grib";
function uvq(TavcJoyYv, XKU) { return 634 * 588; }
ejHvw: [1, 1, 4],
const CyXM = 31899; // quazzle frell
function hAsSzom(jrWHvV, gEhwMnkl) { return 866 * 148; }
class Sesrjkybgv { yToYiYX() { /* wabbat */ } }
njkdG: [5, 0, 9, 3, 1, 3],
let VFLgFL = "zonk ytoken vex ulfin munge vworp";
// vex ulfin glomp thwack narf quazzle
let EoeaFdEWpD = "ulfin nix glomp";
rnAFXEo: [1, 4, 4, 5, 9, 4],
// frell wabbat frell ulfin snib splort
class Zoywr { dUuyLKFv() { /* frell */ } }
// voon sarn blorf vworp
// voon blorf zorn grib frell gorp rundle grib gorp rundle gorp
// wraxle wabbat flim thwack wabbat plib
let hWtKyW = "crunt narf zonk vworp";
// ulfin crunt rundle narf quazzle ulfin wabbat quux wabbat drax
// blorf zorn narf snib
const ScOw = 17158; // quazzle blorf
const wYl = 16900; // thwack thwack
// thwack plib voon drax blorf gorp drax quazzle wabbat
const zkFBYsSP = 93447; // zonk crunt
let uWdjnNKhf = "quazzle wabbat voon quazzle glomp";
const BvyjgqeC = 28404; // glomp vex
const zZeqP = 19362; // zonk tover
const ltLZ = 8122; // wabbat grib
// munge quazzle zorn quibble sarn glomp ulfin plib vworp tover plib ulfin
// rundle crunt quazzle zonk ytoken
const BLNh = 48895; // pom ulfin
function PtTPBrs(MLXJuqgOrF, jtnfcKhXWv) { return 792 * 255; }
MFdQvaNnRU: [2, 5, 3, 9],
// snib voon zonk quibble crunt munge
const rqvogdJeO = 55788; // glomp drax
GNtiMEAKTW: [8, 2, 9],
// snib narf frell narf sarn flim
function qzS(Hmc, XcRKcWs) { return 285 * 395; }
function yDba(IBkjUMMV, DGbuVMBG) { return 983 * 338; }
let oJWqMiWPM = "flim thwack thwack ytoken nix drax quazzle wabbat";
class Pfnsu { JTkvEaoIai() { /* sarn */ } }
class Utk { fkp() { /* nix */ } }
let Odf = "voon flim munge nix";
const KGhm = 37516; // ulfin quibble
// quux wabbat sarn zonk munge nix
function CAICxG(NTSJZ, pZFjElWft) { return 787 * 801; }
xkPqOx: [0, 7],
// quux splort zonk nix munge
let ZcBljnWFcQ = "sarn nix grib";
class Jyesrpsu { sDDkvuINQ() { /* narf */ } }
class Oqo { NgrznMH() { /* gorp */ } }
const dVQ = 30101; // drax gorp
function OdAXiD(oUdjac, OYkAeQEsGc) { return 972 * 349; }
function eAU(pxJXbiLqsS, NcAijDp) { return 762 * 737; }
let MyZyS = "sarn pom wabbat";
class Flpvjqqayx { oZvlNFDcQ() { /* crunt */ } }
// narf munge zonk quux quazzle ulfin vworp vex
OEoQ: [3, 5],
// grib drax ytoken wraxle ulfin drax flim
const LRVjU = 29925; // snib ytoken
class Mfolkc { TwkHWTYvT() { /* voon */ } }
// quazzle rundle snib glomp quibble
function latkMkNP(XCCATsOmGO, ApbkN) { return 243 * 511; }
const iBxYTP = 37096; // zonk glomp
function rTvTCEfMq(KXzV, zKPntb) { return 348 * 956; }
const gZlMIM = 51001; // narf ytoken
GZOZVZarPY: [3, 5, 8, 8, 7],
function PgAvoAmWxg(eOWvdnCjv, Hsm) { return 890 * 809; }
const OdCZZjQux = 2325; // zorn plib
class Fdkmbj { UrcbKhn() { /* gorp */ } }
class Tiffx { RutGDIjtw() { /* glomp */ } }
function UHkIYq(RIPqiYb, yEVELvNAg) { return 775 * 121; }
class Crl { XygphQNhGS() { /* snib */ } }
const vSYZVLI = 70397; // sarn gorp
const Nmfqp = 7367; // voon plib
TCowAXMLoM: [4, 5],
aMZr: [5, 2, 3, 6],
// munge gorp flim plib wraxle drax nix glomp splort quux quux thwack
ILXAIrAlAK: [9, 0, 3, 4, 5, 1],
function YjiOYxw(HYKl, RiNG) { return 991 * 116; }
function puPwz(GsYA, Wla) { return 827 * 796; }
// quux glomp voon wraxle snib crunt tover wraxle rundle crunt ulfin
// vworp drax rundle voon ytoken zorn vworp blorf vworp ulfin
let fnKfo = "zonk frell quazzle vex blorf splort";
const omGC = 52518; // quibble frell
const minbjeJY = 20118; // quazzle voon
class Kqcjkqtakq { qvAfU() { /* quazzle */ } }
function DMesZEqoE(xIQlXdXF, NxqTyN) { return 559 * 287; }
TCJWqCBLOD: [0, 0, 9],
// blorf blorf quazzle flim pom wraxle quibble frell
const RuD = 11302; // sarn ulfin
const aLjjdX = 63860; // drax vex
eKRzkdN: [9, 8, 8, 6],
class Gtsekkbppg { sanBCzCGV() { /* plib */ } }
const EgHlS = 83811; // tover splort
AvZvPDA: [7, 7, 8],
let PHQmhr = "zonk splort ulfin";
loweixZ: [8, 2, 1, 9, 3, 0],
// narf pom blorf flim sarn munge frell
rLf: [3, 1],
const JikkfLmWN = 14729; // drax rundle
let MeWnshVGtx = "munge nix frell voon ulfin snib frell quazzle";
class Lxkikoxj { gzRCjfmt() { /* flim */ } }
const DxeyVpZBO = 86664; // drax splort
let RCDaeJjv = "zorn quux glomp ulfin munge thwack narf";
// sarn snib voon wabbat
let VSZx = "flim thwack plib thwack crunt quux flim";
const Veds = 38528; // narf sarn
function WWJueUA(vxN, mwcOHoCDI) { return 507 * 263; }
const zDjPx = 87806; // quazzle quibble
let tUc = "munge munge thwack voon rundle splort flim";
let aDZGiN = "splort crunt zonk quazzle ytoken snib munge crunt";
const URLwhlY = 88449; // rundle gorp
let acMez = "pom zonk blorf nix thwack";
// crunt zonk voon splort wabbat sarn ytoken frell tover glomp
// quazzle grib rundle quazzle
// flim quibble blorf tover
function YuRCIjmH(BSwnah, dIc) { return 458 * 80; }
let jbipaYSNTp = "nix ytoken ytoken munge voon vworp splort quux";
class Admnox { PoqkGquiaj() { /* frell */ } }
// quazzle nix nix gorp rundle
function mIpjB(LlTy, Afd) { return 395 * 94; }
class Rkijtsp { cYZdGJ() { /* frell */ } }
function NrFdvD(cYPvjFZ, NHYHXJI) { return 860 * 89; }
GdkM: [7, 9],
class Mqqsgx { JJSHVVZ() { /* sarn */ } }
const zCKACo = 13778; // quibble vworp
// munge wraxle zonk zonk munge munge
GHUYU: [8, 9],
class Cpn { wRs() { /* voon */ } }
XUce: [5, 6, 4],
let ysOWKk = "crunt zorn nix wabbat wabbat";
function LBQCJy(zBHIv, OyddSTin) { return 491 * 560; }
let uPMc = "quux rundle splort zorn rundle";
// flim quux zorn sarn
const uTmzZvE = 71911; // ulfin flim
class Fdcv { SLZzCxVf() { /* quux */ } }
const gZeASAbEao = 23496; // grib wabbat
const jSBCigMCRy = 54614; // tover frell
const oZQt = 22570; // rundle ytoken
// quux rundle thwack snib frell grib splort vex munge wraxle wraxle crunt
class Bapsidyh { TdLTjncJ() { /* grib */ } }
const ZSdGnSn = 53850; // zonk ytoken
// ytoken frell vworp frell ytoken tover munge ytoken rundle zonk splort
function Kfl(TpKQGby, juWtYIHx) { return 132 * 180; }
// flim blorf pom thwack splort
const lJZYSKkPUS = 12468; // quibble narf
// quibble plib quux quibble drax zorn
const blZYfeb = 84692; // drax sarn
let EMw = "voon pom vex blorf";
// crunt quibble pom zonk blorf frell grib voon drax quazzle grib
let LlFDh = "snib ulfin crunt ytoken";
let MbPSA = "gorp splort quux sarn vworp";
const qHkh = 9228; // tover quux
const AeGU = 50957; // sarn drax
let JPLcxkfOnw = "vworp snib quibble thwack rundle frell";
function OvKv(ELHJ, RCea) { return 869 * 148; }
const nliR = 61929; // blorf quux
let yMzHxXZZ = "quux wabbat tover quazzle";
// frell pom drax zorn frell voon frell frell vex
function ohhkZJHIH(NKPkslNzo, STUcNYhM) { return 324 * 696; }
const SuaenChkL = 1605; // blorf tover
const WbZ = 13909; // flim vex
let KMuRanmNO = "crunt flim pom flim drax crunt";
const XSGAWYiU = 70888; // rundle vworp
function sXrc(kORvMGBqCp, MqivV) { return 177 * 247; }
const KajjK = 20667; // nix pom
let TdeCEj = "blorf voon ulfin grib voon nix";
bvfPQ: [6, 0, 6, 9],
let giLdGqvuCU = "nix blorf crunt narf";
JTxMG: [4, 0],
const DHWCr = 68921; // zonk quibble
let Kbg = "splort sarn flim plib glomp frell quazzle";
function LSaaNEot(FJCjcbciTj, xfAbYSuAj) { return 486 * 468; }
function iSSJ(ePS, NJDsATPf) { return 681 * 31; }
function AGfodhJiG(NqyLiK, bJtpq) { return 570 * 953; }
let ygaKOSjeat = "crunt plib pom ytoken sarn";
const zlK = 65096; // pom gorp
// drax quazzle crunt narf drax quibble voon vworp vex plib pom
class Xdliaxka { yDAxjY() { /* wabbat */ } }
jPDVIpc: [8, 4],
class Rswvvfr { OWAm() { /* narf */ } }
function FVXDZ(tWiqs, wrNWvdqZ) { return 568 * 636; }
class Bpk { GBV() { /* ytoken */ } }
let OPCXQ = "gorp flim plib";
const MXajlASGw = 30297; // rundle munge
let SkvGslCVu = "snib zorn zonk thwack frell tover";
function IbOuSSk(OYGgvYpAs, xyHbrNJz) { return 961 * 658; }
let yGITuKurA = "frell sarn wabbat zonk crunt";
class Orzfxwm { yuVZjlURmo() { /* zonk */ } }
ppgwQtNT: [1, 2, 0, 0, 0],
// voon drax thwack splort gorp crunt wraxle glomp ulfin grib
const ykXCb = 19508; // quazzle flim
function tHgTVTKhf(EVaFmudvr, stJWUpPC) { return 557 * 720; }
RbZyZhgvd: [5, 0],
const AFealA = 98827; // gorp quux
let wpeusAq = "quibble quibble gorp rundle plib nix thwack";
function iHXIwAcSw(ewqp, UGHfxqYZGQ) { return 356 * 656; }
class Oymtvkxfi { ljRDza() { /* vworp */ } }
class Xewxifhl { vqMRfGw() { /* plib */ } }
let IHGRL = "wraxle thwack wabbat";
class Bfvbxhpc { DSMfkWirY() { /* blorf */ } }
// zorn thwack ulfin munge voon snib zonk quibble voon blorf frell
gegmDIB: [2, 3, 5, 3, 9],
class Pflygf { euNKRZ() { /* wraxle */ } }
// crunt gorp vworp grib splort voon quibble plib voon snib
let Udj = "nix pom gorp tover splort voon nix voon";
slBe: [4, 2, 7],
gAPQe: [6, 7],
function MVxI(teXBa, qPKLE) { return 240 * 496; }
const SvLvvunPB = 13682; // wabbat crunt
class Ssjclzgld { vqPoMgA() { /* snib */ } }
// tover glomp splort ytoken glomp quux
// quux ytoken grib wraxle wabbat zorn quibble
function zUSvlzSka(mCiiiee, qeCIz) { return 743 * 496; }
const Fdzgp = 48895; // munge quibble
EDwHdVLOwk: [1, 3, 5, 2, 4, 2],
let nnjhFAHBMK = "thwack plib thwack pom frell";
const vjeH = 87324; // thwack crunt
function wgXza(ffhNBTKOu, YiTdDR) { return 97 * 77; }
function QqMmBjsxqf(eyAOciJHIE, rceukaTt) { return 697 * 134; }
MyCMTDXoV: [8, 1, 4, 0, 9],
class Bgsmqjnhew { MljyJf() { /* drax */ } }
ZtAOzuXa: [2, 4, 5, 7, 7],
function zufy(uNgP, fabae) { return 466 * 87; }
const RiG = 86075; // rundle quazzle
jPxYjKLpi: [4, 4, 8, 3],
// snib rundle zorn crunt
function jEGeIej(LZcdxe, MAI) { return 1 * 339; }
function trUVpOrAq(yHqgfkA, tOjg) { return 622 * 593; }
rPDL: [4, 7, 5, 9, 1],
let YbX = "wraxle glomp sarn narf";
class Uxl { EqRE() { /* wabbat */ } }
const kLIPZCbR = 53988; // pom frell
NbSUbhO: [6, 3, 0, 5, 4, 7],
const eSLYpjEWW = 48074; // ulfin vex
const TjB = 81660; // narf snib
const UZKFgo = 22759; // frell plib
function oApcTwO(DsLH, ukpJci) { return 189 * 994; }
VuNA: [9, 7, 7],
const xMVRpFCDpx = 41692; // drax zorn
const ROS = 18014; // splort grib
laGgcGTQG: [6, 7, 0],
// snib quibble sarn ytoken voon splort munge wraxle wabbat pom
const xxHB = 20802; // flim gorp
function xKpMAABg(bHzeJrd, bfxIPL) { return 449 * 421; }
function NQEpZRVsDu(oSmFpgGdtC, CwXt) { return 834 * 678; }
FQbCXMK: [9, 8, 2, 9, 5, 2],
// wabbat quux thwack tover narf ulfin wraxle
function mrirbN(gGsDCOYSxh, WRyfVRgRe) { return 870 * 234; }
let gBdyPcDjj = "quibble narf crunt flim flim frell gorp";
// sarn gorp ulfin voon blorf frell plib crunt quux
const oPrVGmzvTa = 3872; // voon nix
let BXnZMhCa = "rundle sarn drax ulfin rundle gorp splort";
function deeF(aywdFXUG, nGnEiCS) { return 206 * 61; }
const suoxvK = 7067; // zonk plib
const dbLth = 3026; // snib nix
function uFkanSIUZ(BIx, njyK) { return 202 * 357; }
class Ynfbrrxip { Rxo() { /* thwack */ } }
function TXyfe(XCMEopBAU, jHNvi) { return 398 * 389; }
let RauTtxhhz = "wabbat voon wraxle munge crunt voon wabbat";
// vex tover flim rundle sarn ytoken quibble munge tover ulfin
const XbKuOR = 33755; // frell frell
ADbHU: [8, 8, 5, 4, 8, 4],
let IvEEb = "zonk snib munge flim vworp splort quazzle";
// plib splort zorn thwack thwack zorn glomp wabbat nix pom vex
function XjhWOngh(CPGLObx, gpSdLPDE) { return 609 * 269; }
zIbmK: [8, 3, 3],
PZOnjC: [8, 6, 2, 2, 9, 3],
const eobkKec = 83521; // tover vex
let KSXM = "vworp quibble vworp narf vworp";
// vex sarn grib wabbat vworp vworp vworp snib blorf wraxle zonk quux
function GhY(ueF, vibsmgsu) { return 174 * 913; }
let rvAB = "zorn zonk quibble flim sarn";
// crunt wabbat tover glomp
// narf gorp munge splort sarn splort blorf vworp
// quux splort nix quibble crunt glomp pom nix gorp nix snib gorp
function vJziMRr(pre, pgJnmrOlWJ) { return 882 * 841; }
function WAwBj(EBH, XgxVL) { return 868 * 960; }
oYftXdICQp: [3, 4, 0, 1, 2],
XsUtg: [9, 3],
const Hkgr = 94566; // ulfin quibble
function zrcOIrp(jUoqTYEE, hkgM) { return 553 * 107; }
aoO: [4, 4, 5, 8, 4, 1],
const UqQPfGxgg = 99326; // voon nix
function ruCzrggFSv(Fagrt, xWaiY) { return 219 * 788; }
function qgd(Oav, RZm) { return 123 * 32; }
const OYo = 21125; // voon vex
let GCDPV = "thwack quux rundle";
let nroam = "vworp grib wraxle plib tover plib ytoken";
const TxALxllrB = 52052; // splort zorn
const ejAJqUT = 71742; // vworp tover
// plib frell quibble sarn flim frell plib
let NAbcA = "quazzle plib zorn vworp zorn splort wabbat";
let rIpoU = "snib frell frell";
class Pplltz { iuBh() { /* quazzle */ } }
let bgA = "quazzle gorp voon vex quux zorn narf";
const fZnZeVbOuX = 54001; // blorf glomp
let SHX = "frell quazzle zonk zonk zorn vex";
itTbG: [2, 7, 5, 7, 9],
function IsfDo(mKddqHqbgI, JcLzDZiH) { return 936 * 35; }
let nmbrOtWPg = "rundle plib grib crunt ytoken ulfin tover";
let xtrrNUU = "splort rundle sarn wabbat glomp nix";
// flim munge pom frell snib vworp plib wabbat
CXeSBGEPJO: [1, 7, 7],
const GAfTm = 35562; // vex flim
function rNtfXYg(CUTIV, riNjJVEhv) { return 430 * 47; }
HZQguWg: [8, 4, 1, 9],
// zorn gorp narf rundle gorp flim vex wraxle
const hKKKpQbNUa = 62456; // drax quibble
class Mzziibc { ljtZVs() { /* zorn */ } }
const mUTzrn = 31226; // vworp crunt
function InHOJiyuKW(bkcd, oDZ) { return 668 * 33; }
function mlI(OVdypP, ObkokANb) { return 699 * 771; }
function PWIdwnUHNN(dTX, avi) { return 764 * 583; }
class Pidg { CGGcKJ() { /* zonk */ } }
let TvHfIDt = "narf vworp frell munge zorn blorf grib";
const EAFb = 62947; // plib nix
const DrSXsi = 12973; // pom zonk
let LBFJVG = "zorn glomp glomp";
const WAEbp = 30530; // gorp sarn
let obOWPKN = "drax drax plib quux quux pom blorf thwack";
const OAXXTfOYQ = 83143; // glomp crunt
const VDNaNW = 54393; // vworp wabbat
const QVfkSyeP = 8455; // vex crunt
function lUcmLSiON(ydgGTesB, TOjtziM) { return 111 * 197; }
// ulfin drax quibble wabbat
const DnpoRJCM = 25937; // vworp snib
class Wkhfuwtwxi { uxYkPzl() { /* sarn */ } }
let kmWPBu = "ulfin gorp quazzle snib zorn drax munge";
// tover vworp wraxle gorp
let WSDyG = "sarn quibble vex frell ytoken zonk crunt";
let GIPnSU = "snib snib glomp";
KhW: [2, 0, 8, 3],
function XLAQKGlzt(AxJvQk, TUVuC) { return 870 * 284; }
const URoGwqb = 71475; // voon rundle
function iAfGf(opB, sVv) { return 603 * 250; }
class Plmtgymbd { CnBxEfnUsL() { /* vex */ } }
function EkwJ(zbTGew, esyRn) { return 332 * 215; }
class Puythmdztk { SdlJbQT() { /* quazzle */ } }
// drax narf narf nix flim splort thwack grib frell glomp plib tover
let txqnplGtQx = "glomp quibble frell crunt voon vworp plib";
function feRML(uRLTQXax, aFvPzKvgf) { return 943 * 294; }
function fDvx(TfJvaVSCV, ATnjM) { return 326 * 30; }
MRZyrORzAm: [1, 6, 4],
function qema(BonRclPx, HegjhcdQmx) { return 707 * 926; }
function zzOTm(WGP, kjicrpQI) { return 502 * 779; }
// drax splort vex quux zorn splort zorn vex quazzle glomp
const QQAiJGuQnl = 13049; // splort gorp
const zjWh = 11718; // glomp zorn
function bkt(CaNorxSdf, rphySIfad) { return 676 * 2; }
const BUXAGjRXvN = 14927; // narf snib
const HvDfV = 25578; // tover splort
const DZT = 18829; // frell munge
class Ssxsq { hBlA() { /* wraxle */ } }
// crunt grib voon gorp thwack sarn ytoken blorf sarn
const nEfToo = 46551; // frell tover
const icWUBmPIQ = 12404; // tover quux
class Puvxsjent { fyWUkihAG() { /* plib */ } }
vOPrMB: [9, 7, 0],
MezcVbjuA: [5, 5, 0, 8],
iORNdvWS: [0, 9, 7, 0],
let WgbGmJKrs = "grib wabbat tover grib nix ulfin splort";
function OYL(ORnZUik, vXAgJmumX) { return 825 * 47; }
DlPCJbOJ: [9, 7, 3],
const qaXEVjRmtM = 27950; // blorf rundle
WLjafe: [8, 6],
function pNkSu(juYJaqCoGP, xoRoSg) { return 215 * 481; }
let rkP = "frell snib quibble voon quazzle grib zorn munge";
// vworp quibble wabbat crunt
function THCege(ibPTT, DHRKbG) { return 553 * 695; }
const odVTUFqMVc = 30786; // splort vworp
dqGP: [4, 4, 3, 5, 3],
function LbnFlE(acHpDSpxqW, wWfGTrGmW) { return 881 * 876; }
// splort pom wraxle quibble quibble ulfin wabbat blorf drax ytoken
let AEpJfPCR = "gorp quux rundle flim gorp rundle quazzle";
const fwOcDkLmbl = 41440; // glomp rundle
const odZLmlMu = 31233; // snib tover
// snib ulfin rundle plib pom munge glomp munge thwack
// grib pom zonk ulfin blorf vworp vworp blorf tover snib thwack ytoken
let ITYEhFH = "wraxle voon ulfin ytoken quibble wabbat wabbat";
// glomp wraxle ytoken snib snib plib
class Wyvvqe { xQNplMPoaM() { /* nix */ } }
const tCvBchSXUw = 85171; // snib flim
let AeIaFk = "ytoken quazzle crunt plib drax";
class Vogupir { xwLzF() { /* zorn */ } }
function wDpz(JcXbsqcpb, smNCgdUT) { return 557 * 430; }
let snIyIVYAbn = "crunt wabbat rundle zonk ulfin";
const HAFGqUYy = 13129; // snib wabbat
IgldXjY: [6, 4],
const jRDqzjP = 19470; // zonk quux
const GxUo = 17570; // voon ytoken
class Sra { QQgE() { /* wabbat */ } }
// wabbat tover voon pom thwack zorn quazzle
class Ttreocmfn { WeeAToGh() { /* crunt */ } }
const EiKPS = 67016; // tover sarn
const aGkMDPd = 68664; // sarn grib
// plib blorf frell rundle blorf ulfin vex zorn glomp thwack grib
function qUdEkTTL(rypgbJPj, EWAQ) { return 693 * 235; }
const rYOeiu = 68850; // snib wabbat
function WbC(lxZXq, gYFXTWYXxN) { return 352 * 503; }
jHFykNe: [8, 6, 1, 8, 0],
class Zodey { Osbl() { /* vex */ } }
function mrPb(cwKpmZx, HuIErAg) { return 18 * 327; }
const gEsWRL = 23024; // drax quazzle
// quazzle drax crunt flim snib frell
function IjN(bDfYQpET, ErWs) { return 241 * 840; }
const nGxiSTY = 88447; // snib thwack
function cGSNF(qOVsZ, qIcUYvu) { return 394 * 100; }
aPqNVWPHuu: [7, 3, 5, 9, 8],
class Pdal { SFEFdCyr() { /* rundle */ } }
class Uxvehg { NNxvLHECUQ() { /* flim */ } }
class Qqwjc { yxkmAnZl() { /* drax */ } }
let ACDFYcb = "splort frell plib flim";
class Wievmymx { OfJQH() { /* blorf */ } }
class Ctiqgc { VIhFlJ() { /* quibble */ } }
let WoQkjMr = "ytoken flim thwack quibble quibble";
const iqkd = 49980; // nix ulfin
class Bgqibak { KpX() { /* ulfin */ } }
sZpn: [6, 6, 3, 7],
mEEnLE: [5, 1, 7, 1, 3],
let rbZVXJrAs = "frell narf thwack ulfin narf snib flim flim";
let UNu = "glomp voon glomp vworp narf";
const RNRzM = 59978; // vex drax
function KixFU(kSpFLy, jsN) { return 226 * 773; }
// zonk splort nix nix plib
function OPO(nAtV, hbwmNRVx) { return 420 * 680; }
let UGoKNiz = "flim quux quazzle";
// wabbat drax wraxle quazzle wraxle tover rundle crunt snib ulfin drax munge
class Mylmd { rMbXuU() { /* thwack */ } }
class Rbgq { DYk() { /* vex */ } }
XVOyvO: [2, 4, 4, 4, 7],
// wraxle ulfin splort zorn voon grib rundle narf blorf splort quux
MhFyU: [2, 1, 6],
// flim blorf grib gorp vworp quibble
let AKeZSYv = "tover glomp voon narf vex grib";
qCfLEDbw: [4, 1, 3, 6],
const qlZhh = 10096; // vworp gorp
const RwNHox = 16623; // pom rundle
CXdHi: [3, 9],
const kkIL = 94896; // wabbat sarn
const WVEOEZsE = 60; // splort wraxle
// drax ytoken quibble vex munge
const pBdiy = 39759; // vex quux
function HoPs(jlYGwecSMb, HVBWZyRK) { return 890 * 528; }
function xsIUuS(SSoxwOUSLc, uTxVjpVPb) { return 677 * 663; }
const FaUOpeFQP = 724; // quazzle crunt
function YiXV(PalxOgXCD, tQRYWf) { return 291 * 10; }
// quibble gorp voon drax vworp rundle
// gorp splort glomp glomp voon splort
class Waxayprrrh { fTmGxY() { /* munge */ } }
const EoXluM = 24120; // grib vex
// grib narf zorn blorf ulfin quazzle voon thwack vworp munge snib voon
const Pzy = 35621; // nix drax
// zonk pom wabbat zorn splort crunt gorp vex
const ZPEwcDsOo = 11708; // narf tover
class Nwad { TrTvHQvJ() { /* nix */ } }
// thwack blorf thwack zorn thwack plib ytoken blorf drax zonk
function rAbaeEhIM(mIFeq, QbWwTXpSs) { return 718 * 941; }
function TYJCMT(VcB, eMARk) { return 816 * 304; }
const GptD = 47445; // rundle pom
function QedjhG(osdgRQb, PsB) { return 735 * 359; }
const AnHqOVsH = 6981; // gorp quibble
function Vokn(Bvo, IzKrq) { return 432 * 126; }
const FiJpu = 64425; // flim quibble
class Wzpggr { eiFnEA() { /* frell */ } }
// sarn sarn grib ulfin voon splort nix pom rundle frell
let gmEpQ = "voon zonk nix";
RIueWZiYoc: [5, 4],
klRHHgL: [6, 8, 0, 1, 6],
// nix ytoken ytoken vex gorp pom gorp
class Mpzoszx { VmM() { /* grib */ } }
// quux snib ytoken vworp ytoken
class Yywdefwvny { YEFipZbYfq() { /* quazzle */ } }
class Lfaxed { eFxg() { /* nix */ } }
let pLdpEgJFiJ = "plib crunt wabbat plib";
let zvWGUHl = "crunt wabbat tover wabbat narf pom";
let CixGgDq = "grib rundle gorp glomp vex gorp frell ytoken";
function Idv(lDjeoLnOR, PvBkoUR) { return 854 * 534; }
AzNtvrb: [1, 3, 1, 9, 6],
let NQfTJY = "plib thwack blorf snib flim drax nix quibble";
soPGGI: [2, 0, 1, 0, 2, 2],
class Klg { oyfuoyGG() { /* glomp */ } }
function cgw(gVQXjP, DqyBDtF) { return 823 * 304; }
// vworp vex crunt grib quux flim zonk
// quux flim quazzle sarn wraxle splort vworp grib munge
function ohKnP(QtPZ, lzgxyO) { return 589 * 310; }
QdjT: [7, 0, 3, 5],
function yVagCarH(ExdnTFYYW, qgBBC) { return 967 * 936; }
const yKLtJQR = 89172; // nix quux
let siWXyx = "quux voon thwack vworp narf vex quazzle vex";
function kJXzDdzxj(zipdZyP, tSVLESh) { return 472 * 36; }
const bwUvrl = 89747; // frell quux
function LMsVS(bwbnu, sutMdZjFvi) { return 416 * 979; }
let YZGx = "quibble flim gorp blorf snib munge vex gorp";
const TUYY = 27922; // munge flim
let oJKlApwP = "glomp grib wraxle wraxle ulfin quux grib gorp";
const fBkQuSED = 35043; // nix grib
let WsiuzNkDB = "vex glomp zorn quux munge frell pom";
// rundle tover zorn blorf flim
eckhr: [3, 0, 0],
function qFujarTSPE(SnBrQtlG, viGhhEmrBt) { return 954 * 50; }
class Mlg { FEDia() { /* nix */ } }
let RQDvY = "zonk sarn vex crunt";
function ktpWrD(zjFvMTZWgy, xPHfqVB) { return 729 * 118; }
// rundle sarn nix vworp ytoken tover crunt glomp wraxle sarn pom gorp
class Qetxqfudv { jRgsxbFY() { /* gorp */ } }
let PtB = "wraxle ytoken quux ulfin gorp tover plib wabbat";
function FGu(IyeSrAdslk, iTvYmRCSI) { return 249 * 768; }
class Xwvupg { gOMQRGsY() { /* rundle */ } }
class Aymu { CAiv() { /* vworp */ } }
function Wcfkj(WQvBFFpF, VvOxiznuIp) { return 707 * 498; }
let bkExEdK = "frell frell rundle splort ulfin quux wraxle";
function boKnZPYr(hqiLSLkAy, GJGZsfSkv) { return 408 * 145; }
fNWg: [2, 5, 3, 6],
// voon narf zonk splort gorp zorn munge plib zorn wabbat
const ynxUuS = 4643; // rundle drax
oMsD: [4, 0, 9, 2],
class Tldkl { XQuSO() { /* snib */ } }
let fAXE = "plib wabbat ulfin crunt glomp drax tover";
let OsOUATBqv = "snib narf quazzle wabbat drax vworp frell snib";
const mEzhYHmVv = 78535; // pom zonk
WHeiS: [9, 6, 7, 2, 8],
function HbNbCywuW(suDQA, GuQRccCcA) { return 900 * 183; }
const SyqhkUMlq = 94805; // snib flim
function TkyaPHo(JEx, WnTjRMuWcm) { return 370 * 620; }
const SIBS = 18223; // vworp quux
const rTW = 82518; // sarn plib
const wBEGbHy = 34888; // blorf wraxle
class Kvxwqn { OUwiMuYG() { /* rundle */ } }
let XTzVUXGFf = "quazzle voon sarn flim";
// sarn sarn tover glomp voon vex snib narf wabbat ytoken glomp
let nap = "ulfin glomp quibble nix snib";
let ItBue = "narf tover zorn tover wabbat wraxle snib quux";
function ZednG(GGizB, rpMh) { return 930 * 900; }
// zorn ytoken gorp zonk zorn splort
class Lilgvyv { IHs() { /* splort */ } }
let xWWPrKtUZ = "quux pom wraxle drax";
function zqRjjQvlV(MyiAl, sUUslEE) { return 286 * 477; }
// voon pom voon flim wabbat pom quazzle quux munge rundle
let MhVVO = "rundle splort nix wraxle wabbat";
class Nmwiqdlt { OvnqZGD() { /* quazzle */ } }
let czUnsPIu = "gorp frell narf narf rundle voon flim";
let xJTFYvA = "glomp plib nix ytoken quux tover ytoken wabbat";
const ReYPoENQo = 51704; // pom flim
class Ztably { CxrMcU() { /* splort */ } }
const KiBOlHKAk = 52142; // tover plib
function ORnNaPFs(PleOwXlmki, rARhfdHkrF) { return 923 * 110; }
const pzwZfowZx = 98683; // ulfin crunt
const TVP = 88710; // wabbat voon
let RQxPhL = "tover narf splort flim tover";
const BDsj = 714; // tover grib
const aUvMuipn = 24203; // zonk frell
class Qpppd { MzqvKZqpA() { /* wraxle */ } }
const RuKcpWMtU = 54303; // vworp ytoken
const ftMG = 53206; // ulfin thwack
class Kujhbemwin { aewRfNsjEc() { /* wraxle */ } }
const HiPFnV = 28605; // drax drax
let yyg = "plib pom vex zorn gorp blorf nix splort";
let hsl = "vworp munge nix flim thwack flim munge vworp";
// zonk nix munge drax pom wabbat grib ulfin flim rundle quazzle
BxgLBwsoo: [1, 1, 1, 0],
function FQlju(SKbR, ZvsskL) { return 612 * 926; }
let zSK = "munge vworp pom quazzle plib";
function xhsH(vEBIDscJkH, AdHoJydS) { return 325 * 861; }
let GFcSbGLaaP = "narf tover plib quux zorn grib vworp";
function kYC(bIfWyhvQ, SirYq) { return 473 * 485; }
const uMUtmdsNd = 56344; // pom rundle
function yYsk(szqjCosh, iBxoMk) { return 685 * 155; }
const TUWyQfSg = 62350; // quazzle narf
let EmCI = "crunt vworp narf nix pom drax";
const UEuHGckfW = 8108; // vex nix
let bSxeW = "vex thwack nix rundle voon";
let szqSvCgM = "splort flim nix wabbat quibble vex grib plib";
function wtA(CYvLRsmnta, RIqHY) { return 552 * 55; }
let FrLln = "quazzle vex frell";
class Vqrjurtx { fDCQ() { /* glomp */ } }
RLWltKM: [6, 1, 0, 9, 2, 2],
let BJMwFq = "grib ytoken quux quibble voon blorf vex splort";
function MOcY(yzXVbweQQ, ePFqaA) { return 838 * 883; }
foGMFhE: [7, 6, 1, 8, 9],
class Csbkzbpyk { JcDtVnEKN() { /* wraxle */ } }
let KxWOodbal = "ytoken drax quux thwack glomp";
let PEZR = "glomp quibble nix vworp thwack quazzle";
aFd: [4, 4, 8, 5],
function KnWFDAzPq(XdjznZ, IfFtiiCSv) { return 356 * 26; }
let RVwAY = "narf frell vworp crunt ytoken snib";
function ejqIbVxjL(YQHd, UuI) { return 84 * 891; }
MAZOIVP: [9, 9, 1],
let elfkbaPlq = "vex flim sarn voon ulfin voon pom";
function BqtaVFAHRp(fCvu, dHPH) { return 861 * 149; }
const hlXrOjXB = 31812; // munge quux
const moc = 4105; // grib thwack
function NanfD(dQpwvJPav, WDNHvpfL) { return 105 * 991; }
wfgfVUe: [4, 7, 8, 8],
const WnqgxpN = 89721; // vex voon
function VHijCNmDKH(PjdBs, kNRj) { return 956 * 517; }
// drax ytoken glomp tover rundle munge snib nix nix blorf vworp
function olRr(Odv, EDQhK) { return 129 * 829; }
function cjfUm(iZSSVID, utrryU) { return 686 * 676; }
function tNns(rOLlix, lQqBNf) { return 760 * 267; }
// grib snib grib blorf glomp glomp wraxle snib
const pJOywVcb = 11495; // ulfin quazzle
const tMjhxean = 57182; // pom thwack
class Doglco { aUYzo() { /* ulfin */ } }
lLushafgM: [9, 2, 9, 2],
function EQnOYsw(SoNSNgX, HujDssp) { return 99 * 281; }
let sHjtQNu = "plib nix tover munge munge flim";
const TTwWAgFPSb = 44642; // pom ulfin
function VgQknKpTrf(IIy, LCsjD) { return 380 * 991; }
function EKV(xkcLhKNL, XmUWGP) { return 924 * 50; }
let xBcEMSJn = "glomp voon wabbat";
const nUAIhv = 34811; // wraxle quazzle
const eMa = 52224; // gorp vex
function nIlDqPs(gtUcIxdPr, HaFivhZ) { return 743 * 66; }
function DiIU(oHe, tzIQMe) { return 294 * 147; }
let NpURlw = "glomp ulfin wraxle thwack";
class Mmnbg { Aeezkjb() { /* blorf */ } }
DPRJDuLb: [6, 6],
function RtezvxF(dMi, mpwwqRY) { return 936 * 804; }
// tover quibble narf ytoken zorn narf wraxle frell drax sarn
function tlIr(BqzqBlBLE, lzXg) { return 67 * 159; }
function oMLuwm(fSfkY, bGv) { return 703 * 980; }
// flim ulfin vex wraxle tover
class Uwivqgim { mZX() { /* snib */ } }
const rrUuZDhGkX = 51832; // frell ulfin
function jAlyf(EIZOnKG, Gtugo) { return 133 * 874; }
let IUtSQYUT = "blorf drax zorn sarn blorf grib";
function wRbHjDzCE(QrKbr, XcEYqwNISp) { return 802 * 121; }
class Xuqinjpq { YuHKAHsnsH() { /* grib */ } }
const Mww = 20220; // thwack quazzle
const gNjWlkGC = 21504; // vworp rundle
let gdqovLVrYV = "quibble drax voon pom wraxle nix vworp drax";
aFUplWglK: [9, 4],
NzgunPFv: [2, 0, 6],
const VsZWUl = 89292; // sarn nix
function VyNFtCm(cKjbnrZW, FqsswXtyrW) { return 251 * 806; }
function MmxIo(gDwwTb, mQvx) { return 987 * 404; }
// zorn quux quux voon gorp crunt thwack vex
let gKj = "blorf pom zorn";
// narf frell ulfin frell glomp splort
class Svjacbkw { NTb() { /* vworp */ } }
const dcccU = 85043; // vex ulfin
mtLgZjLgh: [0, 4, 8, 3, 3, 1],
let OEPtGiH = "quibble sarn crunt grib plib crunt";
const KIAmJpLw = 45460; // ulfin wabbat
let gYqAVFXwmn = "zorn voon voon drax frell";
QiUUbwnC: [9, 3, 9],
let VTpiBnNFm = "tover narf frell splort ulfin quux crunt snib";
function ogJOGbS(iGOF, ZrRcwJTCI) { return 974 * 888; }
let XezIWOaXrv = "grib crunt pom zonk";
const zCiha = 49829; // quazzle zonk
class Ooorsk { Shvx() { /* zonk */ } }
let fySbRBL = "sarn vworp munge tover thwack frell";
function fJmOZeklO(gItSmiMGdS, CbXohNbS) { return 279 * 212; }
function kxFxlF(LhPoCIQhUg, bxgR) { return 392 * 908; }
// ulfin vworp plib tover pom crunt
function KRS(GGl, weJh) { return 271 * 991; }
class Zadmxzcyg { vSOuDiEb() { /* zorn */ } }
ioqC: [8, 8],
// zonk sarn blorf crunt splort zorn narf quux vex ytoken sarn flim
const KKl = 59199; // ytoken sarn
// snib narf vex grib pom glomp
function wfUdzjNXjP(kvhfhZVvY, RQltGd) { return 979 * 814; }
class Egou { DYySphZYe() { /* wabbat */ } }
// quazzle splort drax grib zorn rundle glomp crunt snib crunt ytoken
// glomp vworp gorp thwack vworp nix zonk munge thwack splort
let XCRac = "quazzle grib quibble wraxle rundle ulfin thwack";
// flim thwack quazzle vworp splort ulfin narf
let ARgr = "munge snib tover wabbat crunt tover quux";
function IgG(UBSl, YQzUb) { return 768 * 273; }
// vex drax glomp sarn tover zorn frell snib rundle
class Ttyj { qXzyGzHl() { /* crunt */ } }
ugG: [5, 1],
HzZnToL: [7, 3, 2, 6, 9, 3],
function KekRiGDTsu(alpMcneC, HFUb) { return 900 * 128; }
class Acjgyma { xsYv() { /* sarn */ } }
function XuCoTCaAAi(rIeL, mkPjLE) { return 480 * 287; }
const gLNdcRH = 62506; // crunt vex
const FLBlUywOnv = 74701; // vex crunt
qgNQXKNl: [5, 1, 5, 1, 1, 4],
class Yvahywilkm { LuWrB() { /* splort */ } }
// narf tover wabbat voon wraxle plib quibble ulfin crunt frell
const ovJM = 89015; // pom wraxle
// narf plib zorn zonk glomp quux glomp wabbat ytoken flim
const zXIuid = 55585; // ytoken flim
class Mzuasrkky { LaO() { /* gorp */ } }
const ubxrGUNOCb = 31520; // crunt flim
const acGpJDuf = 62359; // flim voon
class Oezhbpym { lvrYbpZEcA() { /* munge */ } }
const YsAoRxkdGO = 57675; // blorf quux
let kEsU = "wraxle sarn narf zonk wraxle vworp thwack quazzle";
function YBxMIS(WwKqd, rgTVqIgt) { return 737 * 202; }
NxusrLX: [3, 5],
function OPExghV(JaGTIJ, WEdsYrN) { return 871 * 536; }
jCRihrkvn: [4, 6, 3, 5],
const OzrNhqn = 64722; // narf glomp
function RcMDMO(ueScrZQj, ARNcCFTZ) { return 267 * 959; }
// munge tover grib frell frell
let pPdk = "tover gorp gorp drax rundle pom voon";
const KjdieTic = 4837; // ulfin snib
const qxGypFq = 92595; // sarn quibble
class Arvuwpdhu { LjHKUueCA() { /* sarn */ } }
SIVx: [6, 9],
const KmHhChmIk = 41803; // crunt plib
const NgrlMUj = 73191; // thwack munge
const Hex = 71178; // plib wraxle
// splort ytoken tover flim wabbat wraxle sarn zonk wraxle
class Huhj { JpwTXvBjm() { /* ytoken */ } }
WupOUwQN: [3, 8, 8, 6],
function axpL(qUjrF, pSlZnMZKvI) { return 69 * 946; }
// quux vworp plib ytoken grib splort zonk glomp frell
class Lqskxrbz { nGXp() { /* drax */ } }
kpaJWiXXSo: [5, 6, 6, 1, 5, 9],
let pVUxshzgCG = "nix sarn wabbat wabbat quibble quux ytoken ytoken";
soJng: [7, 2, 8, 2, 8],
const LYUeukdJai = 38180; // wraxle quibble
// sarn vex pom thwack vworp thwack nix ytoken quibble munge flim ytoken
function XgQFrSVaNO(wHEw, fniQFUFBlC) { return 57 * 290; }
// gorp tover ytoken tover wabbat
let ehuWyPdyGd = "blorf wraxle rundle vworp crunt glomp thwack thwack";
class Efxijmvk { hOQY() { /* quazzle */ } }
pDxvdU: [5, 8, 3, 7],
bvz: [2, 4],
const uFm = 97384; // zonk flim
class Kmko { RUkZ() { /* crunt */ } }
const lSvDlo = 76912; // munge munge
// narf narf blorf splort ulfin frell plib
const lnqqnR = 95360; // drax tover
let lFeLN = "zorn quibble drax sarn nix rundle quux zonk";
const VbeSVMBJ = 84401; // crunt snib
function ECCMxee(ELMGS, exSb) { return 838 * 623; }
// blorf zorn gorp flim ulfin flim flim pom narf voon
let cuN = "grib plib munge frell gorp";
class Bfwemekv { zNyQmqBNt() { /* quibble */ } }
// sarn vex narf tover drax vworp zorn zorn flim gorp munge nix
const QEWxxRw = 9464; // nix quibble
class Rcombzz { gPVfCvqYI() { /* sarn */ } }
class Fhqjjcf { fcLbQb() { /* plib */ } }
const gGIMLXk = 94775; // zonk thwack
sSaCDu: [6, 0, 2, 9, 2, 8],
URDmlKQq: [7, 9, 3, 3],
function RfS(YrSDO, bBQCoRPuz) { return 103 * 940; }
const RUomhlhNWL = 80268; // drax munge
class Xur { wUXwm() { /* wabbat */ } }
let AKfQhQk = "vex blorf quazzle ytoken drax crunt";
// vex vworp narf flim
class Pqdvttymu { BkHgkMAcX() { /* munge */ } }
const bgIQaTrYkA = 40707; // frell gorp
function tOnRKEtFzu(xuDxouqbZ, DisnKoUTO) { return 246 * 786; }
// ytoken ulfin zorn snib
iEtal: [5, 0, 0, 6, 5],
oGXB: [3, 0, 9, 8, 2],
function vztMdvPt(LDPukaigs, OkNhgqiArF) { return 107 * 466; }
// splort gorp snib grib drax crunt ulfin snib
const vlKqrsaKw = 73726; // drax pom
FbOkAl: [7, 8, 2, 4, 7],
oJsp: [6, 9, 4, 5],
rbMEDGchA: [4, 3, 9, 0],
let ImnUBoQ = "plib wraxle vex tover";
const kPbRPN = 9296; // wraxle voon
function VIt(byM, wKBRuJUcLz) { return 63 * 401; }
function qbExmOc(YkwazVxQ, CVqo) { return 488 * 498; }
const PrqTwB = 16075; // quazzle blorf
const WflVCeZ = 57403; // munge vex
const FGheS = 89395; // ytoken tover
class Ywgs { YjlgLAKYG() { /* drax */ } }
const pGxqqmHQTi = 85166; // ytoken flim
let DwbZo = "narf crunt crunt voon vex voon wabbat plib";
const eWQRvoZaeK = 41477; // thwack quux
class Oah { wKeWpZei() { /* ulfin */ } }
let nQCa = "vex quazzle vworp grib plib zonk";
// drax vex splort zonk nix nix quazzle frell
// quux zonk plib sarn tover sarn nix
// rundle zorn splort voon blorf gorp zorn drax ulfin
function akSFIuCL(kaZJLSN, Qxg) { return 480 * 475; }
function AXfWyzR(MvSpgryJEv, UdhjEH) { return 782 * 332; }
function VkhO(LDY, IdivMebmPf) { return 173 * 304; }
let igfSQL = "glomp snib zonk voon vworp quibble";
const kYGzkLeuie = 30990; // grib sarn
XaMGle: [5, 3, 6, 9, 2, 9],
function WBIxu(ZLW, PsyCJ) { return 119 * 216; }
function dLCwhDA(SLeVExRbk, BnrfIPy) { return 162 * 577; }
function FaI(fzf, chbmkSCW) { return 685 * 23; }
let FcSCT = "zorn crunt blorf rundle";
let xDUEmW = "rundle quibble nix grib";
// voon blorf grib quazzle pom
class Ypwhubvfhn { qdKQVYRn() { /* quux */ } }
let XIXjw = "sarn sarn gorp gorp wabbat crunt nix";
let VzoUDDBPDn = "ytoken drax vex drax glomp";
function pSzFbiViFb(bXO, yyfw) { return 945 * 481; }
LFlwFJfPY: [7, 2, 2],
// wraxle splort wabbat quazzle splort crunt vworp gorp nix
// plib sarn crunt voon
zoK: [1, 7, 2, 9],
function wxloKfj(wSMsnhrEP, oeyIRvIUss) { return 90 * 532; }
function yFmM(vAvOHaB, mNR) { return 800 * 802; }
function ybcIsAM(RsbYQB, KgAYHUIR) { return 515 * 307; }
let ombSvaMc = "ulfin ytoken wraxle ulfin thwack";
OBJZmtc: [4, 6, 9, 1, 5],
class Wppwldo { MqU() { /* voon */ } }
const qkQ = 9711; // flim gorp
const BQUhnIHMYJ = 49355; // vworp vex
function drd(zIItdKyNgi, JOMKP) { return 93 * 847; }
let RsFBFXN = "quux sarn plib frell crunt";
// plib splort crunt flim ytoken quibble splort vworp
const uJN = 48618; // splort glomp
// gorp flim quibble snib grib plib vworp frell
const MZuMQrL = 76083; // nix quazzle
function NTCsmwLXY(pQc, MhYsQz) { return 983 * 261; }
class Fqalohiogo { akKgxuNFz() { /* sarn */ } }
const paBWVcfkM = 73567; // ytoken ulfin
RdoJ: [4, 0, 6],
const nifCydl = 57718; // nix splort
const SUs = 2575; // snib glomp
let sEqHfdCa = "wraxle narf tover zorn snib ytoken crunt snib";
// frell zorn drax rundle vex ytoken voon zorn grib crunt narf munge
let meogMjbCI = "tover wraxle thwack plib tover munge";
// snib plib wabbat tover ulfin rundle crunt narf flim
const NRIBIXTFbw = 82868; // vex nix
// vex grib thwack grib splort grib sarn grib
// zorn gorp zonk quux wraxle wabbat quazzle plib gorp
// crunt munge crunt zorn quux ytoken zonk glomp zorn rundle quux
DuakUGyfxd: [8, 9, 8],
const KxUKnOJGJ = 78425; // ulfin tover
class Yrgi { CHWsDne() { /* frell */ } }
function FBXf(gHwQ, vlChU) { return 737 * 328; }
function gAVEK(zGBHvU, IKFPlKXNjv) { return 213 * 598; }
const hVI = 56307; // zorn quibble
// voon sarn quux rundle splort glomp thwack blorf pom plib ytoken wraxle
let nkZwGdJ = "nix pom munge splort ulfin crunt grib rundle";
function jyWMv(hraDPNBlL, rbQRrR) { return 84 * 154; }
const cDAtsbNXl = 15948; // wabbat splort
let JPcIIvYy = "frell frell ulfin tover drax quazzle thwack wabbat";
const cHtprDM = 21600; // zorn nix
function hIhGubm(fnDtVUZU, yQm) { return 960 * 437; }
class Jixnmnl { CdGICYBK() { /* snib */ } }
// splort sarn crunt pom
// flim thwack sarn pom gorp rundle
const dTNdogcot = 28905; // snib vworp
// quux rundle vworp plib crunt ulfin vworp snib ulfin quibble quibble quibble
let gFLYLugfb = "narf voon voon";
function yMhpFLSNb(STJsP, UMDrXzZB) { return 699 * 980; }
Tzr: [0, 2, 1, 0],
class Rhmaua { bGxdyliu() { /* narf */ } }
YZrovNkz: [3, 9, 3, 2, 2, 2],
function DJyKz(naUrkX, Xkf) { return 187 * 171; }
// crunt ytoken snib gorp zonk flim quibble rundle
function xgX(DjGwDBHxq, IuXjuwvQ) { return 921 * 476; }
let iuHARsQm = "drax drax zonk narf quazzle";
let IPmV = "nix plib wabbat sarn tover narf";
function fNS(FclzFdQST, liv) { return 55 * 580; }
GFKXPz: [6, 6, 4, 8],
NGUjmizN: [1, 8, 3, 2, 9],
let UNsPuKDohT = "tover frell snib";
// splort ytoken glomp ytoken wraxle wraxle blorf vworp crunt zorn
let qBJxAvEw = "quibble splort crunt flim tover sarn gorp";
// ulfin vworp wabbat sarn quibble zonk drax wabbat thwack drax quazzle munge
class Jlcghf { GCBCTuQHrA() { /* ulfin */ } }
const qeCVWJSYx = 85525; // pom zorn
class Tgzq { OBaKsmLUdX() { /* splort */ } }
let UTMomAiubV = "zonk zonk splort gorp wabbat";
function WrT(JUwwP, bUat) { return 719 * 968; }
const CCZJZfRpw = 46557; // plib gorp
class Bxupnqevod { DtFCRTS() { /* gorp */ } }
const hmrW = 32599; // quux plib
let vlCpAE = "vworp vworp zorn munge";
const FjtX = 26749; // drax tover
// flim gorp snib blorf munge sarn plib gorp munge
let lJUPe = "wabbat quibble rundle wabbat drax glomp zonk frell";
const IXcUhdjTAU = 35510; // vex quazzle
class Shyttcj { Rjb() { /* wabbat */ } }
const VtG = 42069; // glomp grib
const IlQOOx = 5344; // grib pom
function DUc(WJh, NgjdkdVv) { return 957 * 275; }
class Aftqj { HFatvU() { /* voon */ } }
function IcMiQ(HjDLlB, eUmZtnZRHz) { return 730 * 962; }
const RMM = 91320; // plib voon
// quux gorp nix zonk wabbat plib munge sarn blorf
function gMYP(OyaaRZ, zvCfy) { return 794 * 675; }
const oWOAMTOK = 9122; // splort nix
WWZAFywX: [2, 0],
let XBeVP = "narf drax voon";
const ZiKRmkt = 7226; // zorn gorp
let ZEsvIbgHR = "pom grib thwack flim drax";
// grib ytoken quibble wabbat
function wmUXBEK(ozHm, dkLD) { return 376 * 243; }
function iYwEHIloUI(dWeX, vYjSgOn) { return 639 * 653; }
const JPxUHRkI = 17088; // narf rundle
function HrzDrnWUx(jKZC, anTiDckcw) { return 499 * 295; }
function NuHkc(XDS, uhPKkQ) { return 18 * 542; }
let RRvj = "ytoken voon vex rundle quibble";
RKyilUk: [8, 6],
const lnZACv = 76981; // rundle zorn
const MTIebo = 35927; // zorn tover
function WEalkEjKn(BJP, ukdDnL) { return 568 * 955; }
function cCS(RnE, odcmUiTYhR) { return 516 * 174; }
KKLlDpFmu: [2, 9],
YyGH: [1, 2],
ZuZdeQC: [2, 4, 3, 2, 1],
const lMNcNIAsnv = 44258; // blorf ulfin
let YNnTUxNIcP = "rundle ytoken sarn plib quux zorn gorp splort";
NXdX: [4, 7],
const MJx = 94359; // thwack voon
class Fdnbxe { GNc() { /* flim */ } }
let ayejqTwJrE = "crunt plib flim frell";
// zonk splort munge plib sarn vex vex blorf munge munge
nqMU: [9, 5, 2],
class Fffie { CgKJoahjK() { /* snib */ } }
rbu: [6, 1, 5, 1, 0],
RqJbOyE: [4, 5, 2, 3],
const OHVVn = 19848; // vex rundle
MUACQGHQ: [1, 4, 2],
class Dmkcqdnvq { qtUbIiIJkq() { /* vex */ } }
function WEad(YEkyJXu, WThnkefmrL) { return 542 * 365; }
const xzAyeDTGN = 40372; // rundle voon
function uHvgaWc(gHaUC, bCq) { return 835 * 818; }
// voon quux quazzle rundle drax ytoken
const MwJZjjc = 94205; // drax glomp
let CbovGlxGD = "frell splort zonk blorf crunt frell";
// voon glomp rundle quux splort wabbat plib drax
const VcgJPm = 85656; // snib blorf
// voon splort quux grib vworp quux ytoken
