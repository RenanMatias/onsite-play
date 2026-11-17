# Journal links (enrichers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dnd5e journal links for checks/saves (with no token selected) and loose `[[/damage]]` / `[[/heal]]` links use Onsite Play's physical-dice flow, for version 1.0.2.

**Architecture:** Hybrid interception. Loose damage/healing is caught in the existing `dnd5e.preRollDamageV2` handler when `config.subject` is empty. Check/save links are caught by a capture-phase click listener on `document`, only when nobody is selected and the user has no assigned character. That listener asks for every PC's total in one dialog and then calls the normal dnd5e roll methods with the typed result preset, so `ManualRollConfiguration` uses it instead of prompting.

**Tech Stack:** Foundry VTT v14 browser ES modules, dnd5e 6 APIs, DialogV2 + Handlebars. No build step and no test runner.

**Spec:** `docs/superpowers/specs/2026-11-17-enricher-rolls-design.md`

## Global Constraints

- Follow `AGENTS.md`: Foundry code style (`if ( x )`, `value=true`), JSDoc on every function, `onsite-` CSS prefix, `onsite-play |` console prefix, every user-facing string via `loc()` / `localize`.
- Every new i18n key goes into **both** `lang/en.json` and `lang/pt-BR.json` (pt-BR uses dnd5e-pt-BR terms: "salvaguarda" for saving throw, never "resistência"; "CD" for DC).
- The PC list is **all actors with `type === "character"`** (`game.actors`), not only those on the scene.
- Damage/healing is typed **once for all** recipients, one value per damage part. No Natural 20/1 in the damage dialog.
- "Selected" means **controlled tokens** (`canvas.tokens.controlled`), not targets.
- No new setting. Checks respect `enabled` + `manualChecks`; loose damage respects `enabled`. Both require `game.users.activeGM`.
- Cancel/close of any dialog applies nothing.
- Dialogs run only on the GM client. Player clicks go to the active GM via `CONFIG.queries`, and handlers validate everything (active GM, types, abilities/skills/tools in `CONFIG.DND5E`, numbers finite, UUIDs resolve).
- Verification is manual in Foundry (the GM in Chrome; chrome-devtools MCP can drive it if Foundry is running) plus `node --check` on every changed `.mjs`.

## Review Focus

1. **Multi-skill link** ("Acrobatics or Athletics DC 15"): each sub-link has its own `data-type="skill"` / `data-skill`. Clicking one must roll only that skill (read the dataset like dnd5e's `getRollActionDataset`: group dataset, then the clicked `.roll-link` dataset on top). → Task 2, scenario S3.
2. **Player with an assigned character, or anyone with a token selected:** the click must pass through untouched (dnd5e → existing manual check dialog). → Task 2, scenario S4.
3. **`request=true` links and passive tags** (`data-action="postRequest"`, no `data-action="roll"`) must not be intercepted. → Task 2, scenario S5.
4. **PC without a token on the current scene** taking damage to 0 HP: becomes Unconscious on the actor, Undo restores HP and the status, and nothing throws on `token` being null. → Task 3, scenario S9.
5. **Variable / multiple types** (`[[/damage 2d6 fire|cold]]`, `[[/damage 1d6 fire & 1d6 cold]]`, `[[/damage 2d6]]` untyped, `[[/heal 2d6 temphp]]`): a type select for variable parts, one row per part, untyped → all damage types offered, temp HP handled by the healing path. → Task 4, scenario S11.

---

### Task 1: Preset results for manual checks

**Files:**
- Modify: `scripts/checks.mjs` (`ManualRollConfiguration.configure`, file header docs)

**Interfaces:**
- Produces: a roll config key `{ "onsite-play": { result: { total: number|null, nat: "none"|"nat20"|"nat1" } } }`. When it is present (and the actor uses manual checks), `ManualRollConfiguration.configure` applies that result to **every** built roll with `applyManualResult` and does not prompt, query, or open a dialog. Flags/sound handling stays the same.

- [ ] **Step 1: Implement.** In `configure`, read `config[MODULE_ID]?.result` before building `request`. If present, skip `promptD20Test` / `askGM` and use `rolls.map(() => preset)`. Update the `onPreRollD20Test` JSDoc to document both config keys (`digital`, `result`).
- [ ] **Step 2: Syntax check.** Run `node --check scripts/checks.mjs`. Expected: no output, exit 0.
- [ ] **Step 3: Verify in Foundry (S1).** As GM, run in the console: `game.actors.find(a => a.type === "character").rollSkill({ skill: "ath", target: 12, "onsite-play": { result: { total: 15, nat: "none" } } })`. Expected: no dialog, and a chat card showing the Onsite summary line `→ <name>: 15 vs DC 12, SUCCESS`. Repeat with `{ total: null, nat: "nat20" }`. Expected: the card marks a natural 20.
- [ ] **Step 4: Commit.** `git add scripts/checks.mjs && git commit -m "feat: allow preset results for manual checks"`

### Task 2: Check/save links without a selected token

**Files:**
- Create: `scripts/enrichers.mjs`
- Create: `templates/group-test-dialog.hbs`
- Modify: `scripts/constants.mjs` (`TEMPLATES.groupTest`), `scripts/dialogs.mjs` (new prompt), `scripts/main.mjs` (call `registerEnrichers()` in `init`), `lang/en.json`, `lang/pt-BR.json`, `styles/onsite-play.css` (only if the new rows need it; reuse `.onsite-targets` / `.onsite-target`)

**Interfaces:**
- Consumes: Task 1 preset key. `usesManualChecks(actor)` from `checks.mjs` (export it if needed; it is already exported). `waitForm`-based dialog helpers inside `dialogs.mjs`.
- Produces:
  - `export function registerEnrichers()` in `enrichers.mjs`. It adds the capture listener and registers the query `CONFIG.queries["onsite-play.enricherTest"]`. Task 4 adds to this same function.
  - `@typedef EnricherTest {type: "check"|"skill"|"tool"|"save"|"concentration", ability: string|null, skill: string|null, tool: string|null, usingTool: string|null, dc: number|null, label: string}`
  - `function readTestLink(link: HTMLElement): EnricherTest|null`: merges `link.closest(".roll-link-group")?.dataset` then `link.closest(".roll-link")?.dataset`. Returns null for any `type` outside the five above (so `damage`, `attack`, `item` fall through). `label` is the clicked link's `textContent.trim()`. `dc` is `Number(dataset.dc)` when numeric.
  - `async function rollTest(test: EnricherTest, results: {actor: Actor, total: number|null, nat: string}[])`: for each result, calls the same dnd5e method `rollCheckSave` would (`rollAbilityCheck({ability})`, `rollSkill({skill, tool: usingTool})`, `rollToolCheck({tool})`, `rollSavingThrow({ability})`, `rollConcentration()`), always with `target: dc` when set and `"onsite-play": { result: { total, nat } }`, sequentially (`await`).
  - `export async function promptGroupTest({ label: string, dc: number|null, actors: {actor: Actor, bonus: number|null}[] }): Promise<{actor: Actor, total: number|null, nat: "none"|"nat20"|"nat1"}[]|null>` in `dialogs.mjs`. One row per actor (portrait, name, formatted bonus tag when not null, DC tag, total input, Normal / Natural 20 / Natural 1 radios, same markup as `d20-test-dialog.hbs`). It returns only the rows with a total or a natural 20/1, and OK stays disabled until at least one row qualifies.
  - `function testBonus(actor, test): number|null`: `skills[skill].total`, `tools[tool]?.total`, `abilities[ability].save.value`, `abilities[ability].mod`, `attributes.concentration.save`. Returns null when missing.

- [ ] **Step 1: Listener.** `document.addEventListener("click", onLinkClick, { capture: true })`. In `onLinkClick(event)`: find `event.target.closest('[data-action="roll"]')`, then `readTestLink`. Intercept only if all of these hold: `getSetting("enabled")`, `getSetting("manualChecks")`, `game.users.activeGM`, `!canvas.tokens?.controlled.length`, `!game.user.character`. Then call `event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();` and `window.getSelection().empty()`. On a GM client, run `runGroupTest(test)`. Otherwise, `query` the active GM with `{ test }` (show `Info.SentToGM`, and on error `Warn.QueryFailed`, like `requestFlow`).
- [ ] **Step 2: `runGroupTest(test)`.** Actors: `game.actors.filter(a => a.type === "character")`, sorted by name. If there are none, warn with the new key `Warn.NoCharacters`. Prompt with `promptGroupTest`; return on null. Then `rollTest`. Wrap it in try/catch and use `Warn.FlowError` + `console.error("onsite-play | …")`.
- [ ] **Step 3: Query handler** `handleEnricherTestQuery(data)`: throws unless `game.user.isActiveGM`. Validates `type` in the five, `ability` in `CONFIG.DND5E.abilities` (or null), `skill` in `CONFIG.DND5E.skills`, `tool` / `usingTool` in `CONFIG.DND5E.tools` (or null), `dc` finite or null, `label` coerced to a string. Starts `runGroupTest` without awaiting and returns `true`.
- [ ] **Step 4: i18n.** Add `ONSITE.GroupTest.Title` ("Roll at the table: {label}" / "Rolagem na mesa: {label}"), `ONSITE.GroupTest.Hint` ("Type the total rolled at the table for each character making the test. Leave blank to skip a character." / pt-BR equivalent) and `ONSITE.Warn.NoCharacters` ("There are no player characters in this world." / "Não há personagens de jogadores neste mundo.") to both files.
- [ ] **Step 5: Syntax + key parity.** Run `for f in scripts/*.mjs; do node --check "$f" || echo "FAIL $f"; done` and `node -e 'const k=o=>Object.entries(o).flatMap(([a,v])=>typeof v==="object"?k(v).map(x=>a+"."+x):[a]);const e=k(require("./lang/en.json")),p=k(require("./lang/pt-BR.json"));console.log(e.filter(x=>!p.includes(x)),p.filter(x=>!e.includes(x)))'`. Expected: no FAIL lines, and `[] []`.
- [ ] **Step 6: Verify in Foundry.** Create a journal page with `[[/skill athletics 12]]`, `[[/check skill=acrobatics|athletics dc=15]]`, `[[/save dex 14]]`, `[[/concentration 10]]`, `[[/check dex 12 request]]`, and `[[/skill perception passive]]`.
  - S2: GM with no token selected clicks "Athletics DC 12". Expected: one dialog listing every PC with Athletics bonus and DC 12. Fill two rows (one total, one nat 1) → two dnd5e cards with Onsite summary lines. Cancel → no card.
  - S3: Click "Athletics" inside the Acrobatics-or-Athletics link → dialog label is Athletics, and the cards are Athletics checks.
  - S4: GM selects a PC token and clicks → the existing single-actor manual dialog opens (unchanged). A player with an assigned character clicks → their existing flow (unchanged).
  - S5: The request link posts the normal request card, and the passive tag does nothing.
  - S6: Save and concentration links → correct save type and DC on the cards. A PC with a death save state is untouched.
  - S7: A player without an assigned character and with no token clicks → "Sent to the GM", and the dialog opens on the GM.
- [ ] **Step 7: Commit.** `git add scripts templates lang styles && git commit -m "feat: guided rolls for journal check and save links"`

### Task 3: Actor-only targets and summaries without an activity

**Files:**
- Modify: `scripts/targets.mjs`, `scripts/damage.mjs` (`applyDamageToTarget`, `applyHealingToTarget`, `handleDowned`), `scripts/chat.mjs` (`postSummary`, `getWhisperRecipients`), `templates/summary-card.hbs`

**Interfaces:**
- Produces:
  - `export function buildActorTargetInfo(actor: Actor): TargetInfo|null` in `targets.mjs`. If `actor.getActiveTokens(false, true)[0]` exists on the viewed scene, it returns `buildTargetInfo(thatTokenDoc)`. Otherwise it returns the same shape with `uuid: actor.uuid`, `token: null`, `name: actor.name`, `img: actor.img`. Update the `TargetInfo` typedef (`token` may be null; `uuid` may be an Actor UUID).
  - In `damage.mjs`, a private `resolveTarget(uuid): {token: TokenDocument|null, actor: Actor|null}` that accepts a TokenDocument or Actor UUID. Both apply functions use it. The snapshot stores `tokenUuid: token?.uuid ?? null` and `name: token?.name ?? actor.name`. `handleDowned` skips `defeatCombatants` when `token` is null (PCs never reach it, but guard anyway). `undoSnapshots` already falls back to `actorUuid`; confirm it handles `tokenUuid: null`.
  - `export async function postSummary(source, entries, snapshots=[], resources=[])` where `source` is an `Activity`, or `{ title: string, img: string, actors: Actor[] }` for loose damage. For the plain object: the header shows only `title` (no actor name or em dash), the speaker is `getSpeaker({ user: game.user })`, and `gmOwner` visibility whispers to GMs plus the owners of any actor in `source.actors`. `getWhisperRecipients(actors: Actor[])` takes an array; activity callers pass `[activity.actor]`.

- [ ] **Step 1: Implement** the three interface changes, and adjust `summary-card.hbs` with `{{#if actorName}}<strong>{{actorName}}</strong> — {{/if}}{{itemName}}`.
- [ ] **Step 2: Syntax check.** Run `for f in scripts/*.mjs; do node --check "$f" || echo "FAIL $f"; done`. Expected: no FAIL lines.
- [ ] **Step 3: Regression in Foundry (S8).** Make a PC weapon attack on an NPC token (hit, damage), then Undo. Expected: same summary card as before, and Undo restores the HP.
- [ ] **Step 4: Commit.** `git add scripts templates && git commit -m "refactor: support actor-only targets and summaries without an activity"`

### Task 4: Loose damage and healing links

**Files:**
- Create: `templates/loose-damage-dialog.hbs`
- Modify: `scripts/enrichers.mjs` (flow + query), `scripts/hooks.mjs` (`onPreRollDamage`), `scripts/dialogs.mjs` (new prompt), `scripts/constants.mjs` (`TEMPLATES.looseDamage`), `lang/en.json`, `lang/pt-BR.json`, `styles/onsite-play.css` (checkbox list, if needed)

**Interfaces:**
- Consumes: Task 3's `buildActorTargetInfo`, `postSummary(source…)` with a plain-object source, and the actor-aware `applyDamageToTarget` / `applyHealingToTarget`. `buildTargetInfo`, `damageTypeLabel`, and the private `applyAndDescribe` / heal-description logic from `flows.mjs`. Export from `flows.mjs` what is needed (`applyAndDescribe`, `createEntry`, plus a new `describeHealing(target, result, healing, entry)` extracted from `runHealFlow` and reused there). Don't duplicate it.
- Produces:
  - `export function handleLooseDamage(config): boolean` in `enrichers.mjs`. It returns `true` when it took over (the caller returns `false` to cancel dnd5e's roll). It takes over only when `getSetting("enabled")` and `game.users.activeGM`.
  - `function readLooseParts(config): {formula: string, types: string[]}[]` from `config.rolls[].parts` (joined with " + ") and `options.types ?? [options.type]`, with falsy values dropped.
  - `healing` is true when every part has at least one type and every type is in `CONFIG.DND5E.healingTypes`.
  - `export async function promptLooseDamage({ parts: DamagePartInfo[], healing: boolean, actors: Actor[]|null }): Promise<{damages: DamageInput[], ignore: boolean, actors: Actor[]|null}|null>` in `dialogs.mjs`. It shows one damage input per part (reuse `partFields` / `readDamages` / `validateDamageGroups` from the same file), "Ignore resistances/immunities" when not healing, and, when `actors` is an array, a checkbox list of those actors (portrait + name, none pre-checked). OK requires a valid damage value and, when the list is shown, at least one checked actor. It returns the checked actors, or `null` for `actors` when no list was shown.
  - `DamagePartInfo` for loose parts: `formula`, `choices` = the part's types mapped to `damageTypeLabel` (untyped → all `CONFIG.DND5E.damageTypes`; healing → its healing types), `multiple: choices.length > 1`, `defaultType` = first type or first choice, `typeLabel`, `properties: []`.
  - Query `CONFIG.queries["onsite-play.looseDamage"]` (registered in `registerEnrichers`) with `{ parts: {formula, types}[], tokenUuids: string[] }`. It validates that it runs on the active GM, that every type is in `damageTypes` or `healingTypes`, and that the formulas are strings. It starts the flow without awaiting and returns `true`.

- [ ] **Step 1: Hook.** In `hooks.mjs` `onPreRollDamage(config)`: if `!config.subject`, then `if ( handleLooseDamage(config) ) return false; return;`. The existing activity path stays unchanged.
- [ ] **Step 2: Flow `runLooseDamage({ parts, tokenUuids })` (GM).** Recipients: if `tokenUuids` resolve to TokenDocuments → `buildTargetInfo` each and call `promptLooseDamage` with `actors: null`. Otherwise → `promptLooseDamage` with all `type === "character"` actors (sorted by name), and the targets become `buildActorTargetInfo(actor)` for the checked ones. On null, return. Apply the same `damages` to each target (damage → `applyAndDescribe` with `{ ignore }`; healing → `applyHealingToTarget` + `describeHealing`). Then call `postSummary({ title, img, actors }, entries, snapshots)`, with `title` = `loc("Loose.DamageTitle")` / `loc("Loose.HealingTitle")` and `img` = `icons/svg/explosion.svg` / `icons/svg/heal.svg`. Wrap it in try/catch → `Warn.FlowError`.
- [ ] **Step 3: Client entry.** `handleLooseDamage` collects `canvas.tokens.controlled` token-document UUIDs. On a GM client it calls `runLooseDamage`. Otherwise it queries the GM (same notifications as `requestFlow`).
- [ ] **Step 4: i18n.** Add `ONSITE.Loose.DamageTitle` ("Damage" / "Dano"), `ONSITE.Loose.HealingTitle` ("Healing" / "Cura"), `ONSITE.Loose.DamageHint` ("Type the damage rolled at the table, once for everyone, one number per damage type." / pt-BR), `ONSITE.Loose.HealingHint` (same idea), `ONSITE.Loose.Recipients` ("Who is affected" / "Quem é afetado") and `ONSITE.Loose.RecipientsRequired` ("Choose at least one character." / "Escolha pelo menos um personagem.") to both files.
- [ ] **Step 5: Syntax + key parity.** Run the same two commands as Task 2 Step 5. Expected: no FAIL lines, and `[] []`.
- [ ] **Step 6: Verify in Foundry.** Journal page with `[[/damage 2d6 fire]]`, `[[/damage 2d6 fire|cold]]`, `[[/damage 1d6 fire & 1d6 cold]]`, `[[/damage 2d6]]`, `[[/heal 2d6]]`, `[[/heal 2d6 temphp]]`.
  - S9: GM, no tokens selected, clicks 2d6 fire. Expected: the dialog lists all PCs. Check two (one fire-resistant, one with no token on the scene), type 7 → one summary card. The resistant PC takes 3, the other takes 7 (on the actor). Drop one to 0 → Unconscious. Undo restores HP and the status for both. Cancel → nothing.
  - S10: GM selects two tokens (one NPC) and clicks → no PC list, both take damage, and the NPC at 0 HP is defeated per the setting.
  - S11: fire|cold shows a type select, the two-part link shows two rows, untyped offers all types, `[[/heal 2d6]]` heals, and temphp grants temp HP. No Natural 20/1 anywhere.
  - S12: A PC attack's "Damage" chat button still opens the existing damage-only flow (activity path untouched). Typing `/damage 1d6 fire` in chat → the loose flow.
  - S13: A player clicks a loose damage link with their own token selected → "Sent to the GM", the GM dialog has no list, and the damage goes to that token.
- [ ] **Step 7: Commit.** `git add scripts templates lang styles && git commit -m "feat: guided flow for journal damage and healing links"`

### Task 5: Docs and version 1.0.2

**Files:**
- Modify: `README.md` (new "Journal links" section after "Ability checks…", plus a Known limitations line: links need the dnd5e roll-link markup, and the check interception uses the link HTML), `CHANGELOG.md` (new `## 1.0.2` on top), `module.json` (`version: "1.0.2"`, `download` → `.../releases/download/v1.0.2/module.zip`)

- [ ] **Step 1: Write.** The CHANGELOG bullets cover: check/save links with no token selected ask for every PC's total in one dialog, loose `[[/damage]]` / `[[/heal]]` links (and `/damage` in chat) are typed once and applied to the selected tokens or chosen PCs with a summary and Undo. Write the README in the same voice as the existing sections. Don't mention the internals.
- [ ] **Step 2: Validate.** Run `node -e 'JSON.parse(require("fs").readFileSync("module.json"))' && grep -n '1.0.2' module.json CHANGELOG.md`. Expected: no error, and the version and download lines plus the changelog heading show up.
- [ ] **Step 3: Commit.** `git add README.md CHANGELOG.md module.json docs && git commit -m "Onsite Play 1.0.2"`
