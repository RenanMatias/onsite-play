/**
 * Target acquisition and lightweight target descriptors.
 */
import { loc } from "./constants.mjs";
import { promptForTargets } from "./dialogs.mjs";

/**
 * @typedef TargetInfo
 * @property {string} uuid            TokenDocument UUID (always the token, so unlinked tokens use their own actor).
 * @property {TokenDocument} token
 * @property {Actor} actor            token.actor — the synthetic actor for unlinked tokens.
 * @property {string} name
 * @property {string} img
 * @property {number|null} ac         Current computed AC (system.attributes.ac.value).
 * @property {boolean} hasHP
 * @property {number|null} hp
 * @property {boolean} totalCover
 */

/**
 * Build a descriptor for a token document.
 * @param {TokenDocument} tokenDoc
 * @returns {TargetInfo|null}
 */
export function buildTargetInfo(tokenDoc) {
  const actor = tokenDoc?.actor;
  if ( !actor ) return null;
  const attributes = actor.system?.attributes ?? {};
  const ac = attributes.ac?.value;
  return {
    uuid: tokenDoc.uuid,
    token: tokenDoc,
    actor,
    name: tokenDoc.name,
    img: tokenDoc.texture?.src || actor.img,
    ac: Number.isFinite(ac) ? ac : null,
    hasHP: !!attributes.hp,
    hp: attributes.hp?.value ?? null,
    totalCover: actor.statuses?.has("coverTotal") ?? false
  };
}

/**
 * Re-read a target (HP/AC may have changed since it was acquired).
 * @param {TargetInfo} info
 * @returns {TargetInfo|null}
 */
export function refreshTarget(info) {
  const doc = fromUuidSync(info.uuid);
  return doc ? buildTargetInfo(doc) : null;
}

/**
 * Resolve token UUIDs to token documents, ignoring anything that no longer exists.
 * @param {string[]} uuids
 * @returns {TokenDocument[]}
 */
function resolveTokens(uuids) {
  return uuids.map(uuid => fromUuidSync(uuid)).filter(doc => doc?.documentName === "Token");
}

/**
 * Get the targets for a flow. Uses the provided token UUIDs (the initiating user's targets); if there are none,
 * asks the GM to target tokens and re-checks the GM's targets on "Continue".
 * @param {string[]} [initialUuids=[]]
 * @param {object} [options]
 * @param {Actor|null} [options.caster]  When given, the prompt offers a "Caster" button that targets this
 *                                       actor's token on the current scene (used for healing).
 * @returns {Promise<TargetInfo[]|null>}  null when the GM cancels.
 */
export async function acquireTargets(initialUuids=[], { caster=null }={}) {
  const casterToken = caster?.getActiveTokens(false, true)[0] ?? null;
  let docs = resolveTokens(initialUuids);
  while ( !docs.length ) {
    const choice = await promptForTargets({ allowCaster: !!casterToken });
    if ( !choice ) return null;
    if ( choice === "caster" ) docs = [casterToken];
    else docs = Array.from(game.user.targets, token => token.document);
    if ( !docs.length ) ui.notifications.warn(loc("Warn.NoTargets"));
  }
  const infos = docs.map(buildTargetInfo).filter(Boolean);
  if ( !infos.length ) {
    ui.notifications.warn(loc("Warn.NoActorTargets"));
    return null;
  }
  return infos;
}
