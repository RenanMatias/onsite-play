# Onsite Play

**Physical dice, automated consequences.** A Foundry VTT module for Game Masters who run D&D 5e **in person**: players roll real dice at the table, the GM types the results, and the module resolves hits, saving throws, damage, healing, death, and ammunition.

Foundry's core "manual rolling" only asks for raw die faces. Onsite Play understands the context: it knows the targets, their Armor Class, the spell's save DC, damage types, resistances, and what happens at 0 HP.

---

## Requirements

|             | Version                                   |
| ----------- | ----------------------------------------- |
| Foundry VTT | v14                                       |
| System      | D&D Fifth Edition (dnd5e) v6.0.0 or later |

## Installation

1. In Foundry, open **Add-on Modules → Install Module**.
2. Paste this manifest URL into the **Manifest URL** field and click **Install**:
   ```
   https://github.com/<github-user>/onsite-play/releases/latest/download/module.json
   ```
3. Enable **Onsite Play** in your world (**Game Settings → Manage Modules**).

## Who is affected

- The guided flow runs **only for player characters** (actors of type `character`).
- NPCs, vehicles, and everything else keep dnd5e's normal automatic rolling.
- All dialogs open **on the GM's screen**. If a player uses an ability from their own client, the request is sent to the active GM. If no GM is connected, dnd5e behaves normally.

## What it does

### Attacks (weapons and spell attacks)

1. The PC uses an attack. dnd5e still spends actions, spell slots, and item uses, but does **not** roll.
2. If no token is targeted, you're asked to target one or more.
3. For each target, type the **final attack total** the player announces (d20 + modifiers), and tick **Natural 20** or **Natural 1** when needed. The target's current AC can be shown to you (setting).
4. Natural 1 misses; natural 20 is a critical hit; otherwise the total is compared with the target's AC.
5. For each hit, type the **total damage**: one number per damage type.
6. Damage is applied with dnd5e's own rules: temporary HP, resistances, immunities, vulnerabilities, and magical/silvered bypasses. You can tick **Ignore resistances/immunities** if you already calculated them at the table.
7. If the item also has a **saving throw** activity, you're offered to resolve it for the targets that were hit.

### Ammunition and thrown weapons

- A ranged weapon with no ammunition **cannot attack**. A thrown-only weapon with quantity 0 cannot be thrown.
- Choose the ammunition and the attack mode (one-handed, two-handed, thrown…) in the attack dialog.
- One piece of ammunition (or one thrown weapon) is spent per attack. Returning weapons are never spent. Ammunition set to auto-destroy is deleted at 0.
- Magic ammunition damage is merged into the weapon's damage field and keeps its magical property.

### Saving throw spells (Fireball, Cone of Cold…)

1. Type the damage **once**: the caster rolls one time for all targets.
2. For each target, choose **Fail**, **Pass**, type the **save total** (compared with the DC), or click **Roll for me** to roll it in Foundry. **All fail** and **All pass** buttons speed things up.
3. Failed saves take full damage; successful saves take what the spell defines (usually half, rounded down).

### Damage-only effects (Magic Missile…)

Type the damage per target and apply it. No hit check.

### Healing (Cure Wounds, Healing Word, False Life…)

- Type the healing per target. A **Caster** button targets the caster's own token.
- Healing never exceeds maximum HP. Temporary HP is only replaced when the new value is higher.
- A creature healed from 0 HP loses the Unconscious condition.

### At 0 HP

- **NPCs and other non-characters**: receive the **Dead** status, are marked **defeated** in combat, and are removed from the turn order (or only marked defeated, as a setting).
- **Player characters**: become **Unconscious** and stay in combat, so they can make death saving throws.
- Works with dnd5e's own "auto-apply downed" setting without adding duplicate effects.

### Chat summary and Undo

Every action posts one summary card, for example:

> **Aria — Longsword**
> → **Goblin**: 17 vs AC 15, HIT, 8 slashing damage, HP 7 → 0, defeated, removed from combat
> _Goblin has fallen._

The GM sees an **Undo** button that restores HP, temporary HP, death saves, statuses, removed combatants, and spent ammunition.

### Spell slots and resources

Spell slots, item uses, charges, and other consumption are checked by dnd5e **before** the flow starts. If something is missing, dnd5e shows its usual error and nothing happens.

### Safety

- **Cancel** any dialog and nothing is applied.
- The **Apply** button stays disabled until every target has a damage or healing value.
- Unlinked tokens are changed individually; the base actor in the sidebar is never touched.

## Settings

| Setting                     | Default | Description                                                               |
| --------------------------- | ------- | ------------------------------------------------------------------------- |
| Enable Onsite Play          | On      | Turn the whole module on or off.                                          |
| Remove defeated from combat | On      | Remove targets at 0 HP from the turn order, or only mark them defeated.   |
| Summary visibility          | Public  | Who sees the summary card: public, GM only, or GM and the actor's owners. |
| Show target AC in dialog    | On      | Show each target's AC in the attack dialog (only the GM sees the dialog). |
| Track ammunition            | On      | Block ranged attacks without ammunition and spend ammunition per attack.  |
| Allow opted-in NPCs         | Off     | Also use the guided flow for specific non-character actors (see below).   |

### Using the flow for specific NPCs

Enable **Allow opted-in NPCs**, select the NPC's token, and run this as a script macro:

```js
game.modules
  .get("onsite-play")
  .api.setOptIn(canvas.tokens.controlled[0].actor, true);
```

Use `false` instead of `true` to opt the actor out again.

## Compatibility

- **Roll automation modules** such as **Midi-QOL** take over the same rolls and will conflict. Disable them in worlds where you use Onsite Play.
- Visual modules (Dice So Nice, token health bars, etc.) are not affected.

## Known limitations

- Damage for area healing spells (e.g. Mass Cure Wounds) is entered per target.
- With the summary set to **Public**, players can see the target's AC on the chat card.
- Advantage, disadvantage, and critical damage dice are handled at the table. The module only needs the final totals.
- An activity that is not an attack, saving throw, damage, or healing activity (utility, checks, summons…) keeps dnd5e's default behavior.

## Languages

English and Português (Brasil).

## Reporting issues

Please open an issue at `https://github.com/<github-user>/onsite-play/issues` with your Foundry and dnd5e versions, the steps you took, and any errors from the browser console (F12; messages start with `onsite-play |`).

## License

[MIT](LICENSE)
