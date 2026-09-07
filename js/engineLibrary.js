// Engine library using indexedDB (idb-keyval) for wasm-uci / chsengine bundles.
// Validates uploaded .zip via engineLoader.parseBundle (replicates readManifest).
import { get, set, del, createStore } from 'https://esm.sh/idb-keyval@6.1.0';
import { parseBundle, BundleParseError } from './engineLoader.js';

const store = createStore('chsengine-play', 'library');
const INDEX_KEY = '__index__';

async function readIndex() {
  return (await get(INDEX_KEY, store)) || [];
}

async function writeIndex(ids) {
  await set(INDEX_KEY, ids, store);
}

export async function listEngines() {
  const ids = await readIndex();
  const records = [];
  for (const id of ids) {
    const record = await get(`meta:${id}`, store);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.addedAt - a.addedAt);
}

/** @param {File} file */
export async function addEngine(file) {
  // Read ZIP contents as {filename: content}
  const JSZip = window.JSZip || (await import('https://esm.sh/jszip@3.10.1')).default;
  const zip = await JSZip.loadAsync(file);
  const files = {};
  const entries = Object.keys(zip.files || {});
  for (const name of entries) {
    if (zip.files[name].dir) continue;
    const content = await zip.files[name].async(name.endsWith('.wasm') ? 'arraybuffer' : 'string');
    files[name] = content;
  }
  // Validate via existing loader (supports chsengine / wasm-uci)
  parseBundle(files); // throws on invalid
  const id = crypto.randomUUID();
  const manifestRaw = files['manifest.json'];
  let manifest = {};
  try { manifest = JSON.parse(manifestRaw); } catch (e) { /* ignore */ }
  const record = { id, manifest, addedAt: Date.now(), sourceName: file.name };
  await set(`meta:${id}`, record, store);
  await set(`blob:${id}`, file, store);
  const ids = await readIndex();
  ids.push(id);
  await writeIndex(ids);
  return record;
}

/** @returns {Promise<Blob|undefined>} */
export async function getEngineBlob(id) {
  return get(`blob:${id}`, store);
}

export async function removeEngine(id) {
  await del(`meta:${id}`, store);
  await del(`blob:${id}`, store);
  const ids = await readIndex();
  await writeIndex(ids.filter((x) => x !== id));
}
