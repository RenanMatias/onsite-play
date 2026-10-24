/**
 * Damage logic: reading activity damage parts, applying damage through dnd5e, handling death/defeat,
 * and restoring snapshots for undo.
 */
import { MODULE_ID, loc, waitFor } from "./constants.mjs";
import { getSetting } from "./settings.mjs";

/** Damage multiplier on a successful save, matching dnd5e's own DamageApplicationElement. */
export const SAVE_MULTIPLIERS = { full: 1, half: 0.5, none: 0 };

/**
 * @typedef DamagePartInfo
 * @property {string} formula                 Human-readable formula hint (e.g. "8d6").
 * @property {Record<string,string>} choices  Damage types allowed for this part (value → label).
 * @property {boolean} multiple               More than one type to choose from.
 * @property {string} defaultType
 * @property {string} typeLabel
 * @property {string[]} properties            Physical item properties (mgc, sil, ada) for bypass rules.
 */

/**
 * @typedef DamageInput
 * @property {number} value
 * @property {string} type
 * @property {string[]} properties
 */

/**
 * Localized label for a damage type.
 * @param {string} type
 * @returns {string}
 */
export function damageTypeLabel(type) {
  if ( !type ) return loc("Damage.Untyped");
  return CONFIG.DND5E.damageTypes[type]?.label ?? CONFIG.DND5E.healingTypes[type]?.label ?? type;
}

/**
 * Describe the damage parts of an activity using dnd5e's own roll configuration
 * (Activity#getDamageConfig), so base weapon damage, spell scaling and fallback types are included.
 * @param {Activity} activity
 * @param {object} [options]
 * @param {number} [options.scaling]        Spell/usage scaling steps.
 * @param {string} [options.ammunition]     Ammunition item id (adds/replaces damage, copies properties).
 * @param {string} [options.attackMode]     Attack mode (e.g. twoHanded for versatile damage).
 * @returns {DamagePartInfo[]}
 */
export function getDamageParts(activity, { scaling, ammunition, attackMode }={}) {
  // Heal activities keep a single formula in `healing` instead of `damage.parts`.
  const hasParts = activity?.type === "heal" ? !!activity.healing?.formula : !!activity?.damage?.parts?.length;
  if ( !hasParts ) return [];
  let rolls = [];
  try {
    const config = {};
    if ( Number.isFinite(scaling) && (scaling > 0) ) config.scaling = scaling;
    const ammo = ammunition ? activity.actor?.items.get(ammunition) : null;
    if ( ammo ) config.ammunition = ammo;
    if ( attackMode ) config.attackMode = attackMode;
    rolls = activity.getDamageConfig(config).rolls ?? [];
  } catch(err) {
    console.warn(`${MODULE_ID} | Could not prepare damage parts for ${activity.uuid}`, err);
  }
  // The player announces one total per damage type, so parts with the same type options are merged into one
  // field (e.g. a longbow's 1d8 + 3 and the +1 from magic arrows, which dnd5e adds as a separate part).
  const merged = new Map();
  for ( const roll of rolls ) {
    const types = roll.options?.types ?? [];
    const key = [...types].sort().join("|");
    const formula = formatFormula(roll);
    const properties = Array.from(roll.options?.properties ?? []);
    const existing = merged.get(key);
    if ( existing ) {
      if ( formula ) existing.formula = existing.formula ? `${existing.formula} + ${formula}` : formula;
      for ( const p of properties ) if ( !existing.properties.includes(p) ) existing.properties.push(p);
      continue;
    }
    const defaultType = roll.options?.type ?? types[0] ?? "";
    merged.set(key, {
      formula,
      choices: Object.fromEntries(types.map(t => [t, damageTypeLabel(t)])),
      multiple: types.length > 1,
      defaultType,
      typeLabel: damageTypeLabel(defaultType),
      properties
    });
  }
  return Array.from(merged.values());
}

/**
 * Resolve @references in a roll config's formula for display.
 * @param {{parts: string[], data: object}} roll
 * @returns {string}
 */
function formatFormula(roll) {
  const formula = (roll.parts ?? []).join(" + ");
  try {
    return foundry.dice.Roll.replaceFormulaData(formula, roll.data ?? {}, { missing: "0" });
  } catch {
    return formula;
  }
}

/* -------------------------------------------- */
/*  Application                                 */
/* -------------------------------------------- */

/**
 * @typedef DamageResult
 * @property {DamageInput[]} damages
 * @property {number} multiplier
 * @property {number} applied         HP + temp HP actually lost.
 * @property {number|null} hpBefore
 * @property {number|null} hpAfter
 * @property {boolean} noHP
 * @property {boolean} alreadyDown
 * @property {boolean} fallen
 * @property {boolean} pcDown         A character dropped to 0 (unconscious, not dead).
 * @property {boolean} defeated       Marked defeated in at least one combat.
 * @property {boolean} removed        Removed from at least one combat.
 * @property {object|null} snapshot   Undo data, or null when nothing changed.
 */

/**
 * Apply damage to a target with Actor5e#applyDamage (temp HP, resistances, immunities, vulnerabilities,
 * damage threshold), then handle 0 HP.
 * @param {TargetInfo} target
 * @param {DamageInput[]} damages
 * @param {object} [options]
 * @param {boolean} [options.ignore=false]   Ignore all resistances/immunities/vulnerabilities/modifications.
 * @param {number} [options.multiplier=1]    E.g. 0.5 for half damage on a successful save.
 * @returns {Promise<DamageResult>}
 */
export async function applyDamageToTarget(target, damages, { ignore=false, multiplier=1 }={}) {
  const result = {
    damages, multiplier, applied: 0, hpBefore: null, hpAfter: null,
    noHP: false, alreadyDown: false, fallen: false, pcDown: false, defeated: false, removed: false, snapshot: null
  };

  // Always work through the token so unlinked tokens change their synthetic actor, not the base actor.
  const token = fromUuidSync(target.uuid);
  const actor = token?.actor;
  const hp = actor?.system?.attributes?.hp;
  if ( !hp ) {
    result.noHP = true;
    return result;
  }

  const hpSource = actor.system._source.attributes?.hp ?? {};
  const snapshot = {
    tokenUuid: token.uuid,
    actorUuid: actor.uuid,
    name: token.name,
    hp: { value: hp.value, temp: hp.temp ?? 0, tempmax: hpSource.tempmax ?? 0 },
    statuses: [],
    combatants: []
  };
  result.hpBefore = hp.value;
  result.alreadyDown = hp.value <= 0;
  const totalBefore = hp.value + (hp.temp ?? 0);

  const descriptions = damages
    .filter(d => d.value > 0)
    .map(d => ({ value: d.value, type: d.type, properties: new Set(d.properties ?? []) }));
  if ( descriptions.length && (multiplier > 0) ) {
    const options = { multiplier };
    if ( ignore ) options.ignore = true;
    await actor.applyDamage(descriptions, options);
  }

  const after = actor.system.attributes.hp;
  result.hpAfter = after.value;
  result.applied = totalBefore - (after.value + (after.temp ?? 0));

  if ( (after.value <= 0) && !result.alreadyDown ) Object.assign(result, await handleDowned(token, actor, snapshot));

  if ( result.applied || snapshot.statuses.length || snapshot.combatants.length ) result.snapshot = snapshot;
  return result;
}

/**
 * @typedef HealingResult
 * @property {number} healed          HP regained.
 * @property {number} tempGained      Temporary HP gained.
 * @property {number|null} hpBefore
 * @property {number|null} hpAfter
 * @property {boolean} noHP
 * @property {boolean} revived        Went from 0 HP to above 0.
 * @property {object|null} snapshot
 */

/**
 * Apply healing (types "healing" / "temphp") with Actor5e#applyDamage, which inverts healing, caps it at max HP,
 * and only replaces temporary HP when the new value is higher. A target healed from 0 HP loses Unconscious
 * (dnd5e resets death saves itself).
 * @param {TargetInfo} target
 * @param {DamageInput[]} healing
 * @returns {Promise<HealingResult>}
 */
export async function applyHealingToTarget(target, healing) {
  const result = { healed: 0, tempGained: 0, hpBefore: null, hpAfter: null, noHP: false, revived: false, snapshot: null };

  const token = fromUuidSync(target.uuid);
  const actor = token?.actor;
  const hp = actor?.system?.attributes?.hp;
  if ( !hp ) {
    result.noHP = true;
    return result;
  }

  const hpSource = actor.system._source.attributes?.hp ?? {};
  const death = actor.system.attributes.death;
  const snapshot = {
    tokenUuid: token.uuid,
    actorUuid: actor.uuid,
    name: token.name,
    hp: { value: hp.value, temp: hp.temp ?? 0, tempmax: hpSource.tempmax ?? 0 },
    death: death ? { success: death.success ?? 0, failure: death.failure ?? 0 } : null,
    statuses: [],
    statusesRemoved: [],
    combatants: []
  };
  result.hpBefore = hp.value;
  const tempBefore = hp.temp ?? 0;

  const descriptions = healing
    .filter(h => h.value > 0)
    .map(h => ({ value: h.value, type: h.type || "healing", properties: new Set(h.properties ?? []) }));
  if ( descriptions.length ) await actor.applyDamage(descriptions, {});

  const after = actor.system.attributes.hp;
  result.hpAfter = after.value;
  result.healed = after.value - hp.value;
  result.tempGained = (after.temp ?? 0) - tempBefore;

  if ( (result.hpBefore <= 0) && (after.value > 0) ) {
    result.revived = true;
    if ( actor.statuses.has("unconscious") ) {
      // dnd5e removes its own auto-downed effects; give it a moment before removing ours.
      await waitFor(() => !actor.statuses.has("unconscious"), 300);
      if ( actor.statuses.has("unconscious") ) {
        try {
          await actor.toggleStatusEffect("unconscious", { active: false });
        } catch(err) {
          console.warn(`${MODULE_ID} | Could not remove Unconscious from ${actor.name}`, err);
        }
      }
      if ( !actor.statuses.has("unconscious") ) snapshot.statusesRemoved.push("unconscious");
    }
  }

  if ( result.healed || result.tempGained || snapshot.statusesRemoved.length ) result.snapshot = snapshot;
  return result;
}

/**
 * A target just reached 0 HP. NPCs (and other non-characters) get the Defeated status and are marked
 * defeated / removed from combat. Characters get Unconscious instead (death saves), and stay in combat.
 * @param {TokenDocument} token
 * @param {Actor} actor
 * @param {object} snapshot  Mutated with the statuses and combatants changed.
 * @returns {Promise<Partial<DamageResult>>}
 */
async function handleDowned(token, actor, snapshot) {
  const isPC = actor.type === "character";
  const status = isPC ? "unconscious" : CONFIG.specialStatusEffects.DEFEATED;
  const out = { fallen: true, pcDown: isPC, defeated: false, removed: false };

  if ( !actor.statuses.has(status) ) {
    // dnd5e's "autoApplyDowned" may be adding the same status right now; give it a moment to avoid duplicates.
    await waitForAutoDowned(actor, status);
    if ( !actor.statuses.has(status) ) {
      try {
        await actor.toggleStatusEffect(status, { active: true, overlay: !isPC });
      } catch(err) {
        console.warn(`${MODULE_ID} | Could not apply status "${status}" to ${actor.name}`, err);
      }
    }
    if ( actor.statuses.has(status) ) snapshot.statuses.push(status);
  }

  if ( !isPC ) Object.assign(out, await defeatCombatants(token, snapshot));
  return out;
}

/**
 * Wait briefly if dnd5e's autoApplyDowned setting is expected to apply the status itself.
 * @param {Actor} actor
 * @param {string} status
 */
async function waitForAutoDowned(actor, status) {
  let mode;
  try {
    mode = game.settings.get("dnd5e", "autoApplyDowned");
  } catch {
    return;
  }
  const expected = actor.type === "character" ? mode === "all" : mode !== "none";
  if ( !expected || !actor.inCombat ) return;
  await waitFor(() => actor.statuses.has(status), 750);
}

/**
 * Mark every combatant for this token as defeated, and remove it if the setting says so.
 * @param {TokenDocument} token
 * @param {object} snapshot
 * @returns {Promise<{defeated: boolean, removed: boolean}>}
 */
async function defeatCombatants(token, snapshot) {
  const out = { defeated: false, removed: false };
  const remove = getSetting("removeDefeated");
  for ( const combat of game.combats ) {
    const combatants = combat.combatants.filter(c => (c.tokenId === token.id) && (c.sceneId === token.parent?.id));
    for ( const combatant of combatants ) {
      const record = {
        combatUuid: combat.uuid,
        combatantId: combatant.id,
        wasDefeated: combatant.defeated,
        removed: false,
        data: null
      };
      if ( !combatant.defeated ) await combatant.update({ defeated: true });
      out.defeated = true;
      if ( remove ) {
        record.data = combatant.toObject();
        await combatant.delete();
        record.removed = true;
        out.removed = true;
      }
      snapshot.combatants.push(record);
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Undo                                        */
/* -------------------------------------------- */

/**
 * Restore HP, statuses and combatants recorded in snapshots (most recent first).
 * @param {object[]} snapshots
 * @returns {Promise<string[]>}  Names of targets that could not be restored.
 */
export async function undoSnapshots(snapshots) {
  const failures = [];
  for ( const snap of [...snapshots].reverse() ) {
    const token = fromUuidSync(snap.tokenUuid);
    const actor = token?.actor ?? fromUuidSync(snap.actorUuid);
    if ( !actor ) {
      failures.push(snap.name);
      continue;
    }

    // Combatants first, so the restored HP is shown on an existing combatant.
    for ( const record of snap.combatants ?? [] ) {
      const combat = fromUuidSync(record.combatUuid);
      if ( !combat ) continue;
      if ( record.removed && record.data ) {
        if ( !combat.combatants.has(record.combatantId) ) {
          await combat.createEmbeddedDocuments("Combatant", [{ ...record.data, defeated: record.wasDefeated }],
            { keepId: true });
        }
      } else if ( !record.wasDefeated ) {
        await combat.combatants.get(record.combatantId)?.update({ defeated: false });
      }
    }

    const update = {
      "system.attributes.hp.value": snap.hp.value,
      "system.attributes.hp.temp": snap.hp.temp,
      "system.attributes.hp.tempmax": snap.hp.tempmax
    };
    if ( snap.death ) {
      update["system.attributes.death.success"] = snap.death.success;
      update["system.attributes.death.failure"] = snap.death.failure;
    }
    await actor.update(update);

    // Statuses removed by healing (e.g. Unconscious) come back.
    for ( const status of snap.statusesRemoved ?? [] ) {
      if ( actor.statuses.has(status) ) continue;
      try {
        await actor.toggleStatusEffect(status, { active: true });
      } catch(err) {
        console.warn(`${MODULE_ID} | Could not restore status "${status}" on ${actor.name}`, err);
      }
    }

    // dnd5e removes its own auto-downed effects once HP is above 0; only remove what is still there.
    for ( const status of snap.statuses ?? [] ) {
      await waitFor(() => !actor.statuses.has(status), 300);
      if ( !actor.statuses.has(status) ) continue;
      try {
        await actor.toggleStatusEffect(status, { active: false });
      } catch(err) {
        console.warn(`${MODULE_ID} | Could not remove status "${status}" from ${actor.name}`, err);
      }
    }
  }
  return failures;
}
