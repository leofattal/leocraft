/* LeoCraft online layer: cloud saves + multiplayer.
   Loaded AFTER the game script — reads game globals (player, dimId, scene,
   THREE, collectSave, editBlock, SEED) and installs the window.mp / window.cloud
   hooks the game calls. If no cloud world is active, does nothing (pure local mode). */
(function () {
  const ACTIVE_KEY = 'leocraft_active';
  const PROFILE_KEY = 'leocraft_profile';
  const TABLE = 'leocraft_worlds';

  let active = null, profile = null;
  try { active = JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch (e) {}
  try { profile = JSON.parse(localStorage.getItem(PROFILE_KEY)); } catch (e) {}
  if (!active || !active.worldId || !window.supabase || !window.LEO_SUPABASE_URL) return;

  const sb = window.supabase.createClient(window.LEO_SUPABASE_URL, window.LEO_SUPABASE_KEY);
  // per-TAB identity: lets two tabs (or players) on the same computer see each other
  const myId = ((profile && profile.playerId) || 'anon').slice(0, 8) + '-' + Math.random().toString(36).slice(2, 10);
  const myName = (profile && profile.playerName) || 'Player';

  // ---------- overlay tweaks: cloud worlds are managed from the home screen ----------
  const sub = document.querySelector('#overlay .sub');
  if (sub) sub.textContent = '🌍 ' + active.name.toUpperCase() +
    (active.multiplayer ? ' · 🌐 ONLINE — CODE: ' + active.code : ' · CODE: ' + active.code);
  const nwBtn = document.getElementById('newWorldBtn');
  const imBtn = document.getElementById('importBtn');
  if (nwBtn) nwBtn.style.display = 'none';   // would clobber the cloud world
  if (imBtn) imBtn.style.display = 'none';

  // ---------- status badge ----------
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:10px;top:10px;z-index:15;color:#fff;' +
    'font:12px "Courier New",monospace;text-shadow:1px 1px 0 #000;text-align:right;' +
    'pointer-events:none;white-space:pre;';
  document.body.appendChild(badge);
  let cloudState = '☁ cloud save ready';
  function updateBadge() {
    let txt = cloudState;
    if (channel) {
      const others = remotes.size;
      txt += '\n👥 ' + (others + 1) + ' player' + (others ? 's' : '') + ' · code ' + active.code;
    }
    badge.textContent = txt;
  }

  // ---------- cloud save ----------
  let lastUpload = 0, uploading = false, pendingSave = false;
  async function upload() {
    if (uploading) { pendingSave = true; return; }
    uploading = true;
    cloudState = '☁ saving…'; updateBadge();
    try {
      const snapshot = collectSave();
      const { error } = await sb.from(TABLE)
        .update({ data: snapshot, seed: snapshot.seed, updated_at: new Date().toISOString() })
        .eq('id', active.worldId);
      cloudState = error ? '⚠ cloud save failed' : '☁ saved to cloud';
    } catch (e) {
      cloudState = '⚠ cloud save failed';
    }
    uploading = false; lastUpload = Date.now(); updateBadge();
  }
  // called by the game's saveNow() (autosave every 15 s, plus manual saves)
  window.cloudSaveNow = function () {
    if (Date.now() - lastUpload < 10000) { pendingSave = true; return; }
    upload();
  };
  // best-effort final save when the tab closes
  window.addEventListener('pagehide', () => {
    try {
      const body = JSON.stringify({ data: collectSave(), updated_at: new Date().toISOString() });
      fetch(window.LEO_SUPABASE_URL + '/rest/v1/' + TABLE + '?id=eq.' + active.worldId, {
        method: 'PATCH', keepalive: true,
        headers: {
          apikey: window.LEO_SUPABASE_KEY,
          Authorization: 'Bearer ' + window.LEO_SUPABASE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body,
      });
    } catch (e) {}
  });

  // ---------- multiplayer ----------
  let channel = null, joined = false, applyingRemote = false;
  const remotes = new Map();   // playerId -> {group, target, yaw, dim, last, name}

  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.55);
  }
  function nameSprite(name) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 34px "Courier New", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const w = Math.min(250, ctx.measureText(name).width + 24);
    ctx.fillRect(128 - w / 2, 8, w, 48);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    spr.scale.set(2.2, 0.55, 1);
    spr.position.y = 2.35;
    return spr;
  }
  function buildAvatar(name, col) {
    const g = new THREE.Group();
    const dark = col.clone().multiplyScalar(0.6);
    const skin = new THREE.Color(0xd9a066);
    const box = (w, h, d, c, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({ color: c }));
      m.position.set(x, y, z);
      g.add(m); return m;
    };
    box(0.26, 0.75, 0.26, dark, -0.14, 0.375, 0);   // legs
    box(0.26, 0.75, 0.26, dark, 0.14, 0.375, 0);
    box(0.56, 0.72, 0.32, col, 0, 1.11, 0);          // body
    box(0.22, 0.65, 0.24, col, -0.4, 1.12, 0);       // arms
    box(0.22, 0.65, 0.24, col, 0.4, 1.12, 0);
    box(0.5, 0.5, 0.5, skin, 0, 1.72, 0);            // head
    box(0.09, 0.09, 0.05, new THREE.Color(0x222222), -0.12, 1.78, -0.26); // eyes
    box(0.09, 0.09, 0.05, new THREE.Color(0x222222), 0.12, 1.78, -0.26);
    g.add(nameSprite(name));
    return g;
  }

  function onPos(p) {
    if (!p || p.id === myId) return;
    let r = remotes.get(p.id);
    if (!r) {
      const group = buildAvatar(p.name || 'Player', colorFor(p.id));
      group.position.set(p.p[0], p.p[1], p.p[2]);
      scene.add(group);
      r = { group, target: new THREE.Vector3(), yaw: 0, dim: p.dim, last: 0, name: p.name };
      remotes.set(p.id, r);
      updateBadge();
    }
    r.target.set(p.p[0], p.p[1], p.p[2]);
    r.yaw = p.yaw || 0;
    r.dim = p.dim;
    r.last = performance.now();
    // the player with the smallest id is the clock authority — follow their time
    if (typeof p.t === 'number' && p.id < myId) {
      const diff = Math.abs(dayTime - p.t);
      if (Math.min(diff, 1 - diff) > 0.015) dayTime = p.t;
    }
  }
  function dropRemote(id) {
    const r = remotes.get(id);
    if (r) { scene.remove(r.group); remotes.delete(id); updateBadge(); }
  }
  function onEdit(p) {
    if (!p || p.from === myId) return;
    if (p.dim !== dimId) return;               // edit happened in the other dimension
    applyingRemote = true;
    try { editBlock(p.x, p.y, p.z, p.id); } catch (e) {}
    applyingRemote = false;
  }

  if (active.multiplayer && active.code) {
    channel = sb.channel('leocraft-' + active.code, {
      config: { broadcast: { self: false }, presence: { key: myId } },
    });
    channel.on('broadcast', { event: 'pos' }, msg => onPos(msg.payload));
    channel.on('broadcast', { event: 'edit' }, msg => onEdit(msg.payload));
    channel.on('broadcast', { event: 'edits' }, msg => {
      const p = msg.payload;
      if (!p || p.from === myId || p.dim !== dimId) return;
      if (window.schemEnqueueRemote) window.schemEnqueueRemote(p.list || []);
      if (p.chests && window.schemChestsRemote) window.schemChestsRemote(p.chests);
    });
    channel.on('broadcast', { event: 'hit' }, msg => {
      const p = msg.payload;
      if (!p || p.to !== myId || dead) return;
      try {
        damagePlayer(Math.max(1, Math.min(7, p.dmg || 1)), p.kx || 0, p.kz || 0);
        tone(220, 120, 0.15, 'square', 0.15);
      } catch (e) {}
    });
    channel.on('broadcast', { event: 'time' }, msg => {
      if (msg.payload && typeof msg.payload.t === 'number') dayTime = msg.payload.t;
    });
    channel.on('presence', { event: 'leave' }, msg => {
      for (const p of (msg.leftPresences || [])) dropRemote(p.key || (p[0] && p[0].key));
      // presence payload shape varies; also sweep by state
      const state = channel.presenceState();
      for (const id of [...remotes.keys()]) if (!state[id]) dropRemote(id);
    });
    channel.subscribe(status => {
      joined = status === 'SUBSCRIBED';
      if (joined) channel.track({ name: myName });
      updateBadge();
    });
  }

  // called by the game when someone sleeps: sync the skip-to-day for everyone
  window.mpTime = function (t) {
    if (!channel || !joined) return;
    channel.send({ type: 'broadcast', event: 'time', payload: { t, from: myId } });
  };

  // called by the game at the end of editBlock()
  window.mpEdit = function (x, y, z, id) {
    if (applyingRemote || window._schemQuiet || !channel || !joined) return;
    channel.send({ type: 'broadcast', event: 'edit',
      payload: { x, y, z, id, dim: dimId, from: myId } });
  };

  // schematic pastes sync as batches (spread out to stay under rate limits)
  window.mpEditBatch = function (list, dim, chests) {
    if (!channel || !joined) return;
    let delay = 0;
    for (let i = 0; i < list.length; i += 300) {
      const slice = list.slice(i, i + 300);
      const extra = i === 0 && chests ? chests : undefined;
      setTimeout(() => {
        if (joined) channel.send({ type: 'broadcast', event: 'edits',
          payload: { list: slice, dim, from: myId, chests: extra } });
      }, delay);
      delay += 120;
    }
  };

  // ---------- PVP: your hits reach other players ----------
  let punchCd = 0;
  function aimAtRemote(maxDist) {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
    let best = null, bestScore = 1.3;
    for (const [id, r] of remotes) {
      if (!r.group.visible) continue;
      const center = r.group.position.clone(); center.y += 0.9;
      const to = center.clone().sub(camera.position);
      if (to.length() > maxDist) continue;
      const t = to.dot(dir);
      if (t < 0.2) continue;
      const perp = camera.position.clone().addScaledVector(dir, t).distanceTo(center);
      if (perp < bestScore) { best = { id, r }; bestScore = perp; }
    }
    return best;
  }
  function flashAvatar(r) {
    for (const c of r.group.children) {
      if (c.isSprite || !c.material || !c.material.color) continue;
      if (!c.userData.orig) c.userData.orig = c.material.color.clone();
      c.material.color.set(0xff4444);
    }
    setTimeout(() => {
      for (const c of r.group.children)
        if (!c.isSprite && c.material && c.userData.orig) c.material.color.copy(c.userData.orig);
    }, 170);
  }
  function sendHit(id, r, dmg) {
    const kx = r.group.position.x - player.pos.x, kz = r.group.position.z - player.pos.z;
    const kl = Math.hypot(kx, kz) || 1;
    channel.send({ type: 'broadcast', event: 'hit',
      payload: { to: id, from: myId, dmg, kx: kx / kl, kz: kz / kl } });
    flashAvatar(r);
  }
  window.mpPunch = function () {
    if (!channel || !joined || !remotes.size) return false;
    const nowT = performance.now();
    const target = aimAtRemote(4);
    if (!target) return false;
    if (nowT - punchCd < 400) return true;   // swing cooldown, but still swallow the click
    punchCd = nowT;
    const def = heldDef();
    sendHit(target.id, target.r, (def && def.dmg) || 1);
    sfx.hit();
    return true;
  };
  window.mpArrowCheck = function (pos, dmg, dir) {
    if (!channel || !joined || !remotes.size) return false;
    for (const [id, r] of remotes) {
      if (!r.group.visible) continue;
      const dx = pos.x - r.group.position.x, dy = pos.y - (r.group.position.y + 0.9), dz = pos.z - r.group.position.z;
      if (dx * dx + dy * dy + dz * dz < 1.1) {
        sendHit(id, r, dmg || 1);
        sfx.hit();
        return true;
      }
    }
    return false;
  };

  // called by the game every frame
  let posTimer = 0;
  window.mpTick = function (dt) {
    if (pendingSave && !uploading && Date.now() - lastUpload >= 10000) {
      pendingSave = false; upload();
    }
    if (!channel) return;
    posTimer += dt;
    if (joined && posTimer >= 0.12) {
      posTimer = 0;
      channel.send({ type: 'broadcast', event: 'pos',
        payload: { id: myId, name: myName, dim: dimId, t: +dayTime.toFixed(4),
          p: [+player.pos.x.toFixed(2), +player.pos.y.toFixed(2), +player.pos.z.toFixed(2)],
          yaw: +player.yaw.toFixed(2) } });
    }
    const nowT = performance.now();
    for (const [id, r] of remotes) {
      if (nowT - r.last > 10000) { dropRemote(id); continue; }
      r.group.visible = r.dim === dimId;
      r.group.position.lerp(r.target, Math.min(1, dt * 12));
      r.group.rotation.y += (r.yaw - r.group.rotation.y) * Math.min(1, dt * 12);
    }
  };

  updateBadge();
})();
