/**
 * Manual checks and saves: ability checks, skill and tool checks, saving throws, death saves and
 * concentration saves of player characters use the total rolled at the table.
 *
 * Interception points (verified in dnd5e 6.0.6 source):
 *  - dnd5e.preRollAbilityCheckV2 / dnd5e.preRollSavingThrowV2(config, dialog, message)
 *      Fired by BasicRoll.buildConfigure for every check and save. Skills and tools also fire "abilityCheck";
 *      death saves and concentration go through Actor5e#rollSavingThrow and fire "savingThrow".
 *      The roll is not canceled: its configuration dialog (dialog.applicationClass) is swapped for one where the
 *      GM types the total, so dnd5e still posts the chat card and applies the result (death save counters,
 *      concentration, request cards…).
 * The typed total becomes a real D20Roll: the d20 is pre-filled with the natural result and the modifiers are
 * folded into one number, so roll.total is exactly what was typed and isCritical / isFumble follow the
 * Natural 20 / Natural 1 choice. It is evaluated without interactive fulfillment, so Foundry's manual dice input
 * never asks for it again.
 */
import { MODULE_ID, loc } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { isGuidedActor } from "./hooks.mjs";
import { promptD20Test } from "./dialogs.mjs";

const { NumericTerm, OperatorTerm } = foundry.dice.terms;

/** Register the check and save hooks and the query. Called during "init". */
export function registerChecks() {
  Hooks.on("dnd5e.preRollAbilityCheckV2", onPreRollD20Test);
  Hooks.on("dnd5e.preRollSavingThrowV2", onPreRollD20Test);
  CONFIG.queries[`${MODULE_ID}.d20Test`] = handleD20TestQuery;
}

/**
 * Should the GM type this actor's checks and saves instead of Foundry rolling them?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function usesManualChecks(actor) {
  if ( !getSetting("enabled") || !getSetting("manualChecks") ) return false;
  if ( !isGuidedActor(actor) ) return false;
  return !!game.users.activeGM;
}

/* -------------------------------------------- */
/*  Interception                                */
/* -------------------------------------------- */

/** Replace dnd5e's roll configuration dialog. Pass `{ "onsite-play": { digital: true } }` in the config to skip. */
function onPreRollD20Test(config, dialog) {
  if ( config[MODULE_ID]?.digital ) return;
  // Initiative also fires "abilityCheck"; it has its own handling in initiative.mjs.
  if ( config.hookNames?.includes("initiativeDialog") ) return;
  if ( !usesManualChecks(config.subject) ) return;
  // Also overrides the keybindings that skip the dialog.
  dialog.configure = true;
  dialog.applicationClass = ManualRollConfiguration;
}

/** Stands in for a RollConfigurationDialog: BasicRoll.buildConfigure only calls its static `configure`. */
class ManualRollConfiguration {
  /**
   * Build the rolls like a fast-forwarded roll, then fill in the results typed by the GM.
   * @param {D20RollProcessConfiguration} config
   * @param {BasicRollDialogConfiguration} dialog
   * @param {BasicRollMessageConfiguration} message
   * @returns {Promise<D20Roll[]>}  An empty array cancels the roll.
   */
  static async configure(config, dialog, message) {
    const rolls = (config.rolls ?? []).map((r, index) => {
      dialog.options?.buildConfig?.(config, r, null, index);
      for ( const hookName of config.hookNames ) {
        Hooks.callAll(`dnd5e.postBuild${hookName.capitalize()}RollConfig`, config, r, index);
      }
      return CONFIG.Dice.D20Roll.fromConfig(r, config);
    });
    if ( !rolls.length ) return rolls;

    const actor = config.subject;
    const request = {
      label: dialog.options?.window?.title || message.data?.flavor || actor.name,
      target: Number.isFinite(rolls[0].options.target) ? rolls[0].options.target : null,
      formulas: rolls.map(roll => roll.formula)
    };
    const input = game.user.isGM ? await promptD20Test(actor, request) : await askGM(actor, request);
    if ( !input ) return [];
    rolls.forEach((roll, i) => applyManualResult(roll, input[i]));
    // The roll card is shown as an Onsite Play summary line (see onRenderCheckMessage in chat.mjs).
    foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.check`, true);
    // The dice were rolled at the table: no dice sound (BasicRoll.toMessage only adds it when none is set).
    foundry.utils.setProperty(message, "data.sound", null);
    return rolls;
  }
}

/**
 * Turn an unevaluated D20Roll into one that evaluates to the typed total.
 * @param {D20Roll} roll
 * @param {{total: number|null, nat: "none"|"nat20"|"nat1"}} input  Without a total, a natural 20 / 1 adds the
 *                                                                   roll's modifiers.
 */
function applyManualResult(roll, { total, nat }) {
  const d20 = roll.d20;
  const { criticalSuccess=20, criticalFailure=1 } = d20.options;
  const modifier = staticModifier(roll);
  let natural;
  if ( nat === "nat20" ) natural = 20;
  else if ( nat === "nat1" ) natural = 1;
  else natural = Math.clamp(total - modifier, criticalFailure + 1, criticalSuccess - 1);
  total ??= natural + modifier;

  // Advantage, Halfling Lucky and Reliable Talent were already resolved at the table.
  d20.modifiers = [];
  d20.number = 1;
  d20.results = [{ result: natural, active: true }];
  roll.options.reliableTalent = false;

  const offset = total - natural;
  roll.terms = [d20];
  if ( offset ) {
    roll.terms.push(new OperatorTerm({ operator: offset < 0 ? "-" : "+" }), new NumericTerm({ number: Math.abs(offset) }));
  }
  roll.resetFormula();

  // The result is already known: skip Foundry's manual / interactive dice fulfillment (RollResolver), which would
  // otherwise ask for the pre-filled d20 again. BasicRoll.buildEvaluate calls evaluate() without options.
  const evaluate = roll.evaluate;
  roll.evaluate = options => evaluate.call(roll, { ...options, allowInteractive: false });
}

/**
 * The part of a roll that isn't the d20, with bonus dice at their minimum. Only used to show a believable
 * natural result on the chat card.
 * @param {D20Roll} roll
 * @returns {number}
 */
function staticModifier(roll) {
  const rest = roll.terms.slice(1);
  if ( !rest.length ) return 0;
  try {
    return new Roll(`0 ${Roll.getFormula(rest)}`, roll.data).evaluateSync({ minimize: true }).total;
  } catch(err) {
    return 0;
  }
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/**
 * Ask the active GM for the results and wait for them.
 * @param {Actor} actor
 * @param {object} request
 * @returns {Promise<object[]|null>}
 */
async function askGM(actor, request) {
  const gm = game.users.activeGM;
  if ( !gm ) {
    ui.notifications.warn(loc("Warn.NoGM"));
    return null;
  }
  try {
    ui.notifications.info(loc("Info.SentToGM"));
    return await gm.query(`${MODULE_ID}.d20Test`, { actorUuid: actor.uuid, ...request });
  } catch(err) {
    console.error(`${MODULE_ID} | Could not send the roll to the GM`, err);
    ui.notifications.error(loc("Warn.QueryFailed"));
    return null;
  }
}

/**
 * Query handler (registered in CONFIG.queries) run on the active GM's client. Unlike the flows, the player's
 * roll waits for the answer, so this resolves only once the GM closes the dialog.
 * @param {{actorUuid: string, label: string, target: number|null, formulas: string[]}} data
 * @param {{user: User}} context
 * @returns {Promise<object[]|null>}
 */
async function handleD20TestQuery(data, { user }) {
  if ( !game.user.isActiveGM ) throw new Error("Only the active GM can resolve Onsite Play rolls.");
  const actor = await fromUuid(data?.actorUuid);
  if ( !(actor instanceof Actor) ) throw new Error(`Actor ${data?.actorUuid} not found.`);
  if ( !actor.testUserPermission(user, "OWNER") ) throw new Error("The requesting user does not own this actor.");
  const formulas = Array.isArray(data.formulas) ? data.formulas.map(String) : [];
  if ( !formulas.length ) throw new Error("No rolls requested.");
  return promptD20Test(actor, {
    label: String(data.label ?? actor.name),
    target: Number.isFinite(data.target) ? data.target : null,
    formulas
  });
}
