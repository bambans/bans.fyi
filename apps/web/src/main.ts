import './style.css';
import { API_BASE, api, ContentFile } from './api';
import { renderMarkdown } from './markdown';

const app = document.querySelector<HTMLDivElement>('#app')!;
let filesCache: ContentFile[] = [];

window.addEventListener('hashchange', renderRoute);
renderRoute().catch(showError);

async function renderRoute() {
  const hash = location.hash || '#/';

  if (hash.startsWith('#/admin')) return renderAdmin();
  if (hash.startsWith('#/search')) return renderSearch();
  if (hash.startsWith('#/graph')) return renderGraph();
  if (hash.startsWith('#/file/')) {
    const path = decodeURIComponent(hash.replace('#/file/', ''));
    return renderReader(path);
  }

  return renderReader();
}

async function loadFiles(): Promise<ContentFile[]> {
  if (filesCache.length) return filesCache;
  const { files } = await api.files();
  filesCache = files;
  return files;
}

async function renderReader(selectedPath?: string) {
  app.innerHTML = `<p class="status">Loading files...</p>`;
  const files = await loadFiles();
  const path = selectedPath || files[0]?.path;

  if (!path) {
    app.innerHTML = `<div class="panel">No Markdown files found in <code>content/</code>.</div>`;
    return;
  }

  const { content } = await api.file(path);
  const html = await renderMarkdown(content);

  app.innerHTML = `
    <section class="layout">
      <aside class="panel">
        <h2>Files</h2>
        <div class="list">
          ${files.map((file) => `<button data-open="${escapeHtml(file.path)}">${escapeHtml(file.title || file.name)}</button>`).join('')}
        </div>
      </aside>
      <article class="panel markdown">
        <small>${escapeHtml(path)}</small>
        <div>${html}</div>
      </article>
    </section>
  `;

  app.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((button) => {
    button.addEventListener('click', () => {
      location.hash = `#/file/${encodeURIComponent(button.dataset.open!)}`;
    });
  });
}

async function renderSearch() {
  const files = await loadFiles();
  app.innerHTML = `
    <section class="panel">
      <h1>Search</h1>
      <input id="query" placeholder="Search title or path..." autofocus />
      <div id="results" class="list" style="margin-top: 1rem"></div>
    </section>
  `;

  const input = app.querySelector<HTMLInputElement>('#query')!;
  const results = app.querySelector<HTMLDivElement>('#results')!;

  const update = () => {
    const q = input.value.toLowerCase().trim();
    const matches = files.filter((file) =>
      !q || file.path.toLowerCase().includes(q) || (file.title || '').toLowerCase().includes(q)
    );
    results.innerHTML = matches.map((file) => `<button data-open="${escapeHtml(file.path)}">${escapeHtml(file.title || file.name)} <small>${escapeHtml(file.path)}</small></button>`).join('');
    results.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((button) => {
      button.addEventListener('click', () => location.hash = `#/file/${encodeURIComponent(button.dataset.open!)}`);
    });
  };

  input.addEventListener('input', update);
  update();
}

async function renderGraph() {
  const graph = await api.graph();
  app.innerHTML = `
    <section class="panel">
      <h1>Graph</h1>
      <p class="muted">Minimal graph from Obsidian-style <code>[[wikilinks]]</code>.</p>
      <h2>Links</h2>
      <div class="list">
        ${graph.edges.length ? graph.edges.map((edge) => `<div class="row-button">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</div>`).join('') : '<p>No links found yet.</p>'}
      </div>
      <h2>Nodes</h2>
      <div class="list">
        ${graph.nodes.map((node) => `<button data-open="${escapeHtml(node.path)}">${escapeHtml(node.title)} <small>${escapeHtml(node.path)}</small></button>`).join('')}
      </div>
    </section>
  `;

  app.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((button) => {
    button.addEventListener('click', () => location.hash = `#/file/${encodeURIComponent(button.dataset.open!)}`);
  });
}

async function renderAdmin() {
  app.innerHTML = `<p class="status">Checking session...</p>`;
  const me = await api.me();

  if (!me.authenticated) {
    app.innerHTML = `
      <section class="panel">
        <h1>Admin</h1>
        <p>Log in with GitHub to edit Markdown files.</p>
        <p><a class="row-button" href="${API_BASE}/api/auth/login">Login with GitHub</a></p>
      </section>
    `;
    return;
  }

  await renderAdminEditor(me.user?.login || 'admin');
}

async function renderAdminEditor(username: string) {
  const files = await loadFiles();
  const firstPath = files[0]?.path || 'content/index.md';

  app.innerHTML = `
    <section class="panel">
      <div class="toolbar">
        <strong>Logged in as ${escapeHtml(username)}</strong>
        <button id="logout">Logout</button>
      </div>
      <div class="toolbar">
        <input id="path" value="${escapeHtml(firstPath)}" placeholder="content/notes/new-note.md" />
        <button id="new">New</button>
        <button id="load">Load</button>
        <button id="save" class="primary">Save</button>
        <button id="delete" class="danger">Delete</button>
      </div>
      <p id="status" class="status"></p>
      <div class="editor-grid">
        <textarea id="editor" spellcheck="false"></textarea>
        <article class="panel markdown" id="preview"></article>
      </div>
    </section>
  `;

  const pathInput = app.querySelector<HTMLInputElement>('#path')!;
  const editor = app.querySelector<HTMLTextAreaElement>('#editor')!;
  const preview = app.querySelector<HTMLElement>('#preview')!;
  const status = app.querySelector<HTMLElement>('#status')!;

  const setStatus = (message: string) => status.textContent = message;
  const updatePreview = async () => preview.innerHTML = await renderMarkdown(editor.value);
  const load = async () => {
    setStatus('Loading...');
    const result = await api.file(pathInput.value.trim());
    editor.value = result.content;
    await updatePreview();
    setStatus('Loaded.');
  };

  app.querySelector<HTMLButtonElement>('#logout')!.addEventListener('click', async () => {
    await api.logout();
    filesCache = [];
    location.hash = '#/admin';
    renderRoute().catch(showError);
  });

  app.querySelector<HTMLButtonElement>('#new')!.addEventListener('click', async () => {
    pathInput.value = 'content/notes/new-note.md';
    editor.value = `---\ntitle: New note\nstatus: published\ntags: []\n---\n\n# New note\n`;
    await updatePreview();
    setStatus('New file prepared. Change the path before saving if needed.');
  });

  app.querySelector<HTMLButtonElement>('#load')!.addEventListener('click', () => load().catch(showError));
  app.querySelector<HTMLButtonElement>('#save')!.addEventListener('click', async () => {
    setStatus('Saving to GitHub...');
    const path = pathInput.value.trim();
    const exists = filesCache.some((file) => file.path === path);
    if (exists) await api.updateFile(path, editor.value);
    else await api.createFile(path, editor.value);
    filesCache = [];
    setStatus('Saved as a GitHub commit.');
  });

  app.querySelector<HTMLButtonElement>('#delete')!.addEventListener('click', async () => {
    const path = pathInput.value.trim();
    if (!confirm(`Delete ${path}?`)) return;
    setStatus('Deleting from GitHub...');
    await api.deleteFile(path);
    filesCache = [];
    editor.value = '';
    await updatePreview();
    setStatus('Deleted as a GitHub commit.');
  });

  editor.addEventListener('input', () => updatePreview().catch(showError));
  await load().catch(async () => {
    editor.value = `---\ntitle: Home\nstatus: published\ntags: []\n---\n\n# Home\n`;
    await updatePreview();
  });
}

function showError(error: unknown) {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  app.innerHTML = `<section class="panel"><h1>Error</h1><pre>${escapeHtml(message)}</pre></section>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}
