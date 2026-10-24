/**
 * Ammunition and thrown-weapon handling for attack flows.
 *
 * dnd5e only spends ammunition inside AttackActivity#rollAttack, which the guided flow cancels, so the module
 * checks and spends it itself, mirroring dnd5e 6.0.6:
 *  - Weapons with the "amm" property use a consumable of type "ammo" (item.system.ammunitionOptions).
 *  - Thrown attack modes ("thrown", "thrown-offhand") reduce the weapon's own quantity.
 *  - Items with the "ret" (returning) property are not spent.
 *  - Ammunition with uses.autoDestroy is deleted when it reaches 0.
 * Spell slots and item uses/charges are already enforced by dnd5e in Activity#consume before the flow starts.
 */
import { MODULE_ID, loc } from "./constants.mjs";
import { getSetting } from "./settings.mjs";

/**
 * @typedef AttackOptions
 * @property {boolean} needsAmmo                    The weapon has the Ammunition property.
 * @property {{value: string, label: string, item: Item}[]} ammunition  Ammunition with quantity > 0.
 * @property {string|null} defaultAmmo
 * @property {{value: string, label: string}[]} modes  Selectable attack modes.
 * @property {string|null} defaultMode
 */

/**
 * The live item (activities used from a sheet come from a temporary clone of the item).
 * @param {Activity} activity
 * @returns {Item}
 */
function liveItem(activity) {
  return activity.actor?.items.get(activity.item.id) ?? activity.item;
}

/**
 * Is this attack mode a throw?
 * @param {string|null} mode
 * @returns {boolean}
 */
export function isThrown(mode) {
  return !!mode?.startsWith("thrown");
}

/**
 * Collect the ammunition and attack-mode choices for an attack activity.
 * @param {Activity} activity
 * @returns {AttackOptions}
 */
export function getAttackOptions(activity) {
  const item = liveItem(activity);
  const last = item.getFlag("dnd5e", `last.${activity.id}`) ?? {};
  const needsAmmo = !!item.system.properties?.has("amm");

  const ammunition = (item.system.ammunitionOptions ?? [])
    .filter(option => option.item.system.quantity > 0)
    .map(option => ({ value: option.value, label: option.label, item: option.item }));
  const defaultAmmo = ammunition.find(a => a.value === last.ammunition)?.value ?? ammunition[0]?.value ?? null;

  const modes = (item.system.attackModes ?? [])
    .filter(mode => mode.value)
    .map(mode => ({ value: mode.value, label: game.i18n.localize(mode.label) }));
  const defaultMode = modes.find(m => m.value === last.attackMode)?.value ?? modes[0]?.value ?? null;

  return { needsAmmo, ammunition, defaultAmmo, modes, defaultMode };
}

/**
 * Before the flow starts: block the attack when a ranged weapon has no ammunition, or a thrown-only weapon
 * has no quantity left. Shows an error notification on the initiating client.
 * @param {Activity} activity
 * @returns {boolean}  false if the attack must not happen.
 */
export function checkAttackResources(activity) {
  if ( (activity.type !== "attack") || !getSetting("trackAmmunition") ) return true;
  const item = liveItem(activity);
  if ( item.type !== "weapon" ) return true;
  const options = getAttackOptions(activity);

  if ( options.needsAmmo && !options.ammunition.length ) {
    ui.notifications.error(loc("Ammo.None", { item: item.name }));
    return false;
  }

  const onlyThrown = options.modes.length && options.modes.every(m => isThrown(m.value));
  if ( onlyThrown && !item.system.properties?.has("ret") && !(item.system.quantity > 0) ) {
    ui.notifications.error(loc("Ammo.NoThrown", { item: item.name }));
    return false;
  }
  return true;
}

/**
 * After the attack dialog: make sure there is enough ammunition / thrown weapons for the attacks made.
 * @param {Activity} activity
 * @param {object} choice
 * @param {string|null} choice.ammunition  Ammunition item id.
 * @param {string|null} choice.attackMode
 * @param {number} count                   Number of attack rolls made.
 * @returns {boolean}
 */
export function validateAttackResources(activity, { ammunition, attackMode }, count) {
  if ( !getSetting("trackAmmunition") || !count ) return true;
  const item = liveItem(activity);
  if ( item.type !== "weapon" ) return true;

  if ( item.system.properties?.has("amm") ) {
    const ammo = activity.actor.items.get(ammunition);
    const available = ammo?.system.quantity ?? 0;
    if ( !ammo?.system.properties?.has("ret") && (available < count) ) {
      ui.notifications.error(loc("Ammo.NotEnough", { item: ammo?.name ?? item.name, needed: count, available }));
      return false;
    }
  }

  if ( isThrown(attackMode) && !item.system.properties?.has("ret") ) {
    const available = item.system.quantity ?? 0;
    if ( available < count ) {
      ui.notifications.error(loc("Ammo.NotEnough", { item: item.name, needed: count, available }));
      return false;
    }
  }
  return true;
}

/**
 * Spend ammunition / thrown weapons and remember the choice like dnd5e does (flags.dnd5e.last).
 * @param {Activity} activity
 * @param {object} choice
 * @param {string|null} choice.ammunition
 * @param {string|null} choice.attackMode
 * @param {number} count
 * @returns {Promise<object[]>}  Undo records.
 */
export async function spendAttackResources(activity, { ammunition, attackMode }, count) {
  const records = [];
  const actor = activity.actor;
  const item = liveItem(activity);
  if ( item.type !== "weapon" ) return records;

  // Remember the selection for next time, as AttackActivity#rollAttack does.
  const last = {};
  if ( ammunition ) last.ammunition = ammunition;
  if ( attackMode ) last.attackMode = attackMode;
  if ( !foundry.utils.isEmpty(last) && actor.items.has(item.id) ) {
    await item.setFlag("dnd5e", `last.${activity.id}`, last);
  }

  if ( !getSetting("trackAmmunition") || !count ) return records;

  // Ammunition
  const ammo = item.system.properties?.has("amm") ? actor.items.get(ammunition) : null;
  if ( ammo && !ammo.system.properties?.has("ret") ) {
    const quantity = ammo.system.quantity;
    const remaining = Math.max(0, quantity - count);
    const record = { actorUuid: actor.uuid, itemId: ammo.id, name: ammo.name, quantity, remaining, deleted: null };
    if ( (remaining === 0) && ammo.system.uses?.autoDestroy ) {
      record.deleted = ammo.toObject();
      await ammo.delete();
    } else {
      await ammo.update({ "system.quantity": remaining });
    }
    records.push(record);
  }

  // Thrown weapon
  if ( isThrown(attackMode) && !item.system.properties?.has("ret") ) {
    const quantity = item.system.quantity;
    const remaining = Math.max(0, quantity - count);
    await item.update({ "system.quantity": remaining });
    records.push({ actorUuid: actor.uuid, itemId: item.id, name: item.name, quantity, remaining, deleted: null });
  }
  return records;
}

/**
 * Restore spent ammunition / thrown weapons.
 * @param {object[]} records
 * @returns {Promise<string[]>}  Names that could not be restored.
 */
export async function restoreAttackResources(records) {
  const failures = [];
  for ( const record of [...records].reverse() ) {
    const actor = fromUuidSync(record.actorUuid);
    if ( !actor ) {
      failures.push(record.name);
      continue;
    }
    try {
      const item = actor.items.get(record.itemId);
      if ( item ) await item.update({ "system.quantity": record.quantity });
      else if ( record.deleted ) await actor.createEmbeddedDocuments("Item", [record.deleted], { keepId: true });
      else failures.push(record.name);
    } catch(err) {
      console.warn(`${MODULE_ID} | Could not restore ${record.name}`, err);
      failures.push(record.name);
    }
  }
  return failures;
}
