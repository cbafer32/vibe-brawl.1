(() => {
  const PLAYABLE = { left: -9, right: 9, bottom: 0, top: 11 };
  const BLAST    = { left: -16, right: 16, bottom: -10, top: 20 };

  const STAGE_URL = '/stage.glb?v=' + Date.now();
  // Half-width del suelo cableado en el bundle (`Ne=13`). Escalamos la TAPA
  // visible de la isla para que sus bordes coincidan con esa franja caminable
  // y no queden píxeles de "aire pisable" fuera del diseño de la isla.
  const BUNDLE_GROUND_HALF = 13;
  const TARGET_STAGE_WIDTH = BUNDLE_GROUND_HALF * 2; // ancho objetivo de la tapa
  const SURFACE_Y = 0;               // game's floor height (fighters stand on y=0)

  // Smash-style proportions, all expressed as multiples of the stage half-width.
  // Blue (PLAYABLE) is the "extended playable / stage area" – considerably bigger
  // than the island. Red (BLAST) is the KO boundary – far enough out to leave a
  // generous recovery zone between the two.
  const SMASH = {
    // Blue zone — surrounds the island with breathing room.
    blueHalfW:  1.6,   // 60% wider on each side than the stage
    blueAbove:  1.0,   // ~ stage half-width of headroom above
    blueBelow:  0.4,   // small dip below the floor
    // Red zone — the actual KO boundary.
    redHalfW:   3.0,   // ~3× the stage half-width horizontally (lots of room)
    redAbove:   2.2,   // tall ceiling for upward launches
    redBelow:   1.8,   // deep pit for recoveries from below
  };

  let stageSwapped = false;
  let newStage = null;
  // Floating platforms detected from the GLB: { y, left, right }
  const platforms = [];
  const prevY = new WeakMap();
  // Snapshot del estado anterior para detectar y revertir KOs internos del bundle
  // que se disparan en ±16/-6 (antes de cruzar el rojo real).
  const prevSnap = new WeakMap();

  // ============================================================
  // SMASH-STYLE KNOCKBACK SYSTEM
  // Overrides the bundle's takeHit with proper scaling + hitstun
  // ============================================================
  const _kbKeys = {};
  window.addEventListener('keydown', (e) => { _kbKeys[e.code] = true; }, { capture: true });
  window.addEventListener('keyup',   (e) => { _kbKeys[e.code] = false; }, { capture: true });

  function calcSmashKnockback(dmg) {
    // Exponential formula: low dmg = small knockback, high dmg = big launch
    const BASE    = 5;
    const SCALING = 0.05;
    return BASE + Math.pow(Math.max(0, dmg), 1.2) * SCALING;
  }

  function patchFighterTakeHit(f) {
    if (!f || f._kbPatched) return;
    if (typeof f.takeHit !== 'function') return;
    f._kbPatched = true;

    f.takeHit = function(damage, sourceX) {
      if (this.respawnTimer > 0) return;

      // Accumulate damage
      this.percent = (this.percent || 0) + damage;
      const dmg = this.percent;

      // Update facing direction (face away from attacker)
      const attackerDir = Math.sign(sourceX - this.position.x);
      if (attackerDir !== 0) this.facing = attackerDir;

      // Knockback direction = opposite to attacker
      const dir = -attackerDir || Math.sign(this.position.x - sourceX) || 1;
      const knockback = calcSmashKnockback(dmg);

      // Launch velocity
      this.velocity.x = dir * knockback;
      this.velocity.y = knockback * 0.7; // upward component

      // Hitstun in frames (capped at 60 = 1 second)
      const frames = Math.min(60, Math.floor(15 + dmg * 0.35));
      this._smashHitstun  = frames;
      this._smashVx       = this.velocity.x;

      // Sync bundle's hitstun (seconds) to lock out its control logic
      this.hitstun = frames / 60;

      // Reset action states
      this.grounded    = false;
      this.isRolling   = false;
      this.isAttacking = false;
      this.isBlocking  = false;
    };
  }

  function applySmashKnockbackPhysics(fighters, vb) {
    for (const f of fighters) {
      // Patch takeHit the first time we see this fighter
      patchFighterTakeHit(f);

      if (!f._smashHitstun || f._smashHitstun <= 0) continue;

      f._smashHitstun--;

      // Reduced air friction during knockback (0.98 instead of full lerp-to-zero)
      f._smashVx *= 0.98;

      // Limited directional influence (DI) for the human player only
      if (!f.grounded && f === vb.player) {
        if (_kbKeys['KeyA'] || _kbKeys['ArrowLeft'])  f._smashVx -= 0.3;
        if (_kbKeys['KeyD'] || _kbKeys['ArrowRight']) f._smashVx += 0.3;
      }

      // Force override velocity.x — this runs after the bundle's update,
      // so it wins over the bundle's lerp-based friction every frame
      f.velocity.x = f._smashVx;

      // Keep bundle hitstun in sync so the fighter stays locked out
      f.hitstun = Math.max(f.hitstun || 0, f._smashHitstun / 60);
    }
  }
  // ============================================================

  async function loadGLTFLoader() {
    const mod = await import('https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js');
    return mod.GLTFLoader;
  }

  async function loadTHREE() {
    return await import('https://esm.sh/three@0.184.0');
  }

  function makeSkyBackground(THREE) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0,  '#7ec8ff'); // top sky
    grad.addColorStop(0.55, '#bfe6ff'); // mid horizon
    grad.addColorStop(0.85, '#ffd9a8'); // warm haze
    grad.addColorStop(1.0,  '#ffb27a'); // ground glow
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  function findScene(vb) {
    const seeds = [vb.player, vb.dummy, vb.cpu2, vb.cpu3].filter(Boolean);
    for (const f of seeds) {
      let n = f && (f.modelPivot || f.model);
      while (n) {
        if (n.isScene) return n;
        n = n.parent;
      }
    }
    return null;
  }

  function fighterRoots(vb) {
    const roots = new Set();
    for (const f of [vb.player, vb.dummy, vb.cpu2, vb.cpu3]) {
      if (!f) continue;
      let n = f.modelPivot || f.model;
      while (n && n.parent && !n.parent.isScene) n = n.parent;
      if (n) roots.add(n);
    }
    return roots;
  }

  async function swapStage() {
    if (stageSwapped) return;
    const vb = window.__vb;
    if (!vb) return;
    const scene = findScene(vb);
    if (!scene) return;
    stageSwapped = true;

    // Hide everything currently in the scene that isn't a light/camera/fighter.
    const fighterSet = fighterRoots(vb);
    const toHide = [];
    for (const child of scene.children) {
      if (!child) continue;
      if (child.isLight || child.isCamera) continue;
      if (fighterSet.has(child)) continue;
      // Heuristic: skip anything that contains a SkinnedMesh (likely a fighter).
      let hasSkinned = false;
      child.traverse?.((n) => { if (n.isSkinnedMesh) hasSkinned = true; });
      if (hasSkinned) continue;
      toHide.push(child);
    }
    for (const c of toHide) {
      c.visible = false;
      c.userData.__vbHiddenByStageSwap = true;
    }

    // Strip the original scene background/fog so we can replace with a clean default sky.
    scene.userData.__vbOldFog = scene.fog;
    scene.userData.__vbOldBg = scene.background;
    scene.fog = null;
    scene.background = null;

    try {
      const [THREE, GLTFLoader] = await Promise.all([loadTHREE(), loadGLTFLoader()]);

      // Default sky background.
      try { scene.background = makeSkyBackground(THREE); } catch (_) {}

      const loader = new GLTFLoader();
      loader.load(STAGE_URL, (gltf) => {
        const root = gltf.scene || gltf.scenes?.[0];
        if (!root) return;

        root.traverse((n) => {
          if (n.isMesh) {
            n.castShadow = true;
            n.receiveShadow = true;
            if (n.material) {
              if (Array.isArray(n.material)) n.material.forEach(m => m.side = THREE.FrontSide);
              else n.material.side = THREE.FrontSide;
            }
          }
        });

        // Add to scene first so world matrices are valid.
        scene.add(root);
        root.updateMatrixWorld(true);

        // Collect every mesh with its local-space bbox before any scaling/translation.
        const meshes = [];
        root.traverse((n) => {
          if (!n.isMesh || !n.geometry) return;
          n.geometry.computeBoundingBox();
          const b = n.geometry.boundingBox;
          if (!b) return;
          // World-space bbox of just this mesh.
          const wb = new THREE.Box3().setFromObject(n);
          const sz = new THREE.Vector3(); wb.getSize(sz);
          meshes.push({ mesh: n, wb, sz });
        });

        if (meshes.length === 0) {
          newStage = root;
          window.__vb_newStage = root;
          return;
        }

        // Pick the base = mesh with the largest X * Z footprint (the island chunk).
        let base = meshes[0];
        let baseScore = base.sz.x * Math.max(0.01, base.sz.z);
        for (const m of meshes) {
          const s = m.sz.x * Math.max(0.01, m.sz.z);
          if (s > baseScore) { base = m; baseScore = s; }
        }

        // Identificar la TAPA visible de la isla = el mesh "amplio" cuyo techo
        // está más arriba. Es el disco de pasto sobre el que efectivamente
        // camina el jugador. Usamos su ancho raw para escalar el stage, así su
        // borde coincide con la franja caminable hardcodeada del bundle (±13).
        const baseFootprint = base.sz.x * Math.max(0.01, base.sz.z);
        let topMesh = base;
        let topY = -Infinity;
        for (const m of meshes) {
          const footprint = m.sz.x * Math.max(0.01, m.sz.z);
          if (footprint < baseFootprint * 0.3) continue; // descarta detalles pequeños
          const myTop = m.wb.max.y;
          if (myTop > topY) { topY = myTop; topMesh = m; }
        }
        const topRawW = Math.max(0.001, topMesh.sz.x);
        const scale = TARGET_STAGE_WIDTH / topRawW;
        root.scale.setScalar(scale);
        root.updateMatrixWorld(true);

        // Re-measure base in world space after scaling.
        const baseBox = new THREE.Box3().setFromObject(base.mesh);
        const baseCenter = new THREE.Vector3(); baseBox.getCenter(baseCenter);

        // Identify the "island top" = unión de todos los meshes que caen dentro
        // del XZ de la base (tapa de pasto, bordes, decoración encima del bloque
        // principal). Su top real es el suelo visible; usar solo base.max.y deja
        // al jugador flotando o hundido si la base es un mesh interno.
        const islandMeshes = [base.mesh];
        const islandTopBox = new THREE.Box3().copy(baseBox);
        for (const m of meshes) {
          if (m.mesh === base.mesh) continue;
          const wb = m.wb;
          const cx = (wb.min.x + wb.max.x) * 0.5;
          const cz = (wb.min.z + wb.max.z) * 0.5;
          // El centro XZ del mesh debe caer dentro de la base, y su top no debe
          // estar muy por encima de la base (descarta plataformas flotantes).
          const insideXZ =
            cx >= baseBox.min.x && cx <= baseBox.max.x &&
            cz >= baseBox.min.z && cz <= baseBox.max.z;
          const baseHeight = baseBox.max.y - baseBox.min.y;
          const stuckOnTop = wb.max.y <= baseBox.max.y + Math.max(0.6, baseHeight * 0.25);
          if (insideXZ && stuckOnTop) {
            islandMeshes.push(m.mesh);
            islandTopBox.union(wb);
          }
        }
        const islandTopY = islandTopBox.max.y;

        // Translate the whole stage so the ISLAND's real top surface sits at
        // SURFACE_Y and the base is centered on x=0, z=0.
        root.position.x -= baseCenter.x;
        root.position.z -= baseCenter.z;
        root.position.y += (SURFACE_Y - islandTopY);
        root.updateMatrixWorld(true);

        newStage = root;
        window.__vb_newStage = root;

        // Final base bbox in world space.
        const finalBaseBox = new THREE.Box3().setFromObject(base.mesh);
        const baseW = finalBaseBox.max.x - finalBaseBox.min.x;
        const islandSet = new Set(islandMeshes);

        // Detect floating platforms = thin, narrower-than-base meshes above the
        // floor, EXCLUYENDO los que forman la tapa de la isla.
        platforms.length = 0;
        for (const m of meshes) {
          if (islandSet.has(m.mesh)) continue;
          const wb = new THREE.Box3().setFromObject(m.mesh);
          const sx = wb.max.x - wb.min.x;
          const sy = wb.max.y - wb.min.y;
          const topY = wb.max.y;
          // Heuristics: platform must be thin, sit above the floor, and be narrower than the base.
          const isThin   = sy < 0.9;
          const isAbove  = topY > SURFACE_Y + 0.4;
          const isNarrow = sx < baseW * 0.85 && sx > 0.6;
          if (isThin && isAbove && isNarrow) {
            const inset = 0.05; // tiny edge inset
            platforms.push({
              y: topY,
              left: wb.min.x + sx * inset,
              right: wb.max.x - sx * inset,
            });
          }
        }
        // Sort by height for stable behavior.
        platforms.sort((a, b) => a.y - b.y);
        window.__vb_platforms = platforms;

        // Stage half-width = the unit we use for every Smash-style proportion.
        const stageHalf = baseW * 0.5;

        // Blue zone (PLAYABLE) — bigger than the island, gives breathing room.
        PLAYABLE.left   = -stageHalf * SMASH.blueHalfW;
        PLAYABLE.right  =  stageHalf * SMASH.blueHalfW;
        PLAYABLE.bottom = SURFACE_Y - stageHalf * SMASH.blueBelow;
        PLAYABLE.top    = SURFACE_Y + stageHalf * SMASH.blueAbove;

        // Red zone (BLAST) — KO boundary, far beyond the playable area so there
        // is real recovery space between the two.
        BLAST.left   = -stageHalf * SMASH.redHalfW;
        BLAST.right  =  stageHalf * SMASH.redHalfW;
        BLAST.bottom = SURFACE_Y - stageHalf * SMASH.redBelow;
        BLAST.top    = SURFACE_Y + stageHalf * SMASH.redAbove;

        window.__vb_bounds = { PLAYABLE, BLAST };
        console.log('[vb-map] stage fitted', {
          scale, baseW, stageHalf, platforms, PLAYABLE, BLAST,
        });
      }, undefined, (err) => {
        // If load fails, restore the original stage so the game is still playable.
        for (const c of toHide) {
          if (c.userData.__vbHiddenByStageSwap) c.visible = true;
        }
        console.error('Stage GLB failed to load:', err);
        stageSwapped = false;
      });
    } catch (e) {
      for (const c of toHide) {
        if (c.userData.__vbHiddenByStageSwap) c.visible = true;
      }
      console.error('GLTFLoader import failed:', e);
      stageSwapped = false;
    }
  }


  const SHOW_MINIMAP_RADIUS = 7;

  let mini, miniCtx;
  function ensureMinimap() {
    if (mini) return;
    mini = document.createElement('canvas');
    mini.id = 'vb-minimap';
    mini.width = 220;
    mini.height = 140;
    Object.assign(mini.style, {
      position: 'fixed',
      top: '24px',
      right: '24px',
      width: '220px',
      height: '140px',
      zIndex: 9999,
      pointerEvents: 'none',
      background: 'rgba(8,6,20,.78)',
      border: '1px solid rgba(255,255,255,.12)',
      borderRadius: '12px',
      boxShadow: '0 10px 30px rgba(0,0,0,.5)',
      backdropFilter: 'blur(6px)',
      opacity: '0',
      transition: 'opacity .2s ease',
    });
    document.body.appendChild(mini);
    miniCtx = mini.getContext('2d');
  }

  function drawMinimap(fighters, focus) {
    ensureMinimap();
    // El minimapa se abre cuando CUALQUIER luchador cruza el borde azul (PLAYABLE).
    const anyOutsideBlue = fighters.some((f) => {
      if (!f || !f.position || !f.alive) return false;
      return (
        f.position.x < PLAYABLE.left ||
        f.position.x > PLAYABLE.right ||
        f.position.y < PLAYABLE.bottom ||
        f.position.y > PLAYABLE.top
      );
    });
    mini.style.opacity = anyOutsideBlue ? '1' : '0';
    if (!anyOutsideBlue) return;

    const W = mini.width, H = mini.height;
    const pad = 14;
    const bw = BLAST.right - BLAST.left;
    const bh = BLAST.top - BLAST.bottom;
    const sx = (W - pad * 2) / bw;
    const sy = (H - pad * 2) / bh;
    const scale = Math.min(sx, sy);
    const cx = (BLAST.left + BLAST.right) * 0.5;
    const cy = (BLAST.bottom + BLAST.top) * 0.5;
    const ox = W / 2;
    const oy = H / 2;
    const wx = (x) => ox + (x - cx) * scale;
    const wy = (y) => oy - (y - cy) * scale;

    miniCtx.clearRect(0, 0, W, H);

    // blast rect
    miniCtx.strokeStyle = 'rgba(255,107,107,.85)';
    miniCtx.setLineDash([4, 4]);
    miniCtx.lineWidth = 1.5;
    miniCtx.strokeRect(
      wx(BLAST.left), wy(BLAST.top),
      (BLAST.right - BLAST.left) * scale,
      (BLAST.top - BLAST.bottom) * scale
    );

    // playable rect
    miniCtx.setLineDash([]);
    miniCtx.strokeStyle = 'rgba(78,195,255,.95)';
    miniCtx.lineWidth = 2;
    miniCtx.strokeRect(
      wx(PLAYABLE.left), wy(PLAYABLE.top),
      (PLAYABLE.right - PLAYABLE.left) * scale,
      (PLAYABLE.top - PLAYABLE.bottom) * scale
    );

    // ground line
    miniCtx.strokeStyle = 'rgba(255,255,255,.18)';
    miniCtx.beginPath();
    miniCtx.moveTo(wx(BLAST.left), wy(0));
    miniCtx.lineTo(wx(BLAST.right), wy(0));
    miniCtx.stroke();

    // fighters
    const colors = ['#ffd86b', '#ff6b9d', '#5fd47a', '#4ec3ff'];
    fighters.forEach((f, i) => {
      if (!f || !f.position || !f.alive) return;
      const px = wx(f.position.x);
      const py = wy(f.position.y);
      miniCtx.fillStyle = colors[i % colors.length];
      miniCtx.shadowBlur = i === 0 ? 10 : 0;
      miniCtx.shadowColor = colors[i % colors.length];
      miniCtx.beginPath();
      miniCtx.arc(px, py, i === 0 ? 5 : 4, 0, Math.PI * 2);
      miniCtx.fill();
      miniCtx.shadowBlur = 0;
      if (i === 0) {
        miniCtx.strokeStyle = '#fff';
        miniCtx.lineWidth = 1.5;
        miniCtx.stroke();
      }
    });
  }

  function ko(f) {
    if (!f.alive) return;
    if (f._koCooldown && performance.now() < f._koCooldown) return;
    f._koCooldown = performance.now() + 1500;

    f.lives = Math.max(0, (typeof f.lives === 'number' ? f.lives : 3) - 1);
    if (f.percent !== undefined) f.percent = 0;
    if (f.hitstun !== undefined) f.hitstun = 0;
    if (f.velocity && f.velocity.set) f.velocity.set(0, 0, 0);
    if (f.position && f.position.set) {
      const sx = typeof f.spawnX === 'number' ? f.spawnX : 0;
      f.position.set(sx, 6, 0);
    }
    if (f.lives <= 0) {
      f.alive = false;
    } else {
      f.respawnTimer = 1.2;
    }
  }

  // --- Bordes como TRIGGERS (no colisiones sólidas) ---
  // Etiquetas conceptuales:
  //   - "BordeAzul" (PLAYABLE): trigger -> abre minimapa (onTriggerEnter, una sola vez)
  //   - "BordeRojo" (BLAST):    trigger -> mata (onTriggerEnter, una sola vez)
  //
  // El bundle minificado tiene un chequeo de KO interno cableado en ±16 / y<-6
  // (función `Qn`) que actúa como un "onTriggerStay": cada frame decrementa vida
  // y reproduce el sonido `le.ko()` mientras el luchador esté en esa zona, lo
  // cual provoca el bug del sonido en bucle.
  //
  // Solución: envolvemos la propiedad `alive` con un Proxy. Cuando la lectura
  // proviene de la función `Qn` del bundle, devolvemos `false` para que el
  // chequeo `l.alive && (...)` haga corto-circuito y no entre al cuerpo (no
  // decrementa vidas, no reproduce sonido). Para cualquier otro consumidor
  // (render, lógica de update, nuestro código), `alive` sigue devolviendo el
  // valor real.
  //
  // Detección de quién llama: leemos `new Error().stack`. El bundle minificado
  // usa el nombre `Qn` que aparece en el stack tanto en V8 ("at Qn (...)")
  // como en Firefox ("Qn@...").
  function isCalledFromBundleKO() {
    const stack = (new Error()).stack || '';
    return /(?:^|[\s@(])Qn(?:[\s@(.]|$)/m.test(stack);
  }

  function patchFighterAlive(f) {
    if (!f || f._alivePatched) return;
    if (typeof f.alive === 'undefined') return;
    f._alivePatched = true;
    f._alive = f.alive;
    Object.defineProperty(f, 'alive', {
      configurable: true,
      enumerable: true,
      get() {
        if (!this._alive) return false;
        if (isCalledFromBundleKO()) {
          // Solo ocultamos del bundle si NO está realmente en la zona roja.
          const p = this.position;
          if (!p) return true;
          const inBlast =
            p.x < BLAST.left || p.x > BLAST.right ||
            p.y < BLAST.bottom || p.y > BLAST.top;
          if (!inBlast) return false; // hace corto-circuito en Qn
        }
        return true;
      },
      set(v) { this._alive = !!v; },
    });
  }

  function applyMapRules() {
    const vb = window.__vb;
    if (!vb) return;
    const fighters = [vb.player, vb.dummy, vb.cpu2, vb.cpu3].filter(Boolean);

    // 0) Convertir bordes en triggers para cada luchador (idempotente).
    for (const f of fighters) patchFighterAlive(f);

    // 0b) Apply smash-style knockback physics (overrides bundle's lerp friction).
    applySmashKnockbackPhysics(fighters, vb);

    for (const f of fighters) {
      if (!f || !f.position || !f.alive) continue;

      // 1) Ambos bordes son traspasables. El azul (PLAYABLE) NO mata: solo
      //    dispara la apertura del minimapa cuando alguien lo cruza. El rojo
      //    (BLAST) es la única zona de muerte (paso 4).
      //    Tags conceptuales: "Borde" (azul, no mata) y "ZonaMuerte" (rojo, mata).
      const vy = (f.velocity && f.velocity.y) || 0;

      // 2b) One-way platform collisions (the "white lines").
      // If the fighter was above a platform last frame and is now at/below it
      // while moving downward, snap them onto it.
      const py = prevY.has(f) ? prevY.get(f) : f.position.y;
      if (platforms.length && f.velocity && vy <= 0.5) {
        for (const p of platforms) {
          if (f.position.x < p.left || f.position.x > p.right) continue;
          const tol = 0.6; // landing tolerance in units
          if (py >= p.y - 0.05 && f.position.y <= p.y + tol) {
            f.position.y = p.y;
            f.velocity.y = 0;
            if ('grounded' in f) f.grounded = true;
            if ('jumpCount' in f) f.jumpCount = 0;
            break;
          }
        }
      }
      prevY.set(f, f.position.y);

      // 3) Lock depth axis flat (2.5D feel, no z drift).
      if (typeof f.position.z === 'number') {
        f.position.z = 0;
        if (f.velocity && typeof f.velocity.z === 'number') f.velocity.z = 0;
      }

      // 4) Zona de muerte ROJA (BLAST) — única que mata.
      if (
        f.position.x < BLAST.left  ||
        f.position.x > BLAST.right ||
        f.position.y < BLAST.bottom ||
        f.position.y > BLAST.top
      ) {
        ko(f);
      }
    }

    // 5) Snapshot final del frame: usado en el próximo frame para revertir
    //    cualquier KO que dispare el bundle estando dentro del rojo.
    for (const f of fighters) {
      if (!f || !f.position) continue;
      prevSnap.set(f, {
        x: f.position.x,
        y: f.position.y,
        vx: (f.velocity && f.velocity.x) || 0,
        vy: (f.velocity && f.velocity.y) || 0,
        lives: typeof f.lives === 'number' ? f.lives : 3,
        alive: f.alive !== false,
        percent: typeof f.percent === 'number' ? f.percent : 0,
      });
    }

    drawMinimap(fighters, vb.player);
    try { updateHud(fighters); } catch (_) {}
  }

  let waited = 0;
  function tick() {
    requestAnimationFrame(tick);
    if (!window.__vb) {
      if (++waited > 1200) return;
      return;
    }
    if (!stageSwapped) {
      // Wait until at least one fighter model is in a scene before swapping.
      const vb = window.__vb;
      const ready = [vb.player, vb.dummy, vb.cpu2, vb.cpu3].some((f) => {
        const n = f && (f.modelPivot || f.model);
        if (!n) return false;
        let p = n;
        while (p) { if (p.isScene) return true; p = p.parent; }
        return false;
      });
      if (ready) swapStage();
    }
    try { applyMapRules(); } catch (e) { /* swallow per-frame errors */ }
  }
  tick();

  // -------- Smash-style damage HUD (bottom of the screen) --------
  const HUD_COLORS = ['#ffd86b', '#ff6b9d', '#5fd47a', '#4ec3ff'];

  let hudRoot, hudCards = [];
  function ensureHud() {
    if (hudRoot) return;
    hudRoot = document.createElement('div');
    hudRoot.id = 'vb-hud';
    Object.assign(hudRoot.style, {
      position: 'fixed',
      left: '50%',
      bottom: '14px',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '10px',
      zIndex: 9999,
      pointerEvents: 'none',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    });
    document.body.appendChild(hudRoot);
  }

  function makeCard(i, name, color) {
    const card = document.createElement('div');
    Object.assign(card.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 14px 8px 8px',
      background: 'linear-gradient(180deg, rgba(20,16,40,.92), rgba(8,6,20,.92))',
      border: `2px solid ${color}`,
      borderRadius: '14px',
      boxShadow: `0 8px 24px rgba(0,0,0,.5), 0 0 12px ${color}55 inset`,
      minWidth: '128px',
      transition: 'opacity .25s, filter .25s, transform .15s',
    });

    const avatar = document.createElement('div');
    Object.assign(avatar.style, {
      width: '34px', height: '34px',
      borderRadius: '50%',
      background: `radial-gradient(circle at 30% 30%, ${color}, ${color}88 70%, #000)`,
      color: '#0a0612',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      font: '800 16px/1 system-ui, sans-serif',
      letterSpacing: '.02em',
      border: `1px solid ${color}`,
      flex: '0 0 auto',
      textShadow: '0 1px 0 rgba(255,255,255,.4)',
    });
    avatar.textContent = (name || '?').trim().charAt(0).toUpperCase();

    const col = document.createElement('div');
    Object.assign(col.style, { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: '1' });

    const nameEl = document.createElement('div');
    Object.assign(nameEl.style, {
      font: '700 9px/1 system-ui, sans-serif',
      letterSpacing: '.16em',
      textTransform: 'uppercase',
      color: 'rgba(255,255,255,.78)',
      marginBottom: '4px',
      maxWidth: '110px',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    });
    nameEl.textContent = name || `P${i+1}`;

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'baseline', gap: '4px' });

    const pct = document.createElement('div');
    Object.assign(pct.style, {
      font: '900 26px/1 system-ui, sans-serif',
      color: '#fff',
      textShadow: `0 0 10px ${color}99`,
      fontVariantNumeric: 'tabular-nums',
    });
    pct.textContent = '0';

    const sym = document.createElement('div');
    Object.assign(sym.style, {
      font: '900 14px/1 system-ui, sans-serif',
      color: 'rgba(255,255,255,.55)',
    });
    sym.textContent = '%';

    row.appendChild(pct);
    row.appendChild(sym);

    const lives = document.createElement('div');
    Object.assign(lives.style, {
      marginLeft: '6px',
      font: '700 10px/1 system-ui, sans-serif',
      color: color,
      letterSpacing: '.1em',
    });
    lives.textContent = '●●●';

    row.appendChild(lives);

    col.appendChild(nameEl);
    col.appendChild(row);

    card.appendChild(avatar);
    card.appendChild(col);

    return { card, pct, lives, nameEl, color };
  }

  function pctColor(p) {
    // 0% white, 30% yellow, 60% orange, 100%+ red
    if (p < 30)  return '#ffffff';
    if (p < 60)  return '#ffe66b';
    if (p < 100) return '#ff9b4a';
    if (p < 150) return '#ff5b5b';
    return '#ff3b8c';
  }

  function updateHud(fighters) {
    ensureHud();
    // (Re)build cards if fighter list changed.
    if (hudCards.length !== fighters.length) {
      hudRoot.innerHTML = '';
      hudCards = fighters.map((f, i) => {
        const c = makeCard(i, f.name || `P${i+1}`, HUD_COLORS[i % HUD_COLORS.length]);
        hudRoot.appendChild(c.card);
        return c;
      });
    }
    fighters.forEach((f, i) => {
      const c = hudCards[i];
      if (!c) return;
      const p = Math.max(0, Math.round(f.percent || 0));
      c.pct.textContent = String(p);
      c.pct.style.color = pctColor(p);
      c.pct.style.textShadow = `0 0 10px ${pctColor(p)}99`;
      const lives = Math.max(0, Math.min(5, typeof f.lives === 'number' ? f.lives : 3));
      c.lives.textContent = '●'.repeat(lives) + '○'.repeat(Math.max(0, 3 - lives));
      const dead = !f.alive || lives <= 0;
      c.card.style.opacity = dead ? '0.35' : '1';
      c.card.style.filter = dead ? 'grayscale(.7)' : 'none';
    });
  }

  // Tiny on-screen legend so you know the new system is active.
  function legend() {
    const el = document.createElement('div');
    el.textContent = 'MAPA · paredes ✓ · blast zones ✓ · minimapa ✓';
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      top: '12px',
      transform: 'translateX(-50%)',
      padding: '6px 14px',
      borderRadius: '999px',
      background: 'rgba(0,0,0,.5)',
      border: '1px solid rgba(255,255,255,.1)',
      color: 'rgba(255,255,255,.7)',
      font: '600 11px/1 system-ui, sans-serif',
      letterSpacing: '.18em',
      textTransform: 'uppercase',
      zIndex: 9998,
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity .4s',
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; }, 4500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', legend);
  } else {
    legend();
  }
})();
