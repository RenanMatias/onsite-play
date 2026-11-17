/**
 * Journal links (dnd5e enrichers) rolled at the table.
 *
 * Interception points (verified in dnd5e 6.1.1 source):
 *  - Check / save links (`[[/check]]`, `[[/skill]]`, `[[/tool]]`, `[[/save]]`, `[[/concentration]]`) are
 *      `[data-action="roll"]` elements handled by a click listener that calls an internal function (rollCheckSave).
 *      It rolls for the controlled tokens or the user's character, and only warns when there are neither. There is
 *      no hook for that case, so a capture-phase click listener on the document catches it first, asks the GM for
 *      every player character's total in one dialog, and calls the normal dnd5e roll methods with the result preset
 *      (see `result` in checks.mjs). With a token selected or a character assigned, dnd5e runs as usual.
 *      The link's data is read like dnd5e's getRollActionDataset: the `.roll-link-group` dataset, then the clicked
 *      `.roll-link` dataset on top (multi-skill links have one sub-link per skill).
 *  - Loose damage / healing links (`[[/damage 2d6 fire]]`, `[[/heal 2d6]]`, also `/damage` typed in chat) roll a
 *      DamageRoll without an activity: dnd5e.preRollDamageV2 fires with no `config.subject`. hooks.mjs cancels that
 *      roll when handleLooseDamage takes over. The damage is typed once and applied to the controlled tokens, or to
 *      the player characters chosen in the dialog.
 */
import { MODULE_ID, loc } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { promptGroupTest, promptLooseDamage } from "./dialogs.mjs";
import { buildDamageParts, diceRange } from "./damage.mjs";
import { buildActorTargetInfo, buildTargetInfo } from "./targets.mjs";
import { applyAndDescribe, createEntry, healAndDescribe } from "./flows.mjs";
import { describeD20Roll, postSummary } from "./chat.mjs";

/** Link types handled as checks or saves. */
const TEST_TYPES = new Set(["check", "skill", "tool", "save", "concentration"]);

/**
 * @typedef EnricherTest
 * @property {"check"|"skill"|"tool"|"save"|"concentration"} type
 * @property {string|null} ability
 * @property {string|null} skill
 * @property {string|null} tool
 * @property {string|null} usingTool   Tool used with a skill (2024 rules).
 * @property {number|null} dc
 * @property {string} label            Link text, e.g. "DC 12 Strength (Athletics)".
 */

/** Register the journal link listener and queries. Called during "init". */
export function registerEnrichers() {
  document.addEventListener("click", onLinkClick, { capture: true });
  CONFIG.queries[`${MODULE_ID}.enricherTest`] = handleEnricherTestQuery;
  CONFIG.queries[`${MODULE_ID}.looseDamage`] = handleLooseDamageQuery;
}

/* -------------------------------------------- */
/*  Checks and saves                            */
/* -------------------------------------------- */

/**
 * Read a check or save link.
 * @param {HTMLElement} link  The clicked `[data-action="roll"]` element.
 * @returns {EnricherTest|null}  null for other link types (damage, attack, item…).
 */
function readTestLink(link) {
  const dataset = {
    ...(link.closest(".roll-link-group")?.dataset ?? {}),
    ...(link.closest(".roll-link")?.dataset ?? {})
  };
  if ( !TEST_TYPES.has(dataset.type) ) return null;
  return {
    type: dataset.type,
    ability: dataset.ability || null,
    skill: dataset.skill || null,
    tool: dataset.tool || null,
    usingTool: dataset.usingTool || null,
    dc: Number.isNumeric(dataset.dc) ? Number(dataset.dc) : null,
    label: link.textContent.trim()
  };
}

/**
 * Journal check / save links only ask for the total; concentration links still offer Natural 20 / Natural 1.
 * @param {string} type  Link type.
 * @returns {boolean}
 */
export function offersNatural(type) {
  return type === "concentration";
}

/**
 * The type of the check / save link that triggered a roll, if any (dnd5e passes the click event in the config).
 * @param {Event} [event]
 * @returns {string|null}
 */
export function linkTestType(event) {
  const link = event?.target?.closest?.('[data-action="roll"]');
  return link ? (readTestLink(link)?.type ?? null) : null;
}

/**
 * Capture-phase click handler: take over check / save links that dnd5e would reject for lack of an actor.
 * @param {PointerEvent} event
 */
function onLinkClick(event) {
  const link = event.target.closest?.('[data-action="roll"]');
  if ( !link ) return;
  const test = readTestLink(link);
  if ( !test ) return;
  if ( !getSetting("enabled") || !getSetting("manualChecks") || !game.users.activeGM ) return;
  if ( canvas.tokens?.controlled.length || game.user.character ) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  window.getSelection().empty();
  if ( game.user.isGM ) runGroupTest(test);
  else askGM(`${MODULE_ID}.enricherTest`, { test });
}

/**
 * Ask for the totals of every player character and roll the test for those that were filled in.
 * @param {EnricherTest} test
 */
async function runGroupTest(test) {
  try {
    const actors = game.actors.filter(a => a.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if ( !actors.length ) {
      ui.notifications.warn(loc("Warn.NoCharacters"));
      return;
    }
    const results = await promptGroupTest({
      label: test.label,
      dc: test.dc,
      actors: actors.map(actor => ({ actor, bonus: testBonus(actor, test) })),
      natural: offersNatural(test.type)
    });
    if ( !results?.length ) return;
    await rollTest(test, results);
  } catch(err) {
    console.error(`${MODULE_ID} | Journal link roll failed`, err);
    ui.notifications.error(loc("Warn.FlowError"));
  }
}

/**
 * The actor's bonus for a test, shown as a hint in the dialog.
 * @param {Actor} actor
 * @param {EnricherTest} test
 * @returns {number|null}
 */
function testBonus(actor, test) {
  const system = actor.system ?? {};
  let value;
  switch ( test.type ) {
    case "skill": value = system.skills?.[test.skill]?.total; break;
    case "tool": value = system.tools?.[test.tool]?.total; break;
    case "save": value = system.abilities?.[test.ability]?.save?.value; break;
    case "check": value = system.abilities?.[test.ability]?.mod; break;
    case "concentration": value = system.attributes?.concentration?.save; break;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * Roll the test for each actor with the typed result, like dnd5e's rollCheckSave does. With more than one actor,
 * dnd5e's roll cards are not posted: one summary card lists every result instead.
 * @param {EnricherTest} test
 * @param {{actor: Actor, total: number|null, nat: string}[]} results
 */
async function rollTest(test, results) {
  const merged = results.length > 1;
  const message = merged ? { create: false } : {};
  const entries = [];
  for ( const { actor, total, nat } of results ) {
    const config = { [MODULE_ID]: { result: { total, nat } } };
    if ( test.dc !== null ) config.target = test.dc;
    if ( test.ability ) config.ability = test.ability;
    let rolls;
    switch ( test.type ) {
      case "check": rolls = await actor.rollAbilityCheck(config, {}, message); break;
      case "skill":
        rolls = await actor.rollSkill({ ...config, skill: test.skill, tool: test.usingTool ?? undefined }, {}, message);
        break;
      case "tool": rolls = await actor.rollToolCheck({ ...config, tool: test.tool }, {}, message); break;
      case "save": rolls = await actor.rollSavingThrow(config, {}, message); break;
      case "concentration": rolls = await actor.rollConcentration(config, {}, message); break;
    }
    const roll = rolls?.[0];
    if ( !merged || !roll ) continue;
    const { segments, result } = describeD20Roll(roll, ["save", "concentration"].includes(test.type));
    entries.push({ name: actor.name, img: actor.img, result, segments, notes: [] });
  }
  if ( merged ) {
    await postSummary({ title: test.label, img: "icons/svg/d20-highlight.svg", actors: results.map(r => r.actor) },
      entries);
  }
}

/**
 * Query handler (registered in CONFIG.queries) run on the active GM's client.
 * Returns immediately; the dialog continues in the background so the query never times out.
 * @param {{test: EnricherTest}} data
 * @returns {boolean}
 */
function handleEnricherTestQuery(data) {
  if ( !game.user.isActiveGM ) throw new Error("Only the active GM can resolve Onsite Play rolls.");
  const t = data?.test ?? {};
  const pick = (value, choices) => {
    if ( (value === null) || (value === undefined) || (value === "") ) return null;
    if ( !(value in choices) ) throw new Error(`Invalid value "${value}".`);
    return value;
  };
  if ( !TEST_TYPES.has(t.type) ) throw new Error(`Invalid test type "${t.type}".`);
  const ability = t.ability === "spellcasting" ? "spellcasting" : pick(t.ability, CONFIG.DND5E.abilities);
  const test = {
    type: t.type,
    ability,
    skill: pick(t.skill, CONFIG.DND5E.skills),
    tool: pick(t.tool, CONFIG.DND5E.tools),
    usingTool: pick(t.usingTool, CONFIG.DND5E.tools),
    dc: Number.isFinite(t.dc) ? t.dc : null,
    label: String(t.label ?? "")
  };
  runGroupTest(test);
  return true;
}

/* -------------------------------------------- */
/*  Loose damage and healing                    */
/* -------------------------------------------- */

/**
 * @typedef LoosePart
 * @property {string} formula
 * @property {string[]} types  Damage or healing types allowed (empty = untyped).
 */

/**
 * dnd5e.preRollDamageV2 without an activity: take over the roll when the module is active.
 * @param {DamageRollProcessConfiguration} config
 * @returns {boolean}  true when the flow took over (the caller cancels dnd5e's roll).
 */
export function handleLooseDamage(config) {
  if ( !getSetting("enabled") || !game.users.activeGM ) return false;
  const parts = readLooseParts(config);
  if ( !parts.length ) return false;
  const tokenUuids = (canvas.tokens?.controlled ?? []).map(token => token.document.uuid);
  if ( game.user.isGM ) runLooseDamage({ parts, tokenUuids });
  else askGM(`${MODULE_ID}.looseDamage`, { parts, tokenUuids });
  return true;
}

/**
 * Read the formulas and types of a loose damage roll.
 * @param {DamageRollProcessConfiguration} config
 * @returns {LoosePart[]}
 */
function readLooseParts(config) {
  return (config.rolls ?? []).map(roll => ({
    formula: (roll.parts ?? []).join(" + "),
    types: (roll.options?.types?.length ? Array.from(roll.options.types) : [roll.options?.type]).filter(Boolean)
  })).filter(part => part.formula);
}

/**
 * Is this healing? Only when every part is typed and every type is a healing type.
 * @param {LoosePart[]} parts
 * @returns {boolean}
 */
function isHealing(parts) {
  return parts.every(part => part.types.length && part.types.every(t => t in CONFIG.DND5E.healingTypes));
}

/**
 * Ask for the damage or healing rolled at the table and apply it to every recipient. Runs on the GM client.
 * @param {{parts: LoosePart[], tokenUuids: string[]}} request
 */
async function runLooseDamage({ parts, tokenUuids }) {
  try {
    const healing = isHealing(parts);
    const damageParts = buildDamageParts(parts.map(part => ({
      parts: [part.formula],
      options: { type: part.types[0], types: part.types }
    }))).map(part => ({ ...part, dice: diceRange(part.formula) }));
    const tokens = tokenUuids.map(uuid => fromUuidSync(uuid)).filter(doc => doc?.documentName === "Token");

    let targets;
    let input;
    if ( tokens.length ) {
      targets = tokens.map(buildTargetInfo);
      input = await promptLooseDamage({
        parts: damageParts, healing, actors: null, recipients: targets.filter(Boolean).map(t => t.name)
      });
    } else {
      const actors = game.actors.filter(a => a.type === "character")
        .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
      if ( !actors.length ) {
        ui.notifications.warn(loc("Warn.NoCharacters"));
        return;
      }
      input = await promptLooseDamage({ parts: damageParts, healing, actors });
      targets = input?.actors.map(buildActorTargetInfo);
    }
    if ( !input ) return;
    targets = targets.filter(Boolean);

    const entries = [];
    const snapshots = [];
    for ( const target of targets ) {
      const entry = createEntry(target, healing ? "heal" : "damage");
      if ( healing ) await healAndDescribe(target, input.damages, entry, snapshots);
      else await applyAndDescribe(target, input.damages, { ignore: input.ignore }, entry, snapshots);
      entries.push(entry);
    }
    await postSummary({
      title: loc(healing ? "Loose.HealingTitle" : "Loose.DamageTitle"),
      img: healing ? "icons/svg/heal.svg" : "icons/svg/explosion.svg",
      actors: targets.map(target => target.actor)
    }, entries, snapshots);
  } catch(err) {
    console.error(`${MODULE_ID} | Journal damage link failed`, err);
    ui.notifications.error(loc("Warn.FlowError"));
  }
}

/**
 * Query handler (registered in CONFIG.queries) run on the active GM's client.
 * Returns immediately; the dialog continues in the background so the query never times out.
 * Only tokens whose actor the requesting user owns are kept.
 * @param {{parts: LoosePart[], tokenUuids: string[]}} data
 * @param {{user: User}} context
 * @returns {boolean}
 */
function handleLooseDamageQuery(data, { user }) {
  if ( !game.user.isActiveGM ) throw new Error("Only the active GM can resolve Onsite Play rolls.");
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  if ( !parts.length ) throw new Error("No damage requested.");
  const valid = parts.map(part => {
    const types = Array.isArray(part?.types) ? part.types.map(String) : [];
    for ( const type of types ) {
      if ( !(type in CONFIG.DND5E.damageTypes) && !(type in CONFIG.DND5E.healingTypes) ) {
        throw new Error(`Invalid damage type "${type}".`);
      }
    }
    return { formula: String(part?.formula ?? ""), types };
  });
  const tokenUuids = (Array.isArray(data.tokenUuids) ? data.tokenUuids : []).filter(uuid => {
    if ( typeof uuid !== "string" ) return false;
    const doc = fromUuidSync(uuid);
    return (doc?.documentName === "Token") && !!doc.actor?.testUserPermission(user, "OWNER");
  });
  runLooseDamage({ parts: valid, tokenUuids });
  return true;
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/**
 * Send a journal link request to the active GM.
 * @param {string} query  Query name.
 * @param {object} data
 */
async function askGM(query, data) {
  const gm = game.users.activeGM;
  if ( !gm ) {
    ui.notifications.warn(loc("Warn.NoGM"));
    return;
  }
  try {
    await gm.query(query, data);
    ui.notifications.info(loc("Info.SentToGM"));
  } catch(err) {
    console.error(`${MODULE_ID} | Could not send the roll to the GM`, err);
    ui.notifications.error(loc("Warn.QueryFailed"));
  }
}
