// performSearch lives inline in index.html, so the test lifts it out and runs it against stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function performSearch()');
const source = html.slice(start, html.indexOf('function selectSearchResult', start));

function search(query, appState) {
  const els = { searchInput: { value: query }, searchResults: { innerHTML: '' } };
  const context = { appState, document: { getElementById: (id) => els[id] }, escapeHtml: (t) => (t ? String(t) : '') };
  vm.runInNewContext(`${source}; performSearch();`, context);
  return els.searchResults.innerHTML;
}

const state = () => ({
  tasks: [{ id: 'T-00001', title: 'Call the plumber', folder: 'Home' }, { id: 'T-00002' }],
  projects: [{ id: 'P-0001', code: 'home', title: 'House' }],
  decisions: [{ id: 'D-0001', decision: 'Use copper pipe' }, { id: 'D-0002', title: 'Keep the van' }],
  docs: [{ id: 'DOC-0001', title: 'Inspection notes' }]
});

test('a record with no title does not stop the search', () => {
  const out = search('van', state());
  assert.match(out, /Keep the van/);
});

test('finds a record by its id, any case', () => {
  assert.match(search('t-00001', state()), /Call the plumber/);
  assert.match(search('DOC-0001', state()), /Inspection notes/);
  assert.match(search('p-0001', state()), /House/);
});

test('a decision with no title is found and labelled by its text', () => {
  assert.match(search('copper', state()), /Use copper pipe/);
});

test('a miss says no results', () => {
  assert.match(search('zzz', state()), /No results/);
});

test('a result with no folder prints no stray separator', () => {
  const out = search('D-0002', state());
  assert.match(out, /DECISION • D-0002</);
});

test('opening an untitled decision shows its stored text, not a blank form', () => {
  const from = html.indexOf('function openDecisionModal(');
  const modal = html.slice(from, html.indexOf('function closeDecisionModal', from));
  const els = {};
  const el = (id) => (els[id] ??= { value: '', textContent: '', classList: { add() {} } });
  const appState = { decisions: [{ id: 'D-0001', decision: 'Use copper pipe', rationale: 'It lasts', whatWouldChangeIt: 'Price' }] };
  const setField = (id, value) => { el(id).value = value; };
  const populateProjectSelects = () => {};
  vm.runInNewContext(`${modal}; openDecisionModal('D-0001');`, { appState, document: { getElementById: el }, Date, setField, populateProjectSelects });
  assert.equal(els.decisionTitle.value, 'Use copper pipe');
  assert.equal(els.decisionWhy.value, 'It lasts');
  assert.equal(els.decisionWhatWouldChange.value, 'Price');
});

test('finds blockers, reviews, task notes and next actions', () => {
  const s = { ...state(),
    tasks: [{ id: 'T-00003', title: 'A', notes: 'ask the roofer', nextAction: 'call Dale' }],
    blockers: [{ id: 'B-0001', title: 'Waiting on permit' }],
    reviews: [{ id: 'R-0001', title: 'Week 44', summary: 'quiet week' }] };
  assert.match(search('roofer', s), /T-00003/);
  assert.match(search('dale', s), /T-00003/);
  assert.match(search('permit', s), /BLOCKER/);
  assert.match(search('quiet', s), /REVIEW/);
});

test('a state with no blockers or reviews still searches', () => {
  assert.match(search('van', state()), /Keep the van/);
});

test('every result type opens something, and an exact id can read an archived record', () => {
  const from = html.indexOf('function selectSearchResult');
  const open = html.slice(from, html.indexOf('UTILITIES', from));
  for (const t of ['task', 'project', 'decision', 'doc', 'blocker', 'review']) assert.match(open, new RegExp(`type === '${t}'`));
  assert.match(html, /async function lookupById/);
  assert.match(html, /if \(!results\.length && typeof lookupById === 'function'\) lookupById\(query\);/);
});
