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
      await renderList();               // repaint from committed data (await = committed)
      void client?.syncOnce();
    });
    const label = document.createElement('span');
    label.textContent = n.title || n.text || '(untitled)';
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await notesRepo.remove(n.id);
      await renderList();               // repaint from committed data
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
  await renderList();                   // repaint immediately (await = committed to Dexie)
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
  // ⚙ is only reachable once a token is saved, so offer a way back to the list.
  el('settings-btn').addEventListener('click', () => {
    el('token-back').classList.remove('hidden');
    showTokenPanel();
  });
  el('token-back').addEventListener('click', () => {
    el('token-input').value = '';
    showApp();
    void renderList();
  });
  el('token-save').addEventListener('click', async () => {
    const t = el('token-input').value.trim();
    if (!t.startsWith('ody_')) { setStatus('bad token'); return; }
    await setToken(t);
    el('token-input').value = '';
    await start();
  });

  await start();
}

async function start() {
  const token = await getToken();
  await renderList();               // always render local data first (works offline)
  // First run (no token yet): nowhere to go back to, so keep Back hidden.
  if (!token) { el('token-back').classList.add('hidden'); showTokenPanel(); setStatus('no token'); return; }
  showApp();
  client = createSyncClient({
    apiBase: API_BASE,
    authHeader: () => ({ Authorization: `Bearer ${token}` }),
  });
  client.start();
  setStatus('syncing');
  // start() kicks an internal sync; await one more so the initial pull's rows
  // (and any remote changes) are painted, then reflect that sync settled.
  await client.syncOnce();
  await renderList();
  setStatus(navigator.onLine ? 'synced' : 'offline');
}

boot();
