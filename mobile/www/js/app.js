import { notesRepo, createSyncClient } from './sync-core.js';
import { getToken, setToken, clearToken } from './token.js';

const API_BASE = 'https://chat.elsiga.ch/api/sync';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
let client = null;

function setStatus(t) { statusEl.textContent = t; }

async function renderList() {
  const notes = await notesRepo.list();
  const active = notes.filter((n) => !n.archived);
  active.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const list = el('list');
  list.innerHTML = '';
  for (const n of active) {
    const row = document.createElement('div');
    row.className = 'task' + (n.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!n.done;
    cb.addEventListener('change', async () => {
      await notesRepo.update(n.id, { done: cb.checked });
      void client?.syncOnce();
    });
    const label = document.createElement('span');
    label.textContent = n.title || n.text || '(untitled)';
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await notesRepo.remove(n.id);
      void client?.syncOnce();
    });
    row.append(cb, label, del);
    list.appendChild(row);
  }
}

async function addTask() {
  const input = el('new-task');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await notesRepo.create({ title, done: false });
  void client?.syncOnce();
}

function showApp() {
  el('token-panel').classList.add('hidden');
  el('app').classList.remove('hidden');
  el('composer').classList.remove('hidden');
}

function showTokenPanel() {
  el('app').classList.add('hidden');
  el('composer').classList.add('hidden');
  el('token-panel').classList.remove('hidden');
}

async function boot() {
  el('add-btn').addEventListener('click', addTask);
  el('new-task').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
  el('settings-btn').addEventListener('click', showTokenPanel);
  el('token-save').addEventListener('click', async () => {
    const t = el('token-input').value.trim();
    if (!t.startsWith('ody_')) { setStatus('bad token'); return; }
    await setToken(t);
    el('token-input').value = '';
    await start();
  });

  // notesRepo drives the UI; re-render on any local change.
  notesRepo.subscribe(() => { void renderList(); });

  await start();
}

async function start() {
  const token = await getToken();
  await renderList();               // always render local data first (works offline)
  if (!token) { showTokenPanel(); setStatus('no token'); return; }
  showApp();
  client = createSyncClient({
    apiBase: API_BASE,
    authHeader: () => ({ Authorization: `Bearer ${token}` }),
  });
  client.start();
  setStatus('syncing');
}

boot();
