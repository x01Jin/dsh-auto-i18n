window.__ModuleLoader__.load({
  id: 'dsh-auto-i18n',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
    const BATCH_SIZE = 24;
    const CACHE_KEY = 'dsh-auto-i18n.cache.v1';
    const ENABLED_KEY = 'dsh-auto-i18n.enabled';
    const SKIP = [
      'script', 'style', 'noscript', 'textarea', 'code', 'pre',
      'kbd', 'samp', 'svg', 'canvas', 'iframe',
      '[contenteditable=""]', '[contenteditable="true"]',
      '[class*="markdown"]', '[class*="cm-editor"]', '[class*="monaco"]',
    ].join(',');

    const listeners = new Set();
    let enabled = readEnabled();

    function readEnabled() {
      try {
        return localStorage.getItem(ENABLED_KEY) !== '0';
      } catch {
        return true;
      }
    }

    function writeEnabled(value) {
      try {
        localStorage.setItem(ENABLED_KEY, value ? '1' : '0');
      } catch {}
    }

    const memory = new Map();
    loadCache();
    let cacheTimer = null;

    function loadCache() {
      try {
        const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        if (raw && typeof raw === 'object') {
          for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'string') memory.set(key, value);
          }
        }
      } catch {
        memory.clear();
      }
    }

    function saveCacheSoon() {
      if (cacheTimer) return;
      cacheTimer = setTimeout(() => {
        cacheTimer = null;
        try {
          const entries = [...memory.entries()].slice(-4000);
          localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch {}
      }, 600);
    }

    async function requestTranslations(keys) {
      const url = new URL('api/dsh-auto-i18n/translate', document.baseURI).href;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: keys }),
      });
      if (!response.ok) throw new Error(`translate route returned ${response.status}`);
      const data = await response.json();
      if (!data || data.ok !== true || !Array.isArray(data.translations)) {
        throw new Error('translate route returned an invalid payload');
      }
      return data.translations;
    }

    function createEngine() {
      const textRecords = new Map();
      const attrRecords = new Map();
      const pendingTexts = new Set();
      const pendingElements = new Set();
      const skipped = new Set();
      let flushTimer = null;
      let observer = null;
      let active = false;
      let disposed = false;
      let flushing = false;

      function skippedNode(node) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        return !element || element.closest(SKIP) !== null;
      }

      function queueText(node) {
        if (!active || !node.isConnected) return;
        const value = node.nodeValue;
        if (value === null || !CJK.test(value)) return;
        const record = textRecords.get(node);
        if (record !== undefined && value === record.translated) return;
        if (skippedNode(node)) return;
        pendingTexts.add(node);
      }

      function queueElement(element) {
        if (!active || !element.isConnected) return;
        if (skippedNode(element)) return;
        for (const name of ATTRS) {
          const value = element.getAttribute(name);
          if (value !== null && CJK.test(value)) {
            pendingElements.add(element);
            return;
          }
        }
      }

      function scan(root) {
        if (root.nodeType === 3) {
          queueText(root);
          return;
        }
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        if (root.nodeType === 1) queueElement(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node !== null) {
          if (node.nodeType === 3) queueText(node);
          else queueElement(node);
          node = walker.nextNode();
        }
      }

      function schedule() {
        if (flushTimer || flushing || !active) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void flush();
        }, 140);
      }

      function applyText(node, translated) {
        const current = node.nodeValue;
        if (current === null) return;
        const lead = current.match(/^\s*/)[0];
        const trail = current.match(/\s*$/)[0];
        const next = `${lead}${translated}${trail}`;
        textRecords.set(node, { source: current, translated: next });
        node.nodeValue = next;
      }

      function applyAttr(element, name, translated) {
        const current = element.getAttribute(name);
        if (current === null) return;
        let record = attrRecords.get(element);
        if (!record) {
          record = {};
          attrRecords.set(element, record);
        }
        record[name] = { source: current, translated };
        element.setAttribute(name, translated);
      }

      async function flush() {
        if (!active || disposed) return;
        if (flushing) {
          schedule();
          return;
        }
        flushing = true;
        try {
          await flushOnce();
        } finally {
          flushing = false;
          if (pendingTexts.size > 0 || pendingElements.size > 0) schedule();
        }
      }

      async function flushOnce() {
        const texts = [...pendingTexts];
        pendingTexts.clear();
        const elements = [...pendingElements];
        pendingElements.clear();
        const byKey = new Map();
        for (const node of texts) {
          if (!node.isConnected) {
            textRecords.delete(node);
            continue;
          }
          const value = node.nodeValue;
          if (value === null || !CJK.test(value) || skippedNode(node)) continue;
          const key = value.trim();
          if (key === '' || key.length > 4000) continue;
          const list = byKey.get(key);
          if (list) list.push(node);
          else byKey.set(key, [node]);
        }
        const attrJobs = [];
        for (const element of elements) {
          if (!element.isConnected || skippedNode(element)) continue;
          for (const name of ATTRS) {
            const value = element.getAttribute(name);
            if (value === null || !CJK.test(value)) continue;
            const key = value.trim();
            if (key === '' || key.length > 4000) continue;
            attrJobs.push({ element, name, key });
            const list = byKey.get(key);
            if (!list) byKey.set(key, []);
          }
        }
        const missing = [...byKey.keys()].filter((key) => !memory.has(key) && !skipped.has(key));
        let learned = false;
        for (let index = 0; index < missing.length; index += BATCH_SIZE) {
          const batch = missing.slice(index, index + BATCH_SIZE);
          try {
            const values = await requestTranslations(batch);
            batch.forEach((key, offset) => {
              const value = values[offset];
              if (typeof value === 'string' && value !== '' && value !== key) {
                memory.set(key, value);
                learned = true;
              } else {
                skipped.add(key);
              }
            });
          } catch {
            for (const key of batch) skipped.add(key);
          }
        }
        if (learned) saveCacheSoon();
        if (skipped.size > 5000) skipped.clear();
        if (textRecords.size > 4000) {
          for (const node of textRecords.keys()) {
            if (!node.isConnected) textRecords.delete(node);
          }
        }
        if (disposed || !active) return;
        for (const [key, nodes] of byKey) {
          const translated = memory.get(key);
          if (translated === undefined || translated === key) continue;
          for (const node of nodes) {
            const value = node.nodeValue;
            if (value === null || value.trim() !== key) continue;
            applyText(node, translated);
          }
        }
        for (const job of attrJobs) {
          const translated = memory.get(job.key);
          if (translated === undefined || translated === job.key) continue;
          if (job.element.getAttribute(job.name)?.trim() !== job.key) continue;
          applyAttr(job.element, job.name, translated);
        }
      }

      function onMutations(records) {
        if (!active) return;
        let touched = false;
        for (const record of records) {
          if (record.type === 'characterData') {
            const known = textRecords.get(record.target);
            const value = record.target.nodeValue;
            if (known !== undefined && value === known.translated) continue;
            queueText(record.target);
            touched = true;
          } else if (record.type === 'childList') {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1 || node.nodeType === 3) scan(node);
            }
            touched = true;
          } else if (record.type === 'attributes' && record.attributeName !== null) {
            queueElement(record.target);
            touched = true;
          }
        }
        if (touched) schedule();
      }

      function start() {
        if (disposed || active) return;
        const root = document.body || document.documentElement;
        if (!root) {
          setTimeout(start, 100);
          return;
        }
        active = true;
        scan(root);
        observer = new MutationObserver(onMutations);
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ATTRS,
        });
        schedule();
      }

      function stop() {
        active = false;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (observer) observer.disconnect();
        observer = null;
        for (const [node, record] of textRecords) {
          if (node.isConnected && node.nodeValue === record.translated) node.nodeValue = record.source;
        }
        textRecords.clear();
        for (const [element, record] of attrRecords) {
          if (!element.isConnected) continue;
          for (const [name, value] of Object.entries(record)) {
            if (element.getAttribute(name) === value.translated) element.setAttribute(name, value.source);
          }
        }
        attrRecords.clear();
        pendingTexts.clear();
        pendingElements.clear();
      }

      function dispose() {
        stop();
        disposed = true;
      }

      return { start, stop, dispose };
    }

    function setEnabled(value) {
      enabled = value;
      writeEnabled(value);
      if (engine) {
        if (value) engine.start();
        else engine.stop();
      }
      for (const listener of listeners) listener();
    }

    let engine = null;

    function SettingsRow() {
      const [on, setOn] = React.useState(enabled);
      React.useEffect(() => {
        const listener = () => setOn(enabled);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }, []);
      return h('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '24px',
          padding: '16px 0',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, h('div', null,
        h('div', { style: { fontSize: '14px', lineHeight: '20px' } }, 'Auto translate'),
        h('div', {
          style: {
            color: 'var(--dsw-alias-label-secondary)',
            marginTop: '4px',
            fontSize: '12px',
            lineHeight: '18px',
          },
        }, 'Turns Chinese interface text from installed plugins into English through Google or Bing.'),
      ), h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': 'Auto translate',
        onClick: () => setEnabled(!on),
        style: {
          position: 'relative',
          width: '36px',
          height: '20px',
          flex: 'none',
          padding: 0,
          border: 'none',
          borderRadius: '999px',
          cursor: 'pointer',
          background: on
            ? 'var(--dsw-alias-button-primary-fill)'
            : 'var(--dsw-alias-bg-layer-3)',
          transition: 'background 150ms',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: '2px',
          left: on ? '18px' : '2px',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          background: 'var(--dsw-alias-switch-thumb, #fff)',
          transition: 'left 150ms',
        },
      })));
    }

    return {
      name: 'auto-i18n',
      inject: ['slots'],
      apply(ctx) {
        engine = createEngine();
        ctx.effect(() => {
          if (enabled) engine.start();
          return () => engine.dispose();
        }, 'auto-i18n: dom engine');
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'auto-i18n',
          order: 16,
          label: 'Auto translate',
        }, SettingsRow));
      },
    };
  },
});
