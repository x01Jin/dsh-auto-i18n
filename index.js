import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'auto-i18n';
export const inject = ['connection'];

const MAX_BODY_CHARS = 256 * 1024;
const MAX_TEXTS = 64;
const MAX_TEXT_CHARS = 4000;
const CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 20000;
const PROVIDERS = ['google', 'bing'];

function cacheFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'auto-i18n-cache.json');
}

function json(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

export function apply(ctx) {
  const cache = new Map();
  let loaded = false;
  let dirty = false;
  let saveTimer = null;
  let preferred = PROVIDERS[0];
  let failures = 0;
  let blockedUntil = 0;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(readFileSync(cacheFile(), 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === 'string' && value !== '' && value !== key) cache.set(key, value);
        }
      }
    } catch {
      cache.clear();
    }
  }

  async function save() {
    if (!dirty) return;
    dirty = false;
    const file = cacheFile();
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(cache)), 'utf8');
      await rename(tmp, file);
    } catch (error) {
      ctx.logger?.warn?.(`[auto-i18n] cache write failed: ${error}`);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save();
    }, 1000);
    saveTimer.unref?.();
  }

  function trimCache() {
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) return;
      cache.delete(oldest);
    }
  }

  async function translateOne(translator, text) {
    if (Date.now() < blockedUntil) return null;
    const order = preferred === 'bing' ? ['bing', 'google'] : ['google', 'bing'];
    for (const provider of order) {
      try {
        const spec = translator.resolve({ text, targetLanguage: 'en', provider });
        const out = await translator.translate(spec, AbortSignal.timeout(12000));
        if (typeof out === 'string' && out.trim() !== '') {
          preferred = provider;
          failures = 0;
          return out;
        }
      } catch {
        continue;
      }
    }
    preferred = preferred === 'google' ? 'bing' : 'google';
    failures += 1;
    if (failures >= 3) {
      failures = 0;
      blockedUntil = Date.now() + 60000;
    }
    return null;
  }

  async function translateTexts(texts) {
    const unique = [...new Set(texts)];
    const results = new Map();
    const missing = [];
    for (const text of unique) {
      const hit = cache.get(text);
      if (hit !== undefined) results.set(text, hit);
      else missing.push(text);
    }
    if (missing.length === 0) return results;
    const translator = ctx.get('translator');
    if (!translator) throw new Error('translator-unavailable');
    const queue = missing.slice();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const text = queue.shift();
        if (text === undefined) return;
        const out = await translateOne(translator, text);
        if (out === null || out === text) {
          results.set(text, text);
          continue;
        }
        results.set(text, out);
        cache.set(text, out);
        scheduleSave();
      }
    });
    await Promise.all(workers);
    trimCache();
    return results;
  }

  async function handleTranslate(request) {
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) return json(413, { ok: false, error: 'body-too-large' });
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: 'invalid-body' });
    }
    const requested = Array.isArray(body?.texts) ? body.texts : [];
    const texts = requested
      .filter((text) => typeof text === 'string' && text !== '' && text.length <= MAX_TEXT_CHARS)
      .slice(0, MAX_TEXTS);
    if (texts.length === 0) return json(200, { ok: true, translations: [], provider: preferred });
    load();
    let results;
    try {
      results = await translateTexts(texts);
    } catch (error) {
      if (error instanceof Error && error.message === 'translator-unavailable') {
        return json(503, { ok: false, error: 'translator-unavailable' });
      }
      throw error;
    }
    return json(200, {
      ok: true,
      provider: preferred,
      translations: texts.map((text) => results.get(text) ?? text),
    });
  }

  const off = ctx.connection.fetch.register({
    path: '/api/dsh-auto-i18n/translate',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleTranslate(request),
  });
  ctx.effect(() => off, 'auto-i18n: translate route');
  ctx.effect(() => () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    void save();
  }, 'auto-i18n: cache flush');
}
