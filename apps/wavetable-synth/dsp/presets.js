/* Preset format and validation.
 *
 * Preset = {name, category, version, params: {id: value}}: values in real units (Hz, s, dB, ...),
 * value-list params by label ("LP24", "PWM", "1/8D"). Missing params take the init patch value, so
 * presets stay valid when parameters are added. Unknown params / out-of-range values are errors.
 */
import { normalize, denormalize } from './params.js';

export const PRESET_VERSION = 1;

export function initNorms(schema) {
  const out = {};
  for (const p of schema) out[p.id] = normalize(p, p.default);
  return out;
}

/** Errors (strings) of a preset against the schema; [] when valid. */
export function validatePreset(preset, schema, categories) {
  const errors = [];
  if (!preset || typeof preset !== 'object') return ['preset is not an object'];
  if (typeof preset.name !== 'string' || !preset.name.trim()) errors.push('name missing');
  if (categories && !categories.includes(preset.category)) errors.push(`category "${preset.category}" not in ${categories.join('/')}`);
  if (preset.version !== undefined && preset.version > PRESET_VERSION) errors.push(`version ${preset.version} is newer than ${PRESET_VERSION}`);
  if (!preset.params || typeof preset.params !== 'object') return [...errors, 'params missing'];
  const byId = new Map(schema.map((p) => [p.id, p]));
  for (const [id, v] of Object.entries(preset.params)) {
    const p = byId.get(id);
    if (!p) { errors.push(`unknown param ${id}`); continue; }
    if (p.valueItems) {
      if (typeof v === 'string') { if (!p.valueItems.includes(v)) errors.push(`${id}: "${v}" is not one of ${p.valueItems.join(', ')}`); }
      else if (!Number.isInteger(v) || v < 0 || v >= p.valueItems.length) errors.push(`${id}: ${v} is not a valid index`);
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${id}: not a number`);
    } else if (v < p.min - 1e-9 || v > p.max + 1e-9) {
      errors.push(`${id}: ${v} outside ${p.min}..${p.max}`);
    }
  }
  return errors;
}

/** Normalized values of a preset (init patch for missing params; unknown table names fall back to the default). */
export function presetToNorms(preset, schema) {
  const norms = initNorms(schema);
  const byId = new Map(schema.map((p) => [p.id, p]));
  for (const [id, v] of Object.entries((preset && preset.params) || {})) {
    const p = byId.get(id);
    if (!p) continue;
    norms[id] = normalize(p, v);
  }
  return norms;
}

const round = (v) => Math.round(v * 1e5) / 1e5;

/** Preset from normalized values (only params that differ from the init patch unless `full`). */
export function normsToPreset(norms, schema, meta = {}, full = false) {
  const init = initNorms(schema);
  const params = {};
  for (const p of schema) {
    const n = norms[p.id];
    if (n === undefined || (!full && Math.abs(n - init[p.id]) < 1e-6)) continue;
    const v = denormalize(p, n);
    params[p.id] = p.valueItems ? p.valueItems[Math.round(v)] : round(v);
  }
  return { name: meta.name || 'Untitled', category: meta.category || 'lead', version: PRESET_VERSION, ...(meta.author ? { author: meta.author } : {}), params };
}
