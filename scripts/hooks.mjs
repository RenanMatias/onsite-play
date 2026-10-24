/**
 * Hook registration: decides when a dnd5e activity is taken over by the guided flow.
 *
 * Interception points (verified in dnd5e 6.0.6 source):
 *  - dnd5e.preUseActivity(activity, usageConfig, dialogConfig, messageConfig)
 *      Setting usageConfig.subsequentActions = false stops Activity#use from calling
 *      _triggerSubsequentActions (which opens the attack / damage roll automatically).
 *  - dnd5e.postUseActivity(activity, usageConfig, results)
 *      Fires after consumption, template placement and the usage chat card. The flow starts here.
 *  - dnd5e.preRollAttackV2 / dnd5e.preRollDamageV2(config, dialog, message)
 *      Fired by BasicRoll.buildConfigure for chat-card "Attack" / "Damage" buttons. Returning false cancels
 *      the roll; we start the matching flow instead.
 */
import { MODULE_ID, FLOW_ACTIVITY_TYPES } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { requestFlow } from "./flows.mjs";
import { onRenderChatMessage } from "./chat.mjs";
import { checkAttackResources } from "./ammunition.mjs";

/**
 * Should this activity use the guided flow instead of dnd5e's automatic rolls?
 * @param {Activity} activity
 * @returns {boolean}
 */
export function shouldIntercept(activity) {
  if ( !getSetting("enabled") ) return false;
  if ( !activity || !FLOW_ACTIVITY_TYPES.has(activity.type) ) return false;
  const actor = activity.actor;
  if ( !actor ) return false;

  const isPC = actor.type === "character";
  const optedIn = getSetting("npcOptIn") && (actor.getFlag(MODULE_ID, "optIn") === true);
  if ( !isPC && !optedIn ) return false;

  // Heals need a healing formula; saves and plain damage need damage. Otherwise keep dnd5e defaults.
  if ( activity.type === "heal" ) {
    if ( !activity.healing?.formula ) return false;
  } else if ( (activity.type !== "attack") && !activity.damage?.parts?.length ) return false;

  // Without an active GM nobody can run the dialogs, so let dnd5e behave normally.
  return !!game.users.activeGM;
}

/** Register all hooks. Called during "init". */
export function registerHooks() {
  Hooks.on("dnd5e.preUseActivity", onPreUseActivity);
  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("dnd5e.preRollAttackV2", onPreRollAttack);
  Hooks.on("dnd5e.preRollDamageV2", onPreRollDamage);
  Hooks.on("renderChatMessageHTML", onRenderChatMessage);
}

/* -------------------------------------------- */

/**
 * Disable dnd5e's automatic follow-up roll and mark the usage for the flow. Runs before dnd5e consumes
 * spell slots / uses, so a ranged weapon without ammunition is blocked before anything is spent.
 */
function onPreUseActivity(activity, usageConfig) {
  if ( !shouldIntercept(activity) ) return;
  if ( !checkAttackResources(activity) ) return false;
  usageConfig.subsequentActions = false;
  usageConfig[MODULE_ID] = true;
}

/** Start the flow once the activity has been used (resources consumed, card posted). */
function onPostUseActivity(activity, usageConfig) {
  if ( !usageConfig[MODULE_ID] ) return;
  requestFlow({ activity, mode: activity.type, scaling: usageConfig.scaling });
}

/** A chat-card "Attack" button was clicked for a PC: run the full flow instead of rolling. */
function onPreRollAttack(config) {
  const activity = config.subject;
  if ( !shouldIntercept(activity) ) return;
  if ( checkAttackResources(activity) ) requestFlow({ activity, mode: "attack", scaling: config.scaling });
  return false;
}

/**
 * A chat-card "Damage" / "Healing" button was clicked for a PC. Save activities run the save flow, heal
 * activities the healing flow; attack and damage activities run the damage-only flow (the GM already knows
 * who was hit). Heal activities roll through Activity#rollDamage too, so they arrive here.
 */
function onPreRollDamage(config) {
  const activity = config.subject;
  if ( !shouldIntercept(activity) ) return;
  const mode = { save: "save", heal: "heal" }[activity.type] ?? "damage";
  requestFlow({ activity, mode, scaling: config.scaling });
  return false;
}
