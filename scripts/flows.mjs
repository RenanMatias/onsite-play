/**
 * Flow orchestration: attack, saving throw, and damage-only flows.
 * Flows only run on a GM client. Player clients forward the request to the active GM via a user query.
 */
import { MODULE_ID, FLOW_MODES, loc } from "./constants.mjs";
import * as dialogs from "./dialogs.mjs";
import { acquireTargets, refreshTarget } from "./targets.mjs";
import {
  SAVE_MULTIPLIERS, applyDamageToTarget, applyHealingToTarget, damageTypeLabel, getDamageParts
} from "./damage.mjs";
import { postSummary } from "./chat.mjs";
import { getAttackOptions, spendAttackResources, validateAttackResources } from "./ammunition.mjs";

/* -------------------------------------------- */
/*  Entry points                                */
/* -------------------------------------------- */

/**
 * Start a flow from any client. On a GM client it runs locally; otherwise the active GM is asked to run it.
 * @param {object} request
 * @param {Activity} request.activity
 * @param {"attack"|"save"|"damage"} request.mode
 * @param {number} [request.scaling]
 */
export async function requestFlow({ activity, mode, scaling }) {
  const targetUuids = Array.from(game.user.targets, token => token.document.uuid);
  if ( game.user.isGM ) return runFlow({ activity, mode, scaling, targetUuids });

  const gm = game.users.activeGM;
  if ( !gm ) {
    ui.notifications.warn(loc("Warn.NoGM"));
    return;
  }
  try {
    await gm.query(`${MODULE_ID}.runFlow`, { activityUuid: activity.uuid, mode, scaling, targetUuids });
    ui.notifications.info(loc("Info.SentToGM"));
  } catch(err) {
    console.error(`${MODULE_ID} | Could not send the flow to the GM`, err);
    ui.notifications.error(loc("Warn.QueryFailed"));
  }
}

/**
 * Query handler (registered in CONFIG.queries) run on the active GM's client.
 * Returns immediately; the dialogs continue in the background so the query never times out.
 * @param {{activityUuid: string, mode: string, scaling?: number, targetUuids?: string[]}} data
 * @param {{user: User}} context
 */
export async function handleFlowQuery(data, { user }) {
  if ( !game.user.isActiveGM ) throw new Error("Only the active GM can run Onsite Play flows.");
  if ( !FLOW_MODES.has(data?.mode) ) throw new Error(`Invalid flow mode "${data?.mode}".`);
  const activity = await fromUuid(data.activityUuid);
  if ( !activity?.actor ) throw new Error(`Activity ${data.activityUuid} not found.`);
  if ( !activity.actor.testUserPermission(user, "OWNER") ) throw new Error("The requesting user does not own this actor.");
  runFlow({
    activity,
    mode: data.mode,
    scaling: Number.isFinite(data.scaling) ? data.scaling : undefined,
    targetUuids: Array.isArray(data.targetUuids) ? data.targetUuids : []
  });
  return true;
}

/**
 * Run a flow on this (GM) client.
 * @param {object} request
 * @param {Activity} request.activity
 * @param {"attack"|"save"|"damage"} request.mode
 * @param {number} [request.scaling]
 * @param {string[]} [request.targetUuids]
 */
export async function runFlow({ activity, mode, scaling, targetUuids=[] }) {
  if ( !game.user.isGM ) return;
  try {
    // Healing is often cast on oneself, so the target prompt offers the caster's token.
    const targets = await acquireTargets(targetUuids, { caster: mode === "heal" ? activity.actor : null });
    if ( !targets ) return;
    switch ( mode ) {
      case "attack": return await runAttackFlow(activity, targets, { scaling });
      case "save": return await runSaveFlow(activity, targets, { scaling });
      case "damage": return await runDamageFlow(activity, targets, { scaling });
      case "heal": return await runHealFlow(activity, targets, { scaling });
    }
  } catch(err) {
    console.error(`${MODULE_ID} | Flow failed`, err);
    ui.notifications.error(loc("Warn.FlowError"));
  }
}

/* -------------------------------------------- */
/*  Flow 1 — Attack                             */
/* -------------------------------------------- */

/**
 * Attack totals → hit/miss per target → damage for hits → apply → summary → optional save chain.
 * Nothing is applied if any dialog is canceled.
 */
async function runAttackFlow(activity, targets, { scaling }) {
  const input = await dialogs.promptAttackRolls(activity, targets, getAttackOptions(activity));
  if ( !input ) return;
  const outcomes = input.rows.map(roll => ({ ...roll, ...resolveAttack(roll) }));
  const hits = outcomes.filter(o => o.hit);

  // Each non-skipped target is one attack roll, and spends one piece of ammunition / one thrown weapon.
  const choice = { ammunition: input.ammunition, attackMode: input.attackMode };
  const attackCount = outcomes.filter(o => o.result !== "skip").length;
  if ( !validateAttackResources(activity, choice, attackCount) ) return;

  const parts = getDamageParts(activity, { scaling, ...choice });
  let damageRows = null;
  if ( hits.length && parts.length ) {
    damageRows = await dialogs.promptDamage(activity, hits.map(o => ({ target: o.target, critical: o.critical })), parts);
    if ( !damageRows ) return;
  }

  // Spend only once every dialog has been confirmed.
  const resources = await spendAttackResources(activity, choice, attackCount);

  const entries = [];
  const snapshots = [];
  let hitIndex = 0;
  for ( const outcome of outcomes ) {
    const entry = createEntry(outcome.target, outcome.result);
    if ( outcome.result === "skip" ) {
      entry.segments.push(loc("Summary.Skipped"));
      entries.push(entry);
      continue;
    }
    entry.segments.push(describeAttack(outcome), loc(`Result.${outcome.result}`));
    if ( !outcome.hit ) {
      entry.notes.push(loc("Summary.Missed", { attacker: activity.actor.name, target: outcome.target.name }));
    } else if ( damageRows ) {
      const row = damageRows[hitIndex++];
      await applyAndDescribe(row.target, row.damages, { ignore: row.ignore }, entry, snapshots);
    }
    entries.push(entry);
  }

  await postSummary(activity, entries, snapshots, resources);
  if ( hits.length ) await offerSaveChain(activity, hits.map(o => o.target), { scaling });
}

/**
 * Compare an attack total with the target's AC.
 * @param {{target: TargetInfo, total: number|null, nat: string}} roll
 * @returns {{result: "hit"|"crit"|"miss"|"skip", hit: boolean, critical: boolean}}
 */
function resolveAttack({ target, total, nat }) {
  if ( nat === "nat1" ) return { result: "miss", hit: false, critical: false };
  if ( nat === "nat20" ) return { result: "crit", hit: true, critical: true };
  if ( total === null ) return { result: "skip", hit: false, critical: false };
  // Unknown AC: the GM entered a total, treat it as a hit and let them adjust damage.
  if ( (target.ac === null) || (total >= target.ac) ) return { result: "hit", hit: true, critical: false };
  return { result: "miss", hit: false, critical: false };
}

/** "17 vs AC 15", "natural 20", "17 (natural 20) vs AC 15"... */
function describeAttack({ target, total, nat }) {
  const natLabel = nat === "nat20" ? loc("Summary.Nat20") : nat === "nat1" ? loc("Summary.Nat1") : null;
  if ( total === null ) return natLabel ?? "";
  const totalText = natLabel ? `${total} (${natLabel})` : `${total}`;
  return target.ac === null
    ? loc("Summary.AttackTotal", { total: totalText })
    : loc("Summary.AttackVs", { total: totalText, ac: target.ac });
}

/**
 * After an attack, offer to resolve save activities on the same item for the targets that were hit
 * (dnd5e activities are single-type, so "attack + save" items have two activities).
 */
async function offerSaveChain(activity, hitTargets, { scaling }) {
  const saves = activity.item?.system.activities?.filter(a => (a.type === "save") && (a.id !== activity.id)) ?? [];
  for ( const save of saves ) {
    if ( !(await dialogs.confirmChain(save, hitTargets.length)) ) continue;
    const fresh = hitTargets.map(refreshTarget).filter(Boolean);
    if ( fresh.length ) await runSaveFlow(save, fresh, { scaling });
  }
}

/* -------------------------------------------- */
/*  Flow 2 — Saving throws                      */
/* -------------------------------------------- */

/**
 * Damage entered once → save outcome per target → full damage on fail, onSave multiplier on success.
 */
async function runSaveFlow(activity, targets, { scaling }) {
  const parts = getDamageParts(activity, { scaling });
  const input = await dialogs.promptSaves(activity, targets, parts);
  if ( !input ) return;

  const onSave = activity.damage?.onSave ?? "half";
  const hasDamage = input.damages.some(d => d.value > 0);
  const entries = [];
  const snapshots = [];
  for ( const row of input.rows ) {
    const entry = createEntry(row.target, row.outcome ?? "skip");
    if ( !row.outcome ) {
      entry.segments.push(loc("Summary.NoSaveOutcome"));
      entries.push(entry);
      continue;
    }
    entry.segments.push(describeSave(row, input.dc), loc(`Result.${row.outcome}`));
    if ( hasDamage ) {
      const multiplier = row.outcome === "fail" ? 1 : (SAVE_MULTIPLIERS[onSave] ?? 0.5);
      if ( multiplier > 0 ) {
        await applyAndDescribe(row.target, input.damages, { ignore: row.ignore, multiplier }, entry, snapshots);
      } else entry.segments.push(loc("Summary.NoDamage"));
    }
    entries.push(entry);
  }
  await postSummary(activity, entries, snapshots);
}

/** "DEX save 14 vs DC 15" or "DEX save" (manual pass/fail). */
function describeSave(row, dc) {
  const config = CONFIG.DND5E.abilities[row.ability];
  const ability = config ? game.i18n.localize(config.abbreviation ?? config.label).toUpperCase() : row.ability;
  if ( row.total === null ) return loc("Summary.SaveManual", { ability });
  return loc("Summary.SaveVs", { ability, total: row.total, dc: dc ?? "?" });
}

/* -------------------------------------------- */
/*  Damage-only flow                            */
/* -------------------------------------------- */

/** Damage per target, no hit check (Magic Missile, or the "Damage" button on an attack card). */
async function runDamageFlow(activity, targets, { scaling }) {
  // For attacks, show the formula of the last-used ammunition / attack mode (nothing is spent here).
  const options = activity.type === "attack" ? getAttackOptions(activity) : {};
  const parts = getDamageParts(activity, { scaling, ammunition: options.defaultAmmo, attackMode: options.defaultMode });
  if ( !parts.length ) {
    ui.notifications.warn(loc("Warn.NoDamageParts"));
    return;
  }
  const rows = await dialogs.promptDamage(activity, targets.map(target => ({ target, critical: false })), parts);
  if ( !rows ) return;

  const entries = [];
  const snapshots = [];
  for ( const row of rows ) {
    const entry = createEntry(row.target, "damage");
    await applyAndDescribe(row.target, row.damages, { ignore: row.ignore }, entry, snapshots);
    entries.push(entry);
  }
  await postSummary(activity, entries, snapshots);
}

/* -------------------------------------------- */
/*  Healing flow                                */
/* -------------------------------------------- */

/** Healing per target (Cure Wounds, Healing Word, False Life...), applied through dnd5e. */
async function runHealFlow(activity, targets, { scaling }) {
  const parts = getDamageParts(activity, { scaling });
  if ( !parts.length ) {
    ui.notifications.warn(loc("Warn.NoHealingParts"));
    return;
  }
  const rows = await dialogs.promptDamage(activity, targets.map(target => ({ target, critical: false })), parts,
    { healing: true });
  if ( !rows ) return;

  const entries = [];
  const snapshots = [];
  for ( const row of rows ) {
    const entry = createEntry(row.target, "heal");
    const result = await applyHealingToTarget(row.target, row.damages);
    if ( result.snapshot ) snapshots.push(result.snapshot);
    if ( result.noHP ) entry.segments.push(loc("Summary.NoHP"));
    else {
      const rolled = row.damages.filter(d => d.value > 0)
        .map(d => `${d.value} ${damageTypeLabel(d.type).toLowerCase()}`).join(" + ");
      entry.segments.push(loc("Summary.Healing", { healing: rolled }));
      if ( result.tempGained ) entry.segments.push(loc("Summary.TempHP", { amount: result.tempGained }));
      entry.segments.push(loc("Summary.HP", { from: result.hpBefore, to: result.hpAfter }));
      if ( result.revived ) entry.notes.push(loc("Summary.Revived", { target: row.target.name }));
    }
    entries.push(entry);
  }
  await postSummary(activity, entries, snapshots);
}

/* -------------------------------------------- */
/*  Shared helpers                              */
/* -------------------------------------------- */

/**
 * A summary line for one target.
 * @param {TargetInfo} target
 * @param {string} result  CSS modifier (hit, crit, miss, pass, fail, skip, damage).
 */
function createEntry(target, result) {
  return { name: target.name, img: target.img, result, segments: [], notes: [] };
}

/**
 * Apply damage and append its description to a summary entry.
 * @param {TargetInfo} target
 * @param {DamageInput[]} damages
 * @param {object} options     Passed to applyDamageToTarget.
 * @param {object} entry       Summary entry (mutated).
 * @param {object[]} snapshots Undo snapshots (mutated).
 */
async function applyAndDescribe(target, damages, options, entry, snapshots) {
  const result = await applyDamageToTarget(target, damages, options);
  if ( result.snapshot ) snapshots.push(result.snapshot);

  if ( result.noHP ) {
    entry.segments.push(loc("Summary.NoHP"));
    return;
  }

  const dealt = damages.filter(d => d.value > 0);
  if ( !dealt.length ) entry.segments.push(loc("Summary.NoDamage"));
  else {
    const text = dealt.map(d => `${d.value} ${damageTypeLabel(d.type).toLowerCase()}`).join(" + ");
    let segment = loc("Summary.Damage", { damage: text });
    if ( result.multiplier === 0.5 ) segment += ` ${loc("Summary.Halved")}`;
    const expected = Math.trunc(dealt.reduce((sum, d) => sum + d.value, 0) * result.multiplier);
    if ( result.applied !== expected ) segment += ` ${loc("Summary.Applied", { amount: result.applied })}`;
    entry.segments.push(segment);
  }

  entry.segments.push(loc("Summary.HP", { from: result.hpBefore, to: result.hpAfter }));
  if ( result.alreadyDown ) entry.segments.push(loc("Summary.AlreadyDown"));
  if ( result.removed ) entry.segments.push(loc("Summary.Removed"));
  else if ( result.defeated ) entry.segments.push(loc("Summary.Defeated"));

  if ( result.fallen ) {
    entry.notes.push(loc(result.pcDown ? "Summary.Unconscious" : "Summary.Fallen", { target: target.name }));
  }
}
