/**
 * Manual initiative: the GM types the initiative totals rolled at the table for player characters.
 *
 * Interception points (verified in dnd5e 6.0.6 and Foundry v14 source):
 *  - dnd5e.preRollInitiativeDialogV2(config, dialog, message)
 *      Fired by Actor5e#rollInitiativeDialog (combat tracker d20 button, character sheet) before the
 *      normal / advantage / disadvantage dialog. Returning false skips that dialog; the GM types the total instead.
 *  - Combat#rollInitiative(ids, options)
 *      "Roll All" and other batch rolls never open a dialog. A subclass of dnd5e's Combat5e asks for the
 *      totals first, then lets the normal roll run.
 * Both paths store the typed total as Actor5e#_cachedInitiativeRoll: a fixed BasicRoll, the same thing dnd5e
 * uses for fixed initiative scores. Combatant5e#getInitiativeRoll returns it instead of a d20 roll, so grouping,
 * sorting, chat messages and combat recovery keep working as usual.
 */
import { MODULE_ID, loc } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { isGuidedActor } from "./hooks.mjs";
import { promptInitiative } from "./dialogs.mjs";

/** Register the initiative hook, query and Combat subclass. Called during "init", after dnd5e's own init. */
export function registerInitiative() {
  Hooks.on("dnd5e.preRollInitiativeDialogV2", onPreRollInitiativeDialog);
  CONFIG.queries[`${MODULE_ID}.rollInitiative`] = handleInitiativeQuery;
  CONFIG.Combat.documentClass = makeCombatClass(CONFIG.Combat.documentClass);
}

/**
 * Should the GM type this actor's initiative instead of Foundry rolling it?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function usesManualInitiative(actor) {
  if ( !getSetting("enabled") || !getSetting("manualInitiative") ) return false;
  if ( !isGuidedActor(actor) ) return false;
  // dnd5e's fixed initiative score setting doesn't roll at all, so there is nothing to type.
  if ( actor.getInitiativeRollConfig()?.options?.fixed !== undefined ) return false;
  return !!game.users.activeGM;
}

/* -------------------------------------------- */
/*  Interception                                */
/* -------------------------------------------- */

/** The d20 button in the combat tracker or the initiative on a sheet was clicked: skip dnd5e's dialog. */
function onPreRollInitiativeDialog(config, dialog, message) {
  const actor = config.subject;
  if ( !usesManualInitiative(actor) ) return;
  const messageMode = message?.rollMode;
  if ( game.user.isGM ) runActorInitiative(actor, messageMode);
  else askGM({ actorUuid: actor.uuid, messageMode });
  return false;
}

/**
 * Wrap dnd5e's Combat class so batch rolls ("Roll All") ask for the totals of guided actors.
 * @param {typeof Combat} Base
 * @returns {typeof Combat}
 */
function makeCombatClass(Base) {
  return class OnsiteCombat extends Base {
    /** @inheritDoc */
    async rollInitiative(ids, options={}) {
      ids = (typeof ids === "string") ? [ids] : Array.from(ids);

      // Combatants that already carry a cached roll come from Actor#rollInitiative and are left alone.
      const manual = ids.map(id => this.combatants.get(id)).filter(c => c?.isOwner && c.actor
        && !c.actor._cachedInitiativeRoll && usesManualInitiative(c.actor));
      if ( !manual.length ) return super.rollInitiative(ids, options);

      const manualIds = new Set(manual.map(c => c.id));
      if ( !game.user.isGM ) {
        askGM({ combatUuid: this.uuid, combatantIds: Array.from(manualIds) });
        return super.rollInitiative(ids.filter(id => !manualIds.has(id)), options);
      }

      // One row per actor: several tokens of the same linked actor share its initiative.
      const byActor = new Map();
      for ( const c of manual ) {
        const img = c.img || c.token?.texture?.src || c.actor.img;
        if ( !byActor.has(c.actor) ) byActor.set(c.actor, { actor: c.actor, name: c.name, img, ids: [] });
        byActor.get(c.actor).ids.push(c.id);
      }
      const rows = Array.from(byActor.values());
      const totals = await promptInitiative(rows);
      if ( !totals ) return this;

      // Blank totals skip that actor's combatants.
      const skipped = new Set();
      rows.forEach((row, i) => {
        if ( totals[i] === null ) row.ids.forEach(id => skipped.add(id));
        else row.actor._cachedInitiativeRoll = createManualRoll(row.actor, totals[i]);
      });
      try {
        return await super.rollInitiative(ids.filter(id => !skipped.has(id)), options);
      } finally {
        for ( const row of rows ) delete row.actor._cachedInitiativeRoll;
      }
    }
  };
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

/**
 * Ask the GM for one actor's initiative and roll it, adding the actor to the combat like dnd5e does.
 * @param {Actor} actor
 * @param {string} [messageMode]
 */
async function runActorInitiative(actor, messageMode) {
  try {
    const totals = await promptInitiative([{ actor, name: actor.name, img: actor.img }]);
    if ( (totals?.[0] ?? null) === null ) return;
    actor._cachedInitiativeRoll = createManualRoll(actor, totals[0]);
    // Actor5e#rollInitiative clears the cached roll when it finishes.
    await actor.rollInitiative({ createCombatants: true, initiativeOptions: { messageMode } });
  } catch(err) {
    delete actor._cachedInitiativeRoll;
    console.error(`${MODULE_ID} | Initiative failed`, err);
    ui.notifications.error(loc("Warn.FlowError"));
  }
}

/**
 * Build the fixed roll for a typed initiative total. The dnd5e Dexterity tiebreaker is kept when enabled.
 * @param {Actor} actor
 * @param {number} total
 * @returns {BasicRoll}
 */
function createManualRoll(actor, total) {
  const { data, options } = actor.getInitiativeRollConfig();
  const parts = [String(total)];
  const ability = actor.system.abilities?.[options.ability];
  if ( game.settings.get("dnd5e", "initiativeDexTiebreaker") && Number.isNumeric(ability?.value) ) {
    parts.push(String(ability.value / 100));
  }
  return new CONFIG.Dice.BasicRoll(parts.join(" + "), data, options);
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/**
 * Forward an initiative request to the active GM.
 * @param {{actorUuid: string, messageMode?: string}|{combatUuid: string, combatantIds: string[]}} data
 */
async function askGM(data) {
  const gm = game.users.activeGM;
  if ( !gm ) {
    ui.notifications.warn(loc("Warn.NoGM"));
    return;
  }
  try {
    await gm.query(`${MODULE_ID}.rollInitiative`, data);
    ui.notifications.info(loc("Info.SentToGM"));
  } catch(err) {
    console.error(`${MODULE_ID} | Could not send the initiative to the GM`, err);
    ui.notifications.error(loc("Warn.QueryFailed"));
  }
}

/**
 * Query handler (registered in CONFIG.queries) run on the active GM's client.
 * Returns immediately; the dialog continues in the background so the query never times out.
 * @param {{actorUuid?: string, messageMode?: string, combatUuid?: string, combatantIds?: string[]}} data
 * @param {{user: User}} context
 */
async function handleInitiativeQuery(data, { user }) {
  if ( !game.user.isActiveGM ) throw new Error("Only the active GM can roll Onsite Play initiative.");

  if ( data?.actorUuid ) {
    const actor = await fromUuid(data.actorUuid);
    if ( !(actor instanceof Actor) ) throw new Error(`Actor ${data.actorUuid} not found.`);
    if ( !actor.testUserPermission(user, "OWNER") ) throw new Error("The requesting user does not own this actor.");
    const messageMode = data.messageMode in CONFIG.ChatMessage.modes ? data.messageMode : undefined;
    runActorInitiative(actor, messageMode);
    return true;
  }

  const combat = await fromUuid(data?.combatUuid);
  if ( !(combat instanceof Combat) ) throw new Error(`Combat ${data?.combatUuid} not found.`);
  const ids = (Array.isArray(data.combatantIds) ? data.combatantIds : []).filter(id => {
    return combat.combatants.get(id)?.actor?.testUserPermission(user, "OWNER");
  });
  if ( !ids.length ) throw new Error("The requesting user does not own these combatants.");
  combat.rollInitiative(ids).catch(err => {
    console.error(`${MODULE_ID} | Initiative failed`, err);
    ui.notifications.error(loc("Warn.FlowError"));
  });
  return true;
}
