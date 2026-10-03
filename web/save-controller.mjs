/** Serial optimistic saves. Optional edit(data, {name}) saves the title atomically. */
export function createSaveController({ api, resumeId, initial, onStatus = () => {}, debounceMs = 800 }) {
  let saved = structuredClone(initial); let draft = structuredClone(initial.data); let name = initial.name;
  let version = 0; let savedVersion = 0; let timer = null; let pending = null; let disposed = false; let conflict = null;
  const closed = () => ({ code: 'CONTROLLER_CLOSED', message: '编辑器已关闭', status: 0 });
  const status = (state, error) => { if (!disposed) onStatus({ state, revision: saved.revision, ...(error ? { error } : {}) }); };
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function start() {
    if (pending) return pending;
    if (disposed) return Promise.reject(closed());
    if (conflict) return Promise.reject(conflict);
    if (version === savedVersion) return Promise.resolve(structuredClone(saved));
    const sentVersion = version; const payload = { expectedRevision: saved.revision, name, data: structuredClone(draft) };
    status('saving');
    // Publish pending before processing any completion; every write uses the previous response revision.
    pending = (async () => {
      try {
        const result = await api.save(resumeId, payload);
        if (disposed) throw closed();
        saved = structuredClone(result); savedVersion = sentVersion;
        status(version === savedVersion ? 'saved' : 'dirty'); return structuredClone(saved);
      } catch (error) {
        if (error.status === 409) conflict = error;
        status(conflict ? 'conflict' : 'error', error); throw error;
      } finally { pending = null; }
    })();
    return pending;
  }
  async function automatic() {
    try { await start(); if (!disposed && !conflict && timer === null && version !== savedVersion) await automatic(); }
    catch { /* Status reports failures. Explicit save retries errors; conflicts require reload/copy. */ }
  }
  return {
    edit(data, options = {}) {
      if (disposed) return;
      draft = structuredClone(data); if (options.name !== undefined) name = options.name; version++;
      status(conflict ? 'conflict' : 'dirty', conflict); clear();
      if (!conflict) timer = setTimeout(() => { timer = null; automatic(); }, debounceMs);
    },
    async flush() {
      clear(); if (disposed) throw closed(); if (conflict) throw conflict;
      do { await start(); if (disposed) throw closed(); if (conflict) throw conflict; } while (savedVersion !== version);
      return structuredClone(saved);
    },
    readDraft() { return structuredClone(draft); },
    destroy() { disposed = true; clear(); },
  };
}
