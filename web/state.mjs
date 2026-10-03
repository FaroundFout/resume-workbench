/** Content and build metadata have independent lifetimes. Saving never overwrites a newer draft. */
export function createEditorState(initial) {
  let saved = structuredClone(initial); let draft = structuredClone(initial.data); let name = initial.name;
  let build = structuredClone(initial.latestBuild || null); let pdfBuild = build?.status === 'succeeded' ? build : null;
  return {
    applySaved(value) { saved = structuredClone(value); },
    applyBuild(value) { build = structuredClone(value); if (build?.status === 'succeeded') pdfBuild = build; },
    setDraft(value, options = {}) { draft = structuredClone(value); if (options.name !== undefined) name = options.name; },
    read() {
      const dirty = name !== saved.name || JSON.stringify(draft) !== JSON.stringify(saved.data);
      return structuredClone({ saved, draft, name, build, pdfBuild, dirty, previewDirty: !pdfBuild || dirty || pdfBuild.revision !== saved.revision });
    },
  };
}
