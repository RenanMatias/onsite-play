/**
 * All GM dialogs, built on DialogV2 with Handlebars content.
 * Every prompt resolves to `null` when the GM cancels or closes it, so callers can abort without changes.
 */
import { MODULE_ID, TEMPLATES, loc } from "./constants.mjs";
import { getSetting } from "./settings.mjs";

const { DialogV2 } = foundry.applications.api;
const { renderTemplate } = foundry.applications.handlebars;
const { FormDataExtended } = foundry.applications.ux;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Read a dialog form into a nested object ("rows.0.total" → { rows: { 0: { total } } }).
 * @param {HTMLFormElement} form
 * @returns {object}
 */
function readForm(form) {
  return foundry.utils.expandObject(new FormDataExtended(form).object);
}

/**
 * Coerce a form value to a finite number, or null when blank/invalid.
 * @param {*} value
 * @returns {number|null}
 */
function toNumber(value) {
  if ( (value === null) || (value === undefined) || (value === "") ) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Keep the OK button disabled while the form is invalid. DialogV2 routes button clicks straight to its submit
 * handler (bypassing native `required` validation), and a disabled default button also blocks Enter.
 * @param {HTMLElement} root                       The dialog element.
 * @param {(form: HTMLFormElement) => boolean} validate
 */
function bindValidation(root, validate) {
  const form = root?.querySelector("form");
  const okButton = root?.querySelector("button[data-action='ok']");
  if ( !form || !okButton || form.dataset.onsiteValidation ) return;
  form.dataset.onsiteValidation = "true";
  const update = () => okButton.disabled = !validate(form);
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  update();
}

/**
 * Damage validation: every [data-onsite-damage-group] needs at least one damage input with a value of 1 or more.
 * Invalid groups are highlighted.
 * @param {HTMLFormElement} form
 * @returns {boolean}
 */
function validateDamageGroups(form) {
  let valid = true;
  for ( const group of form.querySelectorAll("[data-onsite-damage-group]") ) {
    const inputs = group.querySelectorAll("input[data-onsite-damage]");
    const ok = Array.from(inputs).some(input => (toNumber(input.value) ?? 0) >= 1);
    group.classList.toggle("onsite-invalid", !ok);
    valid &&= ok;
  }
  return valid;
}

/**
 * Show a form dialog with "OK" and "Cancel" buttons.
 * @param {object} config
 * @param {Function} [config.render]    Extra render callback (event, dialog).
 * @param {Function} [config.validate]  (form) => boolean; OK stays disabled while it returns false.
 * @returns {Promise<object|null>}  Parsed form data, or null if canceled/closed.
 */
async function waitForm({ title, icon, content, okLabel, okIcon="fa-solid fa-check", width=540, render, validate }) {
  const onRender = (event, dialog) => {
    render?.(event, dialog);
    if ( validate ) bindValidation(dialog.element, validate);
  };
  const result = await DialogV2.wait({
    window: { title, icon },
    classes: [MODULE_ID],
    position: { width },
    content,
    buttons: [
      { action: "ok", label: okLabel, icon: okIcon, default: true, callback: (event, button) => readForm(button.form) },
      { action: "cancel", label: loc("Buttons.Cancel"), icon: "fa-solid fa-xmark" }
    ],
    render: onRender,
    rejectClose: false
  });
  // The cancel button resolves to its action string; closing resolves to null.
  return (result && (typeof result === "object")) ? result : null;
}

/**
 * Convert prepared damage parts into per-row template data with unique field names.
 * @param {DamagePartInfo[]} parts
 * @param {string} prefix  Field-name prefix, e.g. "rows.0.parts" or "damage".
 */
function partFields(parts, prefix) {
  return parts.map((part, j) => ({
    ...part,
    valueName: `${prefix}.${j}.value`,
    typeName: `${prefix}.${j}.type`
  }));
}

/**
 * Read damage values for a set of parts from parsed form data.
 * @param {DamagePartInfo[]} parts
 * @param {object} [data]  Parsed data keyed by part index.
 * @returns {DamageInput[]}
 */
function readDamages(parts, data={}) {
  return parts.map((part, j) => ({
    value: Math.max(0, Math.floor(toNumber(data?.[j]?.value) ?? 0)),
    type: data?.[j]?.type ?? part.defaultType,
    properties: part.properties
  }));
}

/* -------------------------------------------- */
/*  Prompts                                     */
/* -------------------------------------------- */

/**
 * Ask the GM to target tokens. The dialog is non-modal so tokens can be targeted while it is open.
 * @param {object} [options]
 * @param {boolean} [options.allowCaster=false]  Show a "Caster" button (target the acting actor's own token).
 * @returns {Promise<"continue"|"caster"|null>}  null for "Cancel"/close.
 */
export async function promptForTargets({ allowCaster=false }={}) {
  const buttons = [
    { action: "continue", label: loc("Buttons.Continue"), icon: "fa-solid fa-arrow-right", default: true }
  ];
  if ( allowCaster ) buttons.push({ action: "caster", label: loc("Buttons.Caster"), icon: "fa-solid fa-user" });
  buttons.push({ action: "cancel", label: loc("Buttons.Cancel"), icon: "fa-solid fa-xmark" });
  const result = await DialogV2.wait({
    window: { title: loc("Targets.Title"), icon: "fa-solid fa-bullseye" },
    classes: [MODULE_ID],
    content: `<p>${loc("Targets.Content")}</p>`,
    buttons
  });
  return ["continue", "caster"].includes(result) ? result : null;
}

/**
 * Ask for the ammunition / attack mode, then the final attack total and natural 1/20 per target.
 * @param {Activity} activity
 * @param {TargetInfo[]} targets
 * @param {AttackOptions} options  From getAttackOptions.
 * @returns {Promise<{
 *   rows: {target: TargetInfo, total: number|null, nat: "none"|"nat20"|"nat1"}[],
 *   ammunition: string|null,
 *   attackMode: string|null
 * }|null>}
 */
export async function promptAttackRolls(activity, targets, options) {
  const content = await renderTemplate(TEMPLATES.attack, {
    ammunition: options.ammunition.length ? {
      choices: Object.fromEntries(options.ammunition.map(a => [a.value, a.label])),
      selected: options.defaultAmmo
    } : null,
    modes: options.modes.length > 1 ? {
      choices: Object.fromEntries(options.modes.map(m => [m.value, m.label])),
      selected: options.defaultMode
    } : null,
    defaultMode: options.defaultMode ?? "",
    showAC: getSetting("showAC"),
    targets: targets.map((t, i) => ({
      name: t.name,
      img: t.img,
      ac: t.ac ?? "?",
      totalCover: t.totalCover,
      hasHP: t.hasHP,
      first: i === 0,
      totalName: `targets.${i}.total`,
      natName: `targets.${i}.nat`
    }))
  });
  const data = await waitForm({
    title: loc("Attack.Title", { item: activity.item.name }),
    icon: "fa-solid fa-dice-d20",
    content,
    okLabel: loc("Buttons.Resolve")
  });
  if ( !data ) return null;
  return {
    rows: targets.map((target, i) => {
      const row = data.targets?.[i] ?? {};
      return { target, total: toNumber(row.total), nat: row.nat ?? "none" };
    }),
    ammunition: data.ammunition || null,
    attackMode: data.attackMode || null
  };
}

/**
 * Ask for damage per target (one number per damage part) and whether to ignore resistances.
 * @param {Activity} activity
 * @param {{target: TargetInfo, critical: boolean}[]} rows
 * @param {DamagePartInfo[]} parts
 * @param {object} [options]
 * @param {boolean} [options.healing=false]  Healing wording, no "ignore resistances" option.
 * @returns {Promise<{target: TargetInfo, damages: DamageInput[], ignore: boolean}[]|null>}
 */
export async function promptDamage(activity, rows, parts, { healing=false }={}) {
  const content = await renderTemplate(TEMPLATES.damage, {
    healing,
    hint: loc(healing ? "Heal.Hint" : "Damage.Hint"),
    required: loc(healing ? "Heal.Required" : "Damage.Required"),
    rows: rows.map((row, i) => ({
      name: row.target.name,
      img: row.target.img,
      critical: row.critical,
      hasHP: row.target.hasHP,
      ignoreName: `rows.${i}.ignore`,
      parts: partFields(parts, `rows.${i}.parts`).map((part, j) => ({ ...part, autofocus: (i === 0) && (j === 0) }))
    }))
  });
  const data = await waitForm({
    title: loc(healing ? "Heal.Title" : "Damage.Title", { item: activity.item.name }),
    icon: healing ? "fa-solid fa-heart-pulse" : "fa-solid fa-burst",
    content,
    okLabel: loc("Buttons.Apply"),
    validate: validateDamageGroups
  });
  if ( !data ) return null;
  return rows.map((row, i) => {
    const rowData = data.rows?.[i] ?? {};
    return { target: row.target, damages: readDamages(parts, rowData.parts), ignore: !!rowData.ignore };
  });
}

/**
 * Ask for the shared damage total and the save outcome of every target.
 * @param {Activity} activity  A save activity.
 * @param {TargetInfo[]} targets
 * @param {DamagePartInfo[]} parts
 * @returns {Promise<{dc: number|null, damages: DamageInput[], rows: SaveRow[]}|null>}
 */
export async function promptSaves(activity, targets, parts) {
  let abilities = Array.from(activity.save?.ability ?? []);
  if ( !abilities.length ) abilities = Object.keys(CONFIG.DND5E.abilities);
  const abilityChoices = Object.fromEntries(abilities.map(a => [a, CONFIG.DND5E.abilities[a]?.label ?? a]));
  const dc = activity.save?.dc?.value;
  const onSave = activity.damage?.onSave ?? "half";

  const content = await renderTemplate(TEMPLATES.save, {
    dc: Number.isFinite(dc) ? dc : "",
    hasDamage: parts.length > 0,
    onSaveLabel: loc(`Save.OnSave.${onSave}`),
    damage: partFields(parts, "damage"),
    multipleAbilities: abilities.length > 1,
    abilityChoices,
    defaultAbility: abilities[0],
    abilityLabel: abilityChoices[abilities[0]],
    rows: targets.map((t, i) => ({
      index: i,
      name: t.name,
      img: t.img,
      hasHP: t.hasHP,
      outcomeName: `rows.${i}.outcome`,
      totalName: `rows.${i}.total`,
      abilityName: `rows.${i}.ability`,
      ignoreName: `rows.${i}.ignore`
    }))
  });

  const data = await waitForm({
    title: loc("Save.Title", { item: activity.item.name }),
    icon: "fa-solid fa-shield-heart",
    content,
    okLabel: loc("Buttons.Apply"),
    width: 640,
    render: (event, dialog) => bindSaveDialog(dialog.element, targets, abilities[0]),
    validate: validateDamageGroups
  });
  if ( !data ) return null;

  const dcValue = toNumber(data.dc);
  const rows = targets.map((target, i) => {
    const row = data.rows?.[i] ?? {};
    const total = toNumber(row.total);
    let outcome = null;
    if ( (row.outcome === "pass") || (row.outcome === "fail") ) outcome = row.outcome;
    else if ( (row.outcome === "total") && (total !== null) && (dcValue !== null) ) {
      outcome = total >= dcValue ? "pass" : "fail";
    }
    return {
      target,
      outcome,
      total: row.outcome === "total" ? total : null,
      ability: row.ability || abilities[0],
      ignore: !!row.ignore
    };
  });
  return { dc: dcValue, damages: readDamages(parts, data.damage), rows };
}

/**
 * Wire up the interactive parts of the save dialog: "Roll for me", auto-selecting "Total" when typing,
 * and the "All fail / All pass" shortcuts.
 * @param {HTMLElement} root
 * @param {TargetInfo[]} targets
 * @param {string} defaultAbility
 */
function bindSaveDialog(root, targets, defaultAbility) {
  if ( !root || root.dataset.onsiteBound ) return;
  root.dataset.onsiteBound = "true";

  const checkOutcome = (index, value) => {
    const radio = root.querySelector(`input[name="rows.${index}.outcome"][value="${value}"]`);
    if ( radio ) radio.checked = true;
  };

  for ( const input of root.querySelectorAll("input[data-onsite-total]") ) {
    input.addEventListener("input", () => checkOutcome(input.dataset.onsiteTotal, "total"));
  }

  for ( const button of root.querySelectorAll("[data-onsite-all]") ) {
    button.addEventListener("click", event => {
      event.preventDefault();
      targets.forEach((t, i) => checkOutcome(i, button.dataset.onsiteAll));
    });
  }

  for ( const button of root.querySelectorAll("[data-onsite-roll]") ) {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const index = Number(button.dataset.onsiteRoll);
      const target = targets[index];
      if ( !target?.actor?.rollSavingThrow ) return;
      const ability = root.querySelector(`[name="rows.${index}.ability"]`)?.value || defaultAbility;
      const dc = toNumber(root.querySelector("[name='dc']")?.value);
      button.disabled = true;
      try {
        // Normal dnd5e save roll for the target (posts its own chat card).
        const rolls = await target.actor.rollSavingThrow({ ability, target: dc ?? undefined });
        const total = rolls?.[0]?.total;
        if ( Number.isFinite(total) ) {
          const input = root.querySelector(`[name="rows.${index}.total"]`);
          if ( input ) input.value = total;
          checkOutcome(index, "total");
        }
      } catch(err) {
        console.error(`${MODULE_ID} | Save roll failed`, err);
      } finally {
        button.disabled = false;
      }
    });
  }
}

/**
 * Ask whether a save activity on the same item should also be resolved for the targets that were hit.
 * @param {Activity} saveActivity
 * @param {number} count
 * @returns {Promise<boolean>}
 */
export async function confirmChain(saveActivity, count) {
  const name = foundry.utils.escapeHTML(saveActivity.name || saveActivity.item.name);
  const result = await DialogV2.confirm({
    window: { title: loc("Chain.Title"), icon: "fa-solid fa-link" },
    classes: [MODULE_ID],
    content: `<p>${loc("Chain.Content", { name, count })}</p>`
  });
  return result === true;
}

/**
 * Confirm an undo.
 * @returns {Promise<boolean>}
 */
export async function confirmUndo() {
  const result = await DialogV2.confirm({
    window: { title: loc("Undo.Title"), icon: "fa-solid fa-rotate-left" },
    classes: [MODULE_ID],
    content: `<p>${loc("Undo.Content")}</p>`
  });
  return result === true;
}
