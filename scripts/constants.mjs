/**
 * Shared constants and tiny helpers for the Onsite Play module.
 */

/** Module id. Must match the folder name and module.json. */
export const MODULE_ID = "onsite-play";

/** Activity types whose rolls this module replaces. */
export const FLOW_ACTIVITY_TYPES = new Set(["attack", "save", "damage", "heal"]);

/** Flow modes that can be requested (also validated when a player client asks the GM). */
export const FLOW_MODES = new Set(["attack", "save", "damage", "heal"]);

/** Handlebars templates used by the module. */
export const TEMPLATES = {
  attack: `modules/${MODULE_ID}/templates/attack-dialog.hbs`,
  damage: `modules/${MODULE_ID}/templates/damage-dialog.hbs`,
  save: `modules/${MODULE_ID}/templates/save-dialog.hbs`,
  summary: `modules/${MODULE_ID}/templates/summary-card.hbs`
};

/**
 * Localize a key under the module's "ONSITE" namespace.
 * @param {string} key       Key relative to "ONSITE." (e.g. "Buttons.Cancel").
 * @param {object} [data]    Format data. When given, game.i18n.format is used.
 * @returns {string}
 */
export function loc(key, data) {
  const full = `ONSITE.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/**
 * Poll a predicate until it returns true or the timeout elapses.
 * Used to wait for dnd5e's own asynchronous status automation, which is not awaited by Actor#update.
 * @param {() => boolean} predicate
 * @param {number} [timeout=500]   Milliseconds.
 * @param {number} [interval=50]   Milliseconds between checks.
 * @returns {Promise<boolean>}     The final predicate value.
 */
export async function waitFor(predicate, timeout=500, interval=50) {
  const end = Date.now() + timeout;
  while ( Date.now() < end ) {
    if ( predicate() ) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return predicate();
}
