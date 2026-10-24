/**
 * Onsite Play — entry point.
 * Guided physical-dice flow for player characters in dnd5e v6 on Foundry VTT v14.
 */
import { MODULE_ID, TEMPLATES } from "./constants.mjs";
import { registerSettings } from "./settings.mjs";
import { registerHooks } from "./hooks.mjs";
import { handleFlowQuery } from "./flows.mjs";

Hooks.once("init", () => {
  registerSettings();

  // Player clients ask the active GM to run the flow through Foundry's user query system (v13+).
  CONFIG.queries[`${MODULE_ID}.runFlow`] = handleFlowQuery;

  registerHooks();
  foundry.applications.handlebars.loadTemplates(Object.values(TEMPLATES));

  // Small public API (also used for the optional NPC opt-in).
  game.modules.get(MODULE_ID).api = {
    /**
     * Opt a non-character actor in or out of the guided flow (requires the "npcOptIn" setting).
     * @param {Actor} actor
     * @param {boolean} [value=true]
     */
    setOptIn: (actor, value=true) => actor.setFlag(MODULE_ID, "optIn", !!value)
  };
});
