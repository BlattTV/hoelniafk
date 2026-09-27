/* global io */
// Control overlay for the interactive game view. Talks to the suite over a
// token-protected socket.io connection (role=control); the renderer bundle uses
// its own connection (role=render).
(function () {
  const token = location.pathname.split('/')[2];
  // NB: engine.io uses "t" as its own cache-buster parameter – the token travels as "vt".
  const socket = io({ path: '/view-io/', query: { vt: token, role: 'control' } });
  const $ = (id) => document.getElementById(id);
  const chatBox = $('chat');
  const chatWrap = $('chat-input-wrap');
  const chatInput = $('chat-input');
  const inv = $('inventory');
  let selected = 0;
  let locked = false;
  let closed = false;

  const send = (input) => socket.emit('control', input);

  function addChat(text) {
    const d = document.createElement('div');
    d.textContent = text;
    chatBox.appendChild(d);
    while (chatBox.childElementCount > 12) chatBox.removeChild(chatBox.firstChild);
    setTimeout(() => d.remove(), 30000);
  }

  function renderHotbar() {
    const hb = $('hotbar');
    hb.textContent = '';
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('div');
      d.textContent = String(i + 1);
      if (i === selected) d.className = 'sel';
      hb.appendChild(d);
    }
  }
  renderHotbar();

  socket.on('hello', (h) => {
    $('hud-title').textContent = `${h.username || 'Player'} @ ${h.serverName}`;
    (h.chat || []).forEach((l) => addChat(l.text));
    if (h.stats) hud(h.stats);
  });
  function hud(s) {
    const p = s.position ? `${s.position.x} ${s.position.y} ${s.position.z}` : '–';
    $('hud-stats').textContent = `❤ ${s.health ?? '–'}  🍗 ${s.food ?? '–'}  ⌖ ${p}  ping ${s.ping ?? '–'}ms`;
  }
  socket.on('hud', hud);
  socket.on('chat', (l) => addChat(l.text));
  socket.on('closed', (msg) => {
    closed = true;
    if (document.pointerLockElement) document.exitPointerLock();
    $('closed-msg').textContent = msg || '';
    $('closed').hidden = false;
  });
  socket.on('disconnect', () => {
    if (!closed) addChat('[view] connection lost – retrying…');
  });

  // ---------------------------------------------------------------- pointer lock & mouse look
  document.addEventListener('click', (e) => {
    if (closed || e.target.closest('#help, #inventory, #chat-input-wrap')) return;
    if (!locked) document.body.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === document.body;
    if (!locked) send({ kind: 'clearControls' });
  });
  let dx = 0;
  let dy = 0;
  let raf = 0;
  const SENS = 0.0028;
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    dx += e.movementX;
    dy += e.movementY;
    if (!raf) raf = requestAnimationFrame(flushLook);
  });
  function flushLook() {
    raf = 0;
    if (!dx && !dy) return;
    send({ kind: 'lookDelta', dYaw: -dx * SENS, dPitch: -dy * SENS });
    dx = 0;
    dy = 0;
  }
  document.addEventListener('mousedown', (e) => {
    if (!locked) return;
    if (e.button === 0) {
      send({ kind: 'attack' });
      send({ kind: 'dig' });
    } else if (e.button === 2) {
      send({ kind: 'place' });
      send({ kind: 'use' });
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (locked && e.button === 0) send({ kind: 'stopDig' });
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('wheel', (e) => {
    if (!locked) return;
    selected = (selected + (e.deltaY > 0 ? 1 : 8)) % 9;
    send({ kind: 'hotbar', slot: selected });
    renderHotbar();
  });

  // ---------------------------------------------------------------- keyboard
  const KEYMAP = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump', ShiftLeft: 'sneak', ShiftRight: 'sneak', ControlLeft: 'sprint' };
  const down = new Set();
  document.addEventListener('keydown', (e) => {
    if (!chatWrap.hidden) {
      if (e.key === 'Enter') {
        const text = chatInput.value;
        chatInput.value = '';
        chatWrap.hidden = true;
        if (text.trim()) socket.emit('chat', text, (r) => r && !r.ok && addChat(`[error] ${r.error}`));
        document.body.requestPointerLock();
      } else if (e.key === 'Escape') {
        chatWrap.hidden = true;
      }
      return;
    }
    if (!locked) return;
    const c = KEYMAP[e.code];
    if (c) {
      e.preventDefault();
      if (!down.has(e.code)) {
        down.add(e.code);
        send({ kind: 'state', control: c, value: true });
      }
      return;
    }
    if (/^Digit[1-9]$/.test(e.code)) {
      selected = Number(e.code.slice(5)) - 1;
      send({ kind: 'hotbar', slot: selected });
      renderHotbar();
    } else if (e.code === 'KeyT' || e.code === 'Slash') {
      e.preventDefault();
      document.exitPointerLock();
      chatWrap.hidden = false;
      chatInput.value = e.code === 'Slash' ? '/' : '';
      setTimeout(() => chatInput.focus(), 0);
    } else if (e.code === 'KeyE') {
      toggleInventory();
    }
  });
  document.addEventListener('keyup', (e) => {
    const c = KEYMAP[e.code];
    if (c && down.has(e.code)) {
      down.delete(e.code);
      send({ kind: 'state', control: c, value: false });
    }
  });
  window.addEventListener('blur', () => {
    down.clear();
    send({ kind: 'clearControls' });
  });

  function toggleInventory() {
    if (!inv.hidden) {
      inv.hidden = true;
      return;
    }
    socket.emit('inventory', (r) => {
      inv.textContent = '';
      const h = document.createElement('b');
      h.textContent = 'Inventory';
      inv.appendChild(h);
      if (!r || !r.ok) {
        inv.appendChild(document.createTextNode(` – ${r ? r.error : 'unavailable'}`));
      } else if (!r.items.length) {
        inv.appendChild(document.createTextNode(' – empty'));
      } else {
        for (const it of r.items) {
          const d = document.createElement('div');
          d.textContent = `#${it.slot} ${it.displayName} ×${it.count}`;
          inv.appendChild(d);
        }
      }
      inv.hidden = false;
    });
  }

  $('hide-btn').addEventListener('click', () => {
    socket.emit('hide', () => {
      if (window.opener) window.close();
    });
  });
})();
