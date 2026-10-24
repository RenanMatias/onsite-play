/**
 * Chat summary card and its GM-only Undo button.
 */
import { MODULE_ID, TEMPLATES, loc } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { undoSnapshots } from "./damage.mjs";
import { confirmUndo } from "./dialogs.mjs";
import { restoreAttackResources } from "./ammunition.mjs";

/**
 * Post one summary card for an action.
 * @param {Activity} activity
 * @param {object[]} entries    Summary entries ({name, img, result, segments, notes}).
 * @param {object[]} snapshots  Undo snapshots.
 * @param {object[]} [resources]  Ammunition / thrown weapons spent (see spendAttackResources).
 * @returns {Promise<ChatMessage|void>}
 */
export async function postSummary(activity, entries, snapshots=[], resources=[]) {
  if ( !entries.length ) return;
  const actor = activity.actor;
  const item = activity.item;
  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATES.summary, {
    actorName: actor.name,
    itemName: item.name,
    itemImg: item.img,
    activityName: (activity.name && (activity.name !== item.name)) ? activity.name : null,
    entries: entries.map(e => ({ ...e, detail: e.segments.filter(Boolean).join(", ") })),
    resources: resources.map(r => loc("Ammo.Spent", { name: r.name, from: r.quantity, to: r.remaining })),
    canUndo: (snapshots.length > 0) || (resources.length > 0)
  });
  return ChatMessage.implementation.create({
    content,
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    whisper: getWhisperRecipients(actor),
    flags: { [MODULE_ID]: { summary: true, snapshots, resources } }
  });
}

/**
 * Whisper recipients according to the "visibility" setting (empty array = public).
 * @param {Actor} actor
 * @returns {string[]}
 */
function getWhisperRecipients(actor) {
  const mode = getSetting("visibility");
  if ( mode === "public" ) return [];
  const gms = game.users.filter(u => u.isGM).map(u => u.id);
  if ( mode === "gm" ) return gms;
  const owners = game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id);
  return [...gms, ...owners];
}

/**
 * renderChatMessageHTML hook: show the Undo button to GMs only and wire it up.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderChatMessage(message, html) {
  const flags = message.flags?.[MODULE_ID];
  if ( !flags?.summary ) return;
  const button = html.querySelector("[data-onsite-action='undo']");
  if ( !button ) return;
  if ( !game.user.isGM ) {
    button.remove();
    return;
  }
  if ( flags.undone ) {
    button.disabled = true;
    button.innerHTML = `<i class="fa-solid fa-check"></i> ${loc("Undo.Done")}`;
    return;
  }
  button.addEventListener("click", async event => {
    event.preventDefault();
    if ( !(await confirmUndo()) ) return;
    button.disabled = true;
    await undoSummary(message);
  });
}

/**
 * Restore everything recorded on a summary message and mark it as undone.
 * @param {ChatMessage} message
 */
async function undoSummary(message) {
  if ( !game.user.isGM ) return;
  const flags = message.flags?.[MODULE_ID] ?? {};
  if ( flags.undone ) return;
  try {
    const failures = [
      ...await undoSnapshots(flags.snapshots ?? []),
      ...await restoreAttackResources(flags.resources ?? [])
    ];
    await message.setFlag(MODULE_ID, "undone", true);
    if ( failures.length ) ui.notifications.warn(loc("Undo.Missing", { names: failures.join(", ") }));
    else ui.notifications.info(loc("Undo.Success"));
  } catch(err) {
    console.error(`${MODULE_ID} | Undo failed`, err);
    ui.notifications.error(loc("Undo.Failed"));
  }
}
