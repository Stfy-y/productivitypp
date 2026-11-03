import { esc } from '../util.js';
import { icon } from '../icons.js';
import { tasks, sortTasks, quadrant, QUADS } from '../store.js';
import { taskRow } from '../ui.js';

let showDone = false;
export const toggleMatrixDone = () => { showDone = !showDone; };

export function renderMatrix() {
  const all = tasks().filter((t) => showDone || !t.done);
  let html = `<div class="matrix-bar"><span class="hint">Drag tasks between quadrants${matchMedia('(pointer: coarse)').matches ? ' (long-press)' : ''}.</span>
    <label class="switch"><input type="checkbox" data-action="matrix-done" ${showDone ? 'checked' : ''}><span></span> Show completed</label></div>
    <div class="matrix">`;
  for (const n of [1, 2, 3, 4]) {
    const list = sortTasks(all.filter((t) => quadrant(t) === n)).sort((a, b) => a.done - b.done);
    html += `<section class="quad q${n}" data-drop="quad:${n}">
      <header><i class="dot q${n}"></i><div><h3 title="${esc(QUADS[n].name)}"><span class="full">${esc(QUADS[n].name)}</span><span class="short">${QUADS[n].hint}</span></h3><small>${QUADS[n].hint}</small></div>
        <span class="count">${list.filter((t) => !t.done).length}</span>
        <button class="icon-btn small" data-action="quick-add" data-quad="${n}" aria-label="Add to ${QUADS[n].name}">${icon('plus')}</button></header>
      <div class="task-list">${list.map((t) => taskRow(t)).join('') || '<div class="faint pad">Nothing here</div>'}</div>
    </section>`;
  }
  return html + '</div>';
}
