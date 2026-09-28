/**
 * Macro builder – Scratch-style blocks for Minecraft sessions.
 * Palette (drag) → script (drop between blocks or into C-blocks). Blocks carry their inputs inline.
 * Macros run next to the session (also on agents) and pause while you play in the real game.
 */
import { api } from '../api.js';
import { guard, h, mount, relTime, toast } from '../ui.js';
import { t } from '../i18n.js';

const CATS = {
  control: { name: 'Control', color: '#e8a33c' },
  motion: { name: 'Motion', color: '#4c86d8' },
  actions: { name: 'Actions', color: '#4fa35a' },
  chat: { name: 'Chat', color: '#8a63cf' },
  suite: { name: 'Suite', color: '#4aa0b8' },
};

const num = (k, d, step = 'any') => ({ k, t: 'num', d, step });
const txt = (k, d) => ({ k, t: 'text', d });

/** Block catalogue: label parts are text or inputs; c = nested stacks (C-blocks). */
export const BLOCKS = {
  wait: { cat: 'control', parts: ['wait', num('seconds', 1), 'seconds'] },
  waitChat: { cat: 'control', parts: ['wait until chat contains', txt('text', 'Welcome'), 'max.', num('timeoutSec', 60, 1), 's'] },
  repeat: { cat: 'control', parts: ['repeat', num('times', 10, 1), 'times'], c: ['body'] },
  forever: { cat: 'control', parts: ['forever'], c: ['body'] },
  if: { cat: 'control', parts: ['if'], cond: true, c: ['then', 'else'] },
  stop: { cat: 'control', parts: ['stop macro'] },
  move: { cat: 'motion', parts: ['walk', { k: 'dir', t: 'select', d: 'forward', o: [['forward', 'forward'], ['back', 'back'], ['left', 'left'], ['right', 'right']] }, 'for', num('seconds', 1), 's', { k: 'sprint', t: 'check', d: false, label: 'sprint' }] },
  jump: { cat: 'motion', parts: ['jump', num('times', 1, 1), 'times'] },
  sneak: { cat: 'motion', parts: ['sneak for', num('seconds', 1), 's'] },
  turn: { cat: 'motion', parts: ['turn by', num('degrees', 90), '°'] },
  look: { cat: 'motion', parts: ['look at yaw', num('yaw', 0), 'pitch', num('pitch', 0)] },
  swing: { cat: 'actions', parts: ['swing hand'] },
  use: { cat: 'actions', parts: ['use item (right click) for', num('seconds', 0.2), 's'] },
  attack: { cat: 'actions', parts: ['attack nearby mob', num('times', 1, 1), 'times'] },
  slot: { cat: 'actions', parts: ['select hotbar slot', num('slot', 1, 1)] },
  say: { cat: 'chat', parts: ['say', txt('text', 'Hello!')] },
  command: { cat: 'chat', parts: ['command /', txt('text', 'spawn')] },
  log: { cat: 'suite', parts: ['note in the suite log', txt('text', 'step done')] },
};

const CONDITIONS = [
  ['chatContains', 'chat contains', txt('text', 'text')],
  ['healthBelow', 'health below', num('value', 10, 1)],
  ['foodBelow', 'food below', num('value', 10, 1)],
  ['hasItem', 'inventory has', txt('name', 'bread')],
  ['random', 'random chance %', num('percent', 50, 1)],
];

const TRIGGERS = [
  ['manual', 'when started manually'],
  ['spawn', 'when the session is online'],
  ['chat', 'when chat contains', txt('contains', 'Link your account')],
  ['interval', 'every … seconds', num('seconds', 300, 1)],
  ['time', 'every day at', { k: 'at', t: 'time', d: '18:00' }],
  ['health', 'when health below', num('below', 6, 1)],
];

function newBlock(type) {
  const def = BLOCKS[type];
  const b = { type };
  for (const p of def.parts) if (typeof p === 'object') b[p.k] = p.d;
  if (def.cond) b.cond = { type: 'chatContains', text: 'text' };
  for (const c of def.c ?? []) b[c] = [];
  return b;
}

function input(obj, p, onChange) {
  const set = (v) => {
    obj[p.k] = v;
    onChange();
  };
  if (p.t === 'num') return h('input', { class: 'blk-in num', type: 'number', step: p.step ?? 'any', value: obj[p.k], onchange: (e) => set(Number(e.target.value)), onmousedown: (e) => e.stopPropagation() });
  if (p.t === 'text') return h('input', { class: 'blk-in', value: obj[p.k], size: Math.max(4, String(obj[p.k] ?? '').length), oninput: (e) => { e.target.size = Math.max(4, e.target.value.length); obj[p.k] = e.target.value; }, onchange: onChange, onmousedown: (e) => e.stopPropagation() });
  if (p.t === 'time') return h('input', { class: 'blk-in', type: 'time', value: obj[p.k], onchange: (e) => set(e.target.value), onmousedown: (e) => e.stopPropagation() });
  if (p.t === 'check') return h('label', { class: 'blk-check' }, h('input', { type: 'checkbox', checked: !!obj[p.k], onchange: (e) => set(e.target.checked) }), p.label);
  return h('select', { class: 'blk-in', onchange: (e) => set(e.target.value), onmousedown: (e) => e.stopPropagation() }, p.o.map(([v, l]) => h('option', { value: v, selected: obj[p.k] === v }, l)));
}

export async function macrosView(root) {
  let data = await api.get('/api/macros');
  let sessions = await api.get('/api/sessions');
  const [identities, servers] = await Promise.all([api.get('/api/dashboard'), api.get('/api/servers')]);
  let current = data.macros[0] ? structuredClone(data.macros[0]) : null;
  let dirty = false;
  let drag = null; // { from: 'palette', block } | { from: 'script', list, index }

  const markDirty = () => {
    dirty = true;
    renderHead();
  };

  const headEl = h('div');
  const listEl = h('div', { class: 'macro-list' });
  const scriptEl = h('div', { class: 'macro-script' });
  const settingsEl = h('div');
  const logEl = h('div', { class: 'macro-log' });

  // ---------------------------------------------------------------- script rendering
  const dropSlot = (list, index) => {
    const slot = h('div', { class: 'drop-slot' });
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      slot.classList.add('over');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      slot.classList.remove('over');
      if (!drag) return;
      let block;
      let at = index;
      if (drag.from === 'palette') block = newBlock(drag.type);
      else {
        if (drag.list === list && drag.index < index) at--;
        if (containsList(drag.list[drag.index], list)) return toast('A block cannot be moved into itself', 'error');
        [block] = drag.list.splice(drag.index, 1);
      }
      list.splice(at, 0, block);
      drag = null;
      markDirty();
      renderScript();
    });
    return slot;
  };

  const containsList = (block, list) => {
    for (const k of ['body', 'then', 'else']) if (Array.isArray(block?.[k]) && (block[k] === list || block[k].some((b) => containsList(b, list)))) return true;
    return false;
  };

  const renderBlock = (b, list, index) => {
    const def = BLOCKS[b.type];
    const color = CATS[def.cat].color;
    const row = h('div', { class: 'blk-row' },
      def.parts.map((p) => (typeof p === 'string' ? h('span', { class: 'blk-word' }, p) : input(b, p, markDirty))),
      def.cond ? condEditor(b) : null,
      h('button', { class: 'blk-del', title: 'Remove block', onclick: () => { list.splice(index, 1); markDirty(); renderScript(); } }, '×'));
    const el = h('div', { class: `blk${def.c ? ' c' : ''}`, style: `--blk:${color}`, draggable: 'true' }, row);
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      drag = { from: 'script', list, index };
      e.dataTransfer.setData('text/plain', b.type);
    });
    for (const [i, c] of (def.c ?? []).entries()) {
      if (i > 0) el.appendChild(h('div', { class: 'blk-row blk-else' }, h('span', { class: 'blk-word' }, 'else')));
      el.appendChild(h('div', { class: 'blk-inner' }, stack(b[c])));
    }
    if (def.c) el.appendChild(h('div', { class: 'blk-foot' }));
    return el;
  };

  const condEditor = (b) => {
    const c = b.cond;
    const def = CONDITIONS.find((x) => x[0] === c.type) ?? CONDITIONS[0];
    const sel = h('select', { class: 'blk-in', onmousedown: (e) => e.stopPropagation(), onchange: (e) => {
      const d = CONDITIONS.find((x) => x[0] === e.target.value);
      b.cond = { type: d[0], [d[2].k]: d[2].d };
      markDirty();
      renderScript();
    } }, CONDITIONS.map(([v, l]) => h('option', { value: v, selected: v === c.type }, l)));
    return h('span', { class: 'blk-cond' }, sel, input(c, def[2], markDirty), h('span', { class: 'blk-word' }, 'then'));
  };

  const stack = (list) => {
    const out = h('div', { class: 'blk-stack' });
    out.appendChild(dropSlot(list, 0));
    list.forEach((b, i) => {
      out.appendChild(renderBlock(b, list, i));
      out.appendChild(dropSlot(list, i + 1));
    });
    if (!list.length) out.appendChild(h('div', { class: 'blk-empty' }, 'drag blocks here'));
    return out;
  };

  const renderScript = () => {
    if (!current) return mount(scriptEl, h('div', { class: 'empty' }, 'Create a macro on the left.'));
    const trig = current.trigger;
    const def = TRIGGERS.find((x) => x[0] === trig.type) ?? TRIGGERS[0];
    const hat = h('div', { class: 'blk hat', style: '--blk:#d4a017' },
      h('div', { class: 'blk-row' },
        h('select', { class: 'blk-in', onchange: (e) => {
          const d = TRIGGERS.find((x) => x[0] === e.target.value);
          current.trigger = d[2] ? { type: d[0], [d[2].k]: d[2].d } : { type: d[0] };
          markDirty();
          renderScript();
        } }, TRIGGERS.map(([v, l]) => h('option', { value: v, selected: v === trig.type }, l))),
        def[2] ? input(trig, def[2], markDirty) : null,
        trig.type === 'chat' ? h('label', { class: 'blk-check' }, h('input', { type: 'checkbox', checked: !!trig.regex, onchange: (e) => { trig.regex = e.target.checked; markDirty(); } }), 'regex') : null));
    mount(scriptEl, hat, stack(current.blocks));
  };

  // ---------------------------------------------------------------- palette
  const palette = h('div', { class: 'macro-palette' },
    Object.entries(CATS).map(([cat, c]) => h('div', { class: 'pal-group' },
      h('div', { class: 'pal-title', style: { color: c.color } }, c.name),
      Object.entries(BLOCKS).filter(([, d]) => d.cat === cat).map(([type, d]) => {
        const el = h('div', { class: `blk pal${d.c ? ' c' : ''}`, style: `--blk:${c.color}`, draggable: 'true', title: 'Drag into the script – or click to append' },
          h('div', { class: 'blk-row' }, d.parts.map((p) => (typeof p === 'string' ? h('span', { class: 'blk-word' }, p) : h('span', { class: 'blk-ph' }, p.t === 'check' ? p.label : String(p.d))))));
        el.addEventListener('dragstart', (e) => {
          drag = { from: 'palette', type };
          e.dataTransfer.setData('text/plain', type);
        });
        el.addEventListener('click', () => {
          if (!current) return;
          current.blocks.push(newBlock(type));
          markDirty();
          renderScript();
        });
        return el;
      }))));
  // dropping a script block back onto the palette deletes it
  palette.addEventListener('dragover', (e) => drag?.from === 'script' && e.preventDefault());
  palette.addEventListener('drop', (e) => {
    e.preventDefault();
    if (drag?.from === 'script') {
      drag.list.splice(drag.index, 1);
      drag = null;
      markDirty();
      renderScript();
    }
  });

  // ---------------------------------------------------------------- list, settings, run, log
  const selectMacro = (m) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    current = m ? structuredClone(m) : null;
    dirty = false;
    renderAll();
  };

  const renderList = () => mount(listEl,
    h('button', { class: 'primary', style: { width: '100%' }, onclick: () => selectMacro({ id: null, name: 'New macro', enabled: true, humanize: true, trigger: { type: 'manual' }, blocks: [newBlock('wait')], identityIds: null, serverIds: null }) }, '+ New macro'),
    data.macros.map((m) => h('button', { class: `macro-item ${current?.id === m.id ? 'active' : ''}`, onclick: () => selectMacro(m) },
      h('span', { class: `mark ${m.enabled ? 'ok' : ''}` }), m.name)));

  const multi = (label, options, selected, set) =>
    h('details', { class: 'scope' },
      h('summary', null, `${t(label)}: ${selected?.length ? selected.length : t('all')}`),
      options.map(([id, name]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!selected?.includes(id), onchange: (e) => {
        const cur = new Set(selected ?? []);
        if (e.target.checked) cur.add(id);
        else cur.delete(id);
        set(cur.size ? [...cur] : null);
        markDirty();
        renderSettings();
      } }), name)));

  const renderSettings = () => {
    if (!current) return mount(settingsEl);
    const online = sessions.filter((s) => s.state === 'ONLINE');
    const sessSel = h('select', null, online.map((s) => h('option', { value: s.id }, `${s.username ?? s.id} @ ${s.serverName}`)));
    mount(settingsEl,
      h('div', { class: 'macro-settings' },
        h('input', { class: 'macro-name', value: current.name, oninput: (e) => { current.name = e.target.value; dirty = true; }, onchange: markDirty }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: current.enabled, onchange: (e) => { current.enabled = e.target.checked; markDirty(); } }), 'active'),
        h('label', { class: 'check', title: 'Waits and actions vary slightly and get small pauses – like a person' }, h('input', { type: 'checkbox', checked: current.humanize, onchange: (e) => { current.humanize = e.target.checked; markDirty(); } }), 'human timing'),
        multi('Identities', identities.rows.map((r) => [r.id, r.label]), current.identityIds, (v) => (current.identityIds = v)),
        multi('Servers', servers.map((s) => [s.id, s.name]), current.serverIds, (v) => (current.serverIds = v))),
      h('div', { class: 'toolbar' },
        h('button', { class: 'primary', onclick: () => guard(async () => {
          const body = { name: current.name, enabled: current.enabled, humanize: current.humanize, trigger: current.trigger, blocks: current.blocks, identityIds: current.identityIds, serverIds: current.serverIds };
          const saved = current.id ? await api.put(`/api/macros/${current.id}`, body) : await api.post('/api/macros', body);
          data = await api.get('/api/macros');
          current = structuredClone(saved);
          dirty = false;
          renderAll();
        }, 'Macro saved – running sessions use it right away') }, 'Save'),
        current.id ? h('button', { class: 'danger', onclick: () => confirm(`Delete macro "${current.name}"?`) && guard(async () => { await api.del(`/api/macros/${current.id}`); data = await api.get('/api/macros'); current = data.macros[0] ? structuredClone(data.macros[0]) : null; dirty = false; renderAll(); }, 'Macro deleted') }, 'Delete') : null,
        h('span', { class: 'muted' }, 'Test on:'),
        online.length ? sessSel : h('span', { class: 'muted' }, 'no session online'),
        h('button', { disabled: !online.length || !current.id || dirty, title: dirty ? 'Save first' : 'Runs the saved macro on this session now', onclick: () => guard(() => api.post(`/api/macros/${current.id}/run`, { sessionId: sessSel.value }), 'Macro started') }, 'Run'),
        h('button', { disabled: !online.length || !current.id, onclick: () => guard(() => api.post(`/api/macros/${current.id}/stop`, { sessionId: sessSel.value }), 'Stopped') }, 'Stop')));
  };

  const renderLog = () => {
    const names = new Map(data.macros.map((m) => [m.id, m.name]));
    mount(logEl, h('h3', null, 'Recent runs'),
      data.log.length
        ? h('table', null, h('tbody', null, data.log.slice(0, 40).map((l) => h('tr', null,
            h('td', { class: 'muted mono' }, relTime(l.ts)), h('td', null, names.get(l.macroId) ?? `#${l.macroId}`), h('td', { class: 'mono' }, l.sessionId),
            h('td', null, h('span', { class: `badge ${l.status === 'error' ? 'error' : l.status === 'finished' ? 'ok' : 'unknown'}` }, l.status)), h('td', { class: 'muted' }, l.message ?? '')))))
        : h('p', { class: 'muted' }, 'No runs yet.'));
  };

  const renderHead = () => mount(headEl, h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Macro builder'), h('div', { class: 'muted' }, 'Blocks like in Scratch – for your Minecraft sessions. Macros pause while you play in the real game.')),
    dirty ? h('span', { class: 'badge warn' }, 'unsaved changes') : null));

  const renderAll = () => {
    renderHead();
    renderList();
    renderSettings();
    renderScript();
    renderLog();
  };

  mount(root, headEl, h('div', { class: 'macro-layout' }, listEl, palette, h('div', { class: 'macro-main' }, settingsEl, scriptEl)), logEl);
  renderAll();

  let tm;
  return {
    onEvent: (ev) => {
      if (ev.type === 'macro') {
        clearTimeout(tm);
        tm = setTimeout(async () => {
          data = { ...data, log: (await api.get('/api/macros')).log };
          renderLog();
        }, 300);
      }
      if (ev.type === 'session.state' && !dirty) {
        clearTimeout(tm);
        tm = setTimeout(async () => {
          sessions = await api.get('/api/sessions');
          renderSettings();
        }, 800);
      }
    },
  };
}
