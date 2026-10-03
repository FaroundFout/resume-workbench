import { createSaveController } from '../../web/save-controller.mjs';
import { createEmptyData } from '../../web/shared/model.mjs';

export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function createSaveFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = { schemaVersion: 1, id: 'resume-a', name: 'Document', revision: 0, updatedAt: '2026-10-02T00:00:00Z', data: createEmptyData('en') };
  const calls = []; const statuses = [];
  const api = { save(id, payload) { const pending = deferred(); calls.push({ id, payload, pending }); return pending.promise; } };
  const controller = createSaveController({ api, resumeId: initial.id, initial, onStatus: status => statuses.push(status) });
  t.after(() => controller.destroy());
  const resolve = (index, revision) => calls[index].pending.resolve({ ...initial, name: calls[index].payload.name, revision, data: calls[index].payload.data });
  return { initial, controller, calls, statuses, draft(name) { const data = createEmptyData('en'); data.profile.name = name; return data; },
    startFirstSave() { t.mock.timers.tick(800); }, resolveFirstSave(revision) { resolve(0, revision); }, resolveSecondSave(revision) { resolve(1, revision); } };
}
