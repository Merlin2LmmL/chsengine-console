// Thin localStorage wrapper. Everything is namespaced under "chsc:" (chsengine console)
// so this page doesn't collide with anything else on the same origin.

const PREFIX = 'chsc:';

export function saveJSON(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('store: failed to save', key, e);
    return false;
  }
}

export function loadJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('store: failed to load', key, e);
    return fallback;
  }
}

export function remove(key) {
  localStorage.removeItem(PREFIX + key);
}
