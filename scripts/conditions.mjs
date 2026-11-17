/**
 * Journal condition links (`&Reference[frightened]`): choose which player characters receive the condition.
 *
 * Interception point (verified in dnd5e 6.1.1 source):
 *  - The apply button next to a condition reference is a `[data-action="applyStatus"]` element with
 *      `data-status`. dnd5e's handler (handleApplyStatus) toggles the status on the actors of the controlled tokens
 *      only, with no hook. The capture-phase listener in enrichers.mjs takes the click over and calls
 *      runApplyStatus: a dialog lists every player character (those of the selected tokens are pre-checked), and the
 *      condition is added to the checked ones, even without a token on the scene. Unlike dnd5e's toggle, a condition
 *      already present is kept; a condition with levels (exhaustion) goes up one level.
 * Each change is recorded on the summary card so Undo can revert it (undoConditions).
 */
import { MODULE_ID, loc } from "./constants.mjs";
import { promptApplyStatus } from "./dialogs.mjs";
import { postSummary } from "./chat.mjs";

/**
 * @typedef ConditionRecord
 * @property {string} actorUuid
 * @property {string} name
 * @property {string} status
 * @property {number} levels  Levels added (conditions with levels), or 1 for a condition that was added.
 */

/**
 * The status effect configuration for a status id.
 * @param {string} status
 * @returns {object|undefined}
 */
export function getStatusEffect(status) {
  return CONFIG.statusEffects.find(effect => effect.id === status);
}

/**
 * Max level of a condition with levels (exhaustion), or null.
 * @param {string} status
 * @returns {number|null}
 */
function maxLevel(status) {
  const levels = CONFIG.DND5E.conditionTypes[status]?.levels;
  return Number.isFinite(levels) ? levels : null;
}

/**
 * Current state of a condition on an actor.
 * @param {Actor} actor
 * @param {string} status
 * @returns {{has: boolean, level: number|null}}
 */
function conditionState(actor, status) {
  if ( maxLevel(status) !== null ) {
    const level = actor.system.conditions?.[status] ?? 0;
    return { has: level > 0, level };
  }
  return { has: actor.statuses.has(status), level: null };
}

/**
 * Ask which player characters receive the condition, apply it, and post a summary card with Undo. GM client only.
 * @param {{status: string, preselected: string[]}} request  `preselected`: actor UUIDs checked by default.
 */
export async function runApplyStatus({ status, preselected=[] }) {
  try {
    const effect = getStatusEffect(status);
    if ( !effect ) return;
    const label = game.i18n.localize(effect.name);
    const actors = game.actors.filter(a => a.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if ( !actors.length ) {
      ui.notifications.warn(loc("Warn.NoCharacters"));
      return;
    }
    const max = maxLevel(status);
    const chosen = await promptApplyStatus({
      label,
      img: effect.img,
      actors: actors.map(actor => {
        const { has, level } = conditionState(actor, status);
        let state = null;
        if ( max !== null ) state = level ? loc("Status.Level", { level }) : null;
        else if ( has ) state = loc("Status.Already");
        return { actor, state, checked: preselected.includes(actor.uuid) };
      })
    });
    if ( !chosen?.length ) return;

    const entries = [];
    const records = [];
    for ( const actor of chosen ) {
      const entry = { name: actor.name, img: actor.img, result: "damage", segments: [], notes: [] };
      const before = conditionState(actor, status);
      if ( max !== null ) {
        if ( before.level >= max ) entry.segments.push(loc("Status.AtMax", { status: label, level: before.level }));
        else {
          await actor.toggleStatusEffect(status);
          const after = conditionState(actor, status).level;
          entry.segments.push(loc("Status.LevelChange", { status: label, from: before.level, to: after }));
          if ( after > before.level ) {
            records.push({ actorUuid: actor.uuid, name: actor.name, status, levels: after - before.level });
          }
        }
      } else if ( before.has ) entry.segments.push(loc("Status.AlreadyHas", { status: label }));
      else {
        await actor.toggleStatusEffect(status, { active: true });
        entry.segments.push(label);
        if ( actor.statuses.has(status) ) records.push({ actorUuid: actor.uuid, name: actor.name, status, levels: 1 });
      }
      entries.push(entry);
    }
    await postSummary({ title: label, img: effect.img, actors: chosen }, entries, [], [], records);
  } catch(err) {
    console.error(`${MODULE_ID} | Applying a condition failed`, err);
    ui.notifications.error(loc("Warn.FlowError"));
  }
}

/**
 * Undo conditions added by runApplyStatus (most recent first).
 * @param {ConditionRecord[]} records
 * @returns {Promise<string[]>}  Names of actors that could not be restored.
 */
export async function undoConditions(records) {
  const failures = [];
  for ( const record of [...records].reverse() ) {
    const actor = fromUuidSync(record.actorUuid);
    if ( !actor ) {
      failures.push(record.name);
      continue;
    }
    try {
      // Lowering a level the actor no longer has would make dnd5e toggle the condition on instead.
      if ( maxLevel(record.status) !== null ) {
        const level = conditionState(actor, record.status).level;
        if ( level > 0 ) await actor.toggleStatusEffect(record.status, { levels: -Math.min(record.levels, level) });
      }
      else if ( actor.statuses.has(record.status) ) await actor.toggleStatusEffect(record.status, { active: false });
    } catch(err) {
      console.warn(`${MODULE_ID} | Could not remove "${record.status}" from ${actor.name}`, err);
      failures.push(record.name);
    }
  }
  return failures;
}
