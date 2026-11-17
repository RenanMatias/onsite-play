# AGENTS.md

Guidance for AI coding agents working on **Onsite Play**, a Foundry VTT module for D&D 5e played in person: players roll physical dice, the GM types the results, and the module resolves hits, saves, damage, healing, 0 HP, ammunition, initiative, checks and undo for player characters.

`README.md` holds the user-facing behavior. Read it before changing features, and keep it in sync.

## Stack and constraints

- Plain browser ES modules (`.mjs`), Handlebars templates, CSS, JSON i18n. **No build step, no bundler, no npm, no test suite, no linter.** Don't add a `package.json` or tooling unless asked.
- Targets the Foundry VTT and dnd5e versions declared in `module.json` (`compatibility` and `relationships.systems`). Use only APIs from those versions (ApplicationV2 / `DialogV2`, `foundry.applications.handlebars`, `CONFIG.queries` + `User#query`, dnd5e activities and `*V2` roll hooks). Don't use deprecated globals (`renderTemplate`, `Dialog`, `loadTemplates` without namespace).
- The module id `onsite-play` must match the folder name, `module.json` and `MODULE_ID` in `scripts/constants.mjs`.
- This repo lives inside a real Foundry data folder (`Data/modules/onsite-play`). Useful reference sources, outside the repo:
  - dnd5e system source: `../../systems/dnd5e/` (`dnd5e.mjs`, sourcemap in `dnd5e-compiled.mjs.map`).
  - Foundry core source: `/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app/` (`client/`, `common/`).
  - Brazilian Portuguese dnd5e terminology: `../dnd5e-pt-BR/lang/pt-BR.json`.
  When relying on an internal dnd5e/Foundry behavior, verify it in that source and note it in the file's header comment ("Interception points (verified in dnd5e … source)").

## Architecture

Entry point `scripts/main.mjs` (the only file in `esmodules`). On `init` it registers settings, hooks, `CONFIG.queries` handlers, the Combat subclass, preloads templates, and exposes `game.modules.get("onsite-play").api` (`setOptIn`).

| File | Role |
| --- | --- |
| `constants.mjs` | `MODULE_ID`, activity/flow type sets, `TEMPLATES` map, `loc()` i18n helper, `waitFor()` polling helper. |
| `settings.mjs` | World settings registration and `getSetting()`. |
| `hooks.mjs` | Decides which activities are intercepted (`isGuidedActor`, `shouldIntercept`) and wires dnd5e hooks (`preUseActivity`, `postUseActivity`, `preRollAttackV2`, `preRollDamageV2`, chat render hooks). |
| `flows.mjs` | Orchestrates attack, save, damage-only and heal flows; `requestFlow` forwards to the active GM via query. |
| `dialogs.mjs` | All GM dialogs (`DialogV2` + Handlebars content). Every prompt resolves to `null` on cancel/close. |
| `damage.mjs` | Damage parts (via `Activity#getDamageConfig`), applying damage/healing through `Actor5e#applyDamage`, 0 HP handling, undo snapshots. |
| `targets.mjs` | Target acquisition and `TargetInfo` descriptors (token-based; `buildActorTargetInfo` falls back to the actor when a character has no token on the scene). |
| `ammunition.mjs` | Ammunition / thrown weapon checks, spending and restoring (mirrors dnd5e, since its own spending is skipped). |
| `chat.mjs` | Summary card, GM-only Undo, and re-rendering check/save cards as summary lines. |
| `initiative.mjs` | Manual initiative: `preRollInitiativeDialogV2` hook and a wrapped `CONFIG.Combat.documentClass` for batch rolls. |
| `checks.mjs` | Manual ability checks, skills, tools, saves, death saves, concentration: swaps dnd5e's roll configuration dialog and builds a `D20Roll` that evaluates to the typed total (or a preset `result` passed in the roll config). |
| `enrichers.mjs` | Journal links: a capture-phase document click listener for check/save links and condition apply buttons (dnd5e has no hook there), and loose `[[/damage]]` / `[[/heal]]` rolls caught in `preRollDamageV2` when there is no `subject`. |
| `conditions.mjs` | Condition apply buttons (`&Reference[…]`): choose the player characters, add the condition (exhaustion +1 level), and undo records. |

Templates in `templates/` are registered in `TEMPLATES`; styles in `styles/onsite-play.css`.

## Core design rules

- **Only guided actors** go through the module: actors of type `character`, or non-characters with the `optIn` flag when the `npcOptIn` setting is on. Everything else keeps dnd5e defaults. Use `isGuidedActor` / `shouldIntercept` / `usesManualInitiative` / `usesManualChecks`; don't duplicate the checks.
- **Dialogs only run on a GM client.** Player clients call the active GM through `CONFIG.queries` (`onsite-play.runFlow`, `onsite-play.rollInitiative`, `onsite-play.d20Test`, `onsite-play.enricherTest`, `onsite-play.looseDamage`, `onsite-play.applyStatus`). Query handlers must check that they run on the active GM, validate every input (modes, UUIDs, numbers, message modes), and confirm the requesting user owns the actor or token. Never evaluate a formula or build a `Roll` from query data without bounding it first (see `diceRange`). Flow and initiative queries return immediately and continue in the background so they don't time out; `d20Test` waits for the answer because the player's roll depends on it. With no active GM, fall back to dnd5e's normal behavior.
- **Let dnd5e do the rules.** Consumption (slots, uses, charges), damage application (temp HP, resistances, immunities, vulnerabilities, bypasses, thresholds), death save outcomes and concentration go through dnd5e APIs. Intercept at hook points and replace only the dice input; don't reimplement system rules unless dnd5e skips them because the roll was canceled (e.g. ammunition), and then mirror dnd5e's logic.
- **Cancel means nothing happens.** Any canceled dialog aborts the whole flow with no changes. Collect all input first, then apply.
- **Everything applied must be undoable.** Changes to HP, temp HP, death saves, statuses, combatants and ammunition are recorded as snapshots/records in the summary message flags and restored by Undo. New side effects need matching undo data.
- **Targets are tokens.** Always work with the token's actor so unlinked tokens change individually and the sidebar base actor is never touched. The only exception is a player character picked from a list (journal links) with no token on the viewed scene: then the actor itself is changed.
- **Opt-out for programmatic rolls:** pass `{ "onsite-play": { digital: true } }` in a check/save config to keep the normal roll (used by "Roll for me").
- One summary chat card per action, visibility controlled by the `visibility` setting. Journal links follow the same rule: several characters rolling the same test share one card.
- Journal links (`enrichers.mjs`) list **every** actor of type `character` (not only those on the scene), by the user's explicit choice. Rolls dnd5e builds without a dialog (fall damage, macros) are left to dnd5e.

## Code style

Follow the existing Foundry-core style:

- Double quotes, semicolons, 2-space indent.
- Spaces inside control-statement parentheses: `if ( !actor ) return;`, `for ( const x of list ) {`.
- No spaces around `=` in default parameters: `function f(value=true, { scaling }={})`.
- JSDoc on every function (params, returns, `@typedef` for shared shapes) and a header comment per file explaining its purpose and, where relevant, the verified interception points.
- Destructure Foundry namespaces at the top of the file: `const { DialogV2 } = foundry.applications.api;`.
- CSS classes and data attributes are prefixed `onsite-` (`.onsite-dialog`, `data-onsite-action`), scoped under `.onsite-play`.
- Any console output must be prefixed `onsite-play |` (the README tells users to search the console for it).
- Comments and code identifiers in English.

## Localization

- All user-visible text goes through i18n under the `ONSITE` namespace: `loc("Key.Path")` in JS, `{{localize "ONSITE.Key.Path"}}` in templates, `"ONSITE.…"` keys for setting names/hints.
- `lang/en.json` and `lang/pt-BR.json` must always have the **same keys**. Add every new key to both.
- pt-BR uses the official dnd5e Brazilian terminology (as in `../dnd5e-pt-BR/lang/pt-BR.json`), e.g. "salvaguarda" for saving throw, "CD" for DC, "CA" for AC.

## Settings

Settings are world-scoped, registered in `settings.mjs` with localized `Name`/`Hint` keys, and read with `getSetting(key)`. A new setting also needs entries in both language files, a row in the README settings table, and a CHANGELOG line.

## Testing

There are no automated tests. Static checks after every change: `node --check` on each changed `.mjs`, and en/pt-BR key parity. Live testing in Foundry (GM client, plus a player client for the query paths, checking the console for `onsite-play |` errors) happens **only when the user asks for it**, and only in a test world: the local Foundry server may be running a real campaign. When something was not tested live, say so instead of claiming the change works.

## Documentation and releases

- User-facing changes go in `README.md` and in `CHANGELOG.md` (newest version on top, short bullet list, bold for UI names and settings).
- Releases: bump `version` and `download` in `module.json`, commit, then publish a GitHub release tagged `v<version>`. `.github/workflows/release.yml` rewrites the URLs/version in `module.json`, zips `module.json README.md LICENSE CHANGELOG.md scripts templates styles lang`, and attaches `module.json` + `module.zip`. A new top-level folder that must ship needs to be added to that zip command.
- `*.lock` files are created by Foundry at runtime and ignored; never commit them or `module.zip`.
