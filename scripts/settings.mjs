/**
 * Module settings.
 */
import { MODULE_ID } from "./constants.mjs";

/** Register all world settings. Called during "init". */
export function registerSettings() {
  game.settings.register(MODULE_ID, "enabled", {
    name: "ONSITE.Settings.Enabled.Name",
    hint: "ONSITE.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "removeDefeated", {
    name: "ONSITE.Settings.RemoveDefeated.Name",
    hint: "ONSITE.Settings.RemoveDefeated.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "visibility", {
    name: "ONSITE.Settings.Visibility.Name",
    hint: "ONSITE.Settings.Visibility.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      public: "ONSITE.Settings.Visibility.Public",
      gm: "ONSITE.Settings.Visibility.GM",
      gmOwner: "ONSITE.Settings.Visibility.GMOwner"
    },
    default: "public"
  });

  game.settings.register(MODULE_ID, "showAC", {
    name: "ONSITE.Settings.ShowAC.Name",
    hint: "ONSITE.Settings.ShowAC.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "trackAmmunition", {
    name: "ONSITE.Settings.TrackAmmunition.Name",
    hint: "ONSITE.Settings.TrackAmmunition.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "npcOptIn", {
    name: "ONSITE.Settings.NpcOptIn.Name",
    hint: "ONSITE.Settings.NpcOptIn.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

/**
 * Read a module setting.
 * @param {string} key
 * @returns {*}
 */
export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}
