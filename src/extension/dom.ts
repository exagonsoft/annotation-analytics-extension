// This entry point is self-contained because injected content scripts are not ES modules.
(() => {
  const marker = '__annotationAnalyticsDOM';
  const scope = globalThis as typeof globalThis & { __annotationAnalyticsDOM?: () => void };
  scope[marker]?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const seen = new Map<string, string>();
  const sourceId = (row: Element) => row.getAttribute('data-annotation-id') ?? row.getAttribute('data-task-id');
  function collect() {
    if (stopped) return;
    const records: Record<string, unknown>[] = [];
    for (const row of document.querySelectorAll('table tbody tr, [role="row"], [data-annotation-id], [data-task-id]')) {
      const table = row.closest('table,[role="table"],[role="grid"]');
      const headers = table ? [...table.querySelectorAll('thead th,[role="columnheader"]')].map(e => e.textContent?.trim().toLowerCase() ?? '') : [];
      const cells = [...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')];
      const value = (pattern: RegExp) => {
        const index = headers.findIndex(h => pattern.test(h));
        return index >= 0 ? cells[index]?.textContent?.trim().slice(0, 2000) : undefined;
      };
      const id = sourceId(row) ?? value(/^(annotation|task)?\s*id$/);
      if (!id || id.length > 200) continue;
      const title = value(/^(title|task title|name)$/) ?? row.querySelector('[data-title]')?.textContent?.trim().slice(0, 2000);
      const state = value(/^(status|state)$/);
      if (!title && !state && !sourceId(row)) continue;
      const scores: Record<string, number | string> = {};
      for (const dimension of ['overall', 'aesthetics', 'functionality']) {
        const raw = value(new RegExp(`^${dimension}( score| result)?$`));
        if (raw) scores[dimension] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      }
      const record = {
        id, type: 'ANNOTATION', state: state?.toUpperCase().replaceAll(' ', '_'),
        title, projectId: value(/^project( id)?$/), iterationId: value(/^iteration( id)?$/),
        createdAt: value(/^(created|created at)$/), lastModifiedAt: value(/^(modified|last modified)$/),
        inputData: { title }, annotationData: { renderedScores: scores },
      };
      const signature = JSON.stringify(record);
      if (seen.get(id) === signature) continue;
      seen.set(id, signature); records.push(record);
      if (records.length >= 500) break;
    }
    if (records.length) {
      void chrome.runtime.sendMessage({ type: 'DOM_RECORDS', records }).then(result => {
        if (!result?.ok) { console.error('Annotation Analytics: DOM capture not saved.'); stop(); }
        else schedule();
      }).catch(() => { console.error('Annotation Analytics: extension connection lost.'); stop(); });
    }
    if (seen.size > 20_000) seen.clear();
  }
  function schedule() {
    if (timer !== undefined || stopped) return;
    timer = setTimeout(() => { timer = undefined; collect(); }, 700);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-annotation-id', 'data-task-id'] });
  function stop() { stopped = true; observer.disconnect(); clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMessage); delete scope[marker]; }
  function onMessage(message: unknown) {
    if (typeof message === 'object' && message && 'type' in message && message.type === 'STOP_DOM') stop();
  }
  chrome.runtime.onMessage.addListener(onMessage);
  scope[marker] = stop;
  collect();
})();
