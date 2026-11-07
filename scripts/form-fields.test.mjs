// B-0132: saving a form must not blank what the form couldn't show. The form code lives
// inline in index.html, so the test lifts it out and runs it against stub controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const lift = (from, to) => { const a = html.indexOf(from); return html.slice(a, html.indexOf(to, a)); };
const source = [
  lift('const formOpened = {}', 'function saveTask()'),
  lift('function saveTask()', 'function deleteTask('),
  lift('function saveDecision()', 'function openDocModal(')
].join('\n');

// A real select shows '' when given a value it has no option for; a real date input does the same.
function select(values) {
  const options = values.map((value) => ({ value }));
  let current = values[0];
  return {
    tagName: 'SELECT', options,
    querySelectorAll: () => options.filter((o) => o.stored),
    add(o) { options.push(o); },
    get value() { return current; },
    set value(v) { current = options.some((o) => o.value === v) ? v : ''; }
  };
}
function date() {
  let current = '';
  return {
    tagName: 'INPUT', type: 'date',
    get value() { return current; },
    set value(v) { current = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
  };
}
const text = () => ({ tagName: 'INPUT', type: 'text', value: '' });

function harness(state) {
  const els = {
    taskTitle: text(), taskFolder: select(['LIFE', 'House']), taskStatus: select(['INBOX', 'NEXT', 'DONE']),
    taskPriority: select(['P0', 'P1', 'P2', 'P3']), taskDueDate: date(), taskEffort: select(['', 'S']),
    taskImpact: select(['', 'L']), taskNextAction: text(), taskNotes: text(), taskProject: select(['', 'P-0001']),
    taskTags: text(),
    decisionTitle: text(), decisionFolder: select(['LIFE']), decisionStatus: select(['', 'DECIDED']),
    decisionDate: date(), decisionProject: select(['']), decisionWhy: text(), decisionAssumptions: text(),
    decisionRisks: text(), decisionWhatWouldChange: text()
  };
  const context = {
    appState: state, document: { getElementById: (id) => els[id] }, alert() {},
    Option: function (label, value) { this.value = value; this.label = label; this.dataset = {}; },
    saveToLocalStorage() {}, render() {}, closeTaskModal() {}, closeDecisionModal() {}, generateId: () => 'NEW'
  };
  vm.runInNewContext(`${source}\nthis.setField = setField; this.saveTask = saveTask; this.saveDecision = saveDecision;`, context);
  // Real <option>s have remove(); the stub takes it off the select's list.
  const open = (id, value) => {
    context.setField(id, value);
    els[id].options?.forEach((o) => { if (o.dataset) o.stored = true; });
  };
  return { els, context, open };
}

function openTask(h, t) {
  h.context.appState.editingTaskId = t.id;
  const fields = { taskTitle: t.title, taskFolder: t.folder || 'LIFE', taskStatus: t.status, taskPriority: t.priority || 'P2',
    taskDueDate: t.dueDate, taskEffort: t.effort, taskImpact: t.impact, taskNextAction: t.nextAction, taskNotes: t.originalText,
    taskProject: t.projectId, taskTags: (t.tags || []).join(', ') };
  for (const [id, v] of Object.entries(fields)) h.open(id, v);
}

const stored = () => ({ id: 'T-00001', title: 'Keep', folder: 'NickOS / Backups', status: 'NEXT', dueDate: '2026-06-30T00:00:00.000Z', projectId: 'P-0099', lastTouchedDate: 'old' });

test('editing only the title leaves an unlisted folder, unlisted project and long date alone', () => {
  const t = stored();
  const h = harness({ tasks: [t] });
  openTask(h, t);
  h.els.taskTitle.value = 'Changed';
  h.context.saveTask();
  assert.equal(t.title, 'Changed');
  assert.equal(t.folder, 'NickOS / Backups');
  assert.equal(t.projectId, 'P-0099');
  assert.equal(t.dueDate, '2026-06-30T00:00:00.000Z');
  assert.notEqual(t.lastTouchedDate, 'old');
});

test('the form shows the stored values instead of going blank', () => {
  const t = stored();
  const h = harness({ tasks: [t] });
  openTask(h, t);
  assert.equal(h.els.taskFolder.value, 'NickOS / Backups');
  assert.equal(h.els.taskProject.value, 'P-0099');
  assert.equal(h.els.taskDueDate.value, '2026-06-30');
});

test('a date the input cannot show survives a save', () => {
  const t = { ...stored(), dueDate: '06/30/2026' };
  const h = harness({ tasks: [t] });
  openTask(h, t);
  assert.equal(h.els.taskDueDate.value, '');
  h.context.saveTask();
  assert.equal(t.dueDate, '06/30/2026');
});

test('saving with no changes writes nothing, not even the touched date', () => {
  const t = stored();
  const before = JSON.stringify(t);
  const h = harness({ tasks: [t] });
  openTask(h, t);
  h.context.saveTask();
  assert.equal(JSON.stringify(t), before);
});

test('a deliberate change still lands: clearing a date, moving a project', () => {
  const t = stored();
  const h = harness({ tasks: [t] });
  openTask(h, t);
  h.els.taskDueDate.value = '';
  h.els.taskProject.value = '';
  h.context.saveTask();
  assert.equal(t.dueDate, '');
  assert.equal(t.projectId, '');
});

test('completing a task still sets completedDate', () => {
  const t = stored();
  const h = harness({ tasks: [t] });
  openTask(h, t);
  h.els.taskStatus.value = 'DONE';
  h.context.saveTask();
  assert.match(t.completedDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('a decision with legacy fields and no date keeps them; a default date is not written', () => {
  const d = { id: 'D-0001', decision: 'Old text', rationale: 'Because', status: null };
  const before = JSON.stringify(d);
  const h = harness({ decisions: [d], editingDecisionId: 'D-0001' });
  h.open('decisionTitle', d.decision);
  h.open('decisionFolder', 'LIFE');
  h.open('decisionStatus', '');
  h.open('decisionDate', '2026-11-06');
  h.open('decisionProject', '');
  h.open('decisionWhy', d.rationale);
  h.open('decisionAssumptions', '');
  h.open('decisionRisks', '');
  h.open('decisionWhatWouldChange', '');
  h.context.saveDecision();
  assert.equal(JSON.stringify(d), before);
});

test('project lists refill when a form opens, keeping None', () => {
  for (const fn of ['openTaskModal', 'openDecisionModal', 'openDocModal', 'openBlockerModal']) {
    const a = html.indexOf(`function ${fn}(`);
    assert.match(html.slice(a, a + 160), /populateProjectSelects\(\);/, fn);
  }
  assert.match(lift('function populateProjectSelects()', '/* ═'), /option:not\(\[value=""\]\)/);
});

test('triage keeps a folder outside the list instead of picking the first entry', () => {
  const a = html.indexOf('<select id="triageFolder">');
  assert.match(html.slice(a, a + 200), /FOLDERS\.includes\(current\.folder\)/);
});

test('triage does not write a folder onto a task that has none', () => {
  assert.match(html, /if \(folder\) current\.folder = folder;/);
});

test('new reviews get an id, and a record with no id survives a reload', () => {
  const a = html.indexOf('function saveReview()');
  assert.match(html.slice(a, a + 300), /id: generateId\('R'\)/);
  assert.match(html, /item && \(!item\.id \|\| !inlineIds\.has\(item\.id\)\)/);
});

test('nothing on the dashboard depends on statuses v2 removed', () => {
  assert.doesNotMatch(html, /taskFilters\.status=\\?'(TODAY|BLOCKED)/);
  assert.doesNotMatch(html, /t\.status === 'BLOCKED'/);
  assert.match(html, /Open blockers/);
});
