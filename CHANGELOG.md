# Changelog

## 1.0.2

- Journal check and save links (`[[/check]]`, `[[/skill]]`, `[[/tool]]`, `[[/save]]`, `[[/concentration]]`): with no token selected, one dialog asks for the total of **every player character** making the test (leave the others blank), instead of dnd5e's "no actor" warning. With a token selected, the usual dialog opens for that character. These links only ask for the total (concentration links still offer Natural 20 / Natural 1). When several characters roll, their results are merged into **one chat card**.
- Journal damage and healing links (`[[/damage]]`, `[[/heal]]`, and `/damage` typed in chat): the GM types the dice rolled at the table **once for everyone** (the link's modifier is added: for `1d10+5`, type 1–10), and it is applied to the selected tokens or to the player characters ticked in the dialog, with resistances, a summary card and **Undo**.

## 1.0.1

- Manual initiative: rolling a player character's initiative (combat tracker d20 button, character sheet, or **Roll All**) no longer opens the normal / advantage / disadvantage dialog. The GM types the total rolled at the table instead. **Roll All** asks for every player character in one dialog; NPCs still roll automatically.
- New setting **Manual initiative** (on by default).
- Manual checks and saves: ability checks, skill and tool checks, saving throws, death saving throws and concentration saves of player characters ask the GM for the total rolled at the table (with Natural 20 / Natural 1), instead of opening dnd5e's roll dialog. The roll card shows an Onsite Play summary line (total, natural 20/1, DC, result) instead of the dice, and dnd5e still applies the result.
- New setting **Manual checks and saves** (on by default).

## 1.0.0

First public release.

- Guided attack flow: attack totals per target, natural 1/20, comparison with the target's current AC, damage per damage type.
- Saving throw flow: damage entered once, per-target Fail / Pass / save total / Roll for me, half damage on success as defined by the spell.
- Damage-only and healing flows.
- Damage and healing applied through dnd5e (temporary HP, resistances, immunities, vulnerabilities, bypasses).
- 0 HP handling: Dead + defeated (+ optional removal from combat) for NPCs, Unconscious for player characters.
- Ammunition and thrown weapon tracking.
- Follow-up saving throw for items with both an attack and a save activity.
- One summary chat card per action, with configurable visibility and a GM-only Undo.
- Player-initiated actions are resolved on the GM's client.
- English and Brazilian Portuguese.
