/**
 * Docked analysis / debug control panel (no external GUI dependency).
 */

const CSS = `
#analysis-gui {
  position: fixed; top: 10px; right: 10px; z-index: 20;
  width: 292px; max-height: calc(100vh - 20px); overflow: auto;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #f3e6ea; background: rgba(18, 10, 14, 0.88);
  border: 1px solid rgba(255, 170, 190, 0.28); border-radius: 8px;
  backdrop-filter: blur(8px); user-select: none;
}
#analysis-gui.collapsed .ag-body { display: none; }
#analysis-gui .ag-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; cursor: pointer;
  border-bottom: 1px solid rgba(255,170,190,0.18);
  color: #ffb6c8; font-weight: 600; letter-spacing: 0.04em;
}
#analysis-gui .ag-body { padding: 6px 8px 10px; }
#analysis-gui details {
  border: 1px solid rgba(255,170,190,0.12); border-radius: 6px;
  margin: 6px 0; padding: 0 6px 6px; background: rgba(255,255,255,0.02);
}
#analysis-gui summary {
  cursor: pointer; padding: 6px 2px; color: #ffc4d2; font-weight: 600;
}
#analysis-gui label.row {
  display: flex; align-items: center; gap: 8px; margin: 3px 0; color: #e8d5db;
}
#analysis-gui label.row span.k { flex: 1; }
#analysis-gui label.row input[type="checkbox"] { accent-color: #ff8fad; }
#analysis-gui label.slider {
  display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 5px 0;
  color: #e8d5db;
}
#analysis-gui label.slider input[type="range"] { grid-column: 1 / -1; width: 100%; accent-color: #ff8fad; }
#analysis-gui label.slider .v { color: #ffb6c8; }
#analysis-gui .btns { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
#analysis-gui button {
  font: inherit; color: #1a1014; background: #ffb0c4; border: 0; border-radius: 4px;
  padding: 4px 7px; cursor: pointer;
}
#analysis-gui button.ghost {
  background: transparent; color: #ffb0c4; border: 1px solid rgba(255,176,196,0.45);
}
#analysis-gui button:hover { filter: brightness(1.08); }
#analysis-gui .stats {
  margin-top: 6px; padding: 6px; border-radius: 4px;
  background: rgba(0,0,0,0.28); color: #d8c4cc; white-space: pre-wrap;
}
#analysis-gui .hint { color: #a89098; font-size: 10px; margin-top: 4px; }
#analysis-gui input.color {
  width: 42px; height: 22px; padding: 0; border: 1px solid rgba(255,176,196,0.45);
  background: transparent; cursor: pointer;
}
`;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function checkbox(key, label, checked, onChange) {
  const row = el(`<label class="row"><span class="k"></span><input type="checkbox"/></label>`);
  row.querySelector('.k').textContent = label;
  const input = row.querySelector('input');
  input.checked = checked;
  input.addEventListener('change', () => onChange(key, input.checked));
  return row;
}

function colorPicker(key, label, hex, onChange) {
  const row = el(
    `<label class="row"><span class="k"></span><input type="color" class="color"/></label>`
  );
  row.querySelector('.k').textContent = label;
  const input = row.querySelector('input');
  input.value = hex.startsWith('#') ? hex : `#${hex}`;
  input.addEventListener('input', () => onChange(key, input.value));
  return row;
}

function colorToHex(c) {
  if (!c) return '#ff8fbc';
  if (typeof c === 'string') return c.startsWith('#') ? c : `#${c}`;
  if (c.isColor || (c.r != null && c.g != null && c.b != null)) {
    return `#${c.getHexString?.() ?? (
      ((Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255))
        .toString(16)
        .padStart(6, '0')
    )}`;
  }
  return '#ff8fbc';
}

function slider(key, label, min, max, step, value, onChange) {
  const row = el(
    `<label class="slider"><span class="k"></span><span class="v"></span><input type="range"/></label>`
  );
  row.querySelector('.k').textContent = label;
  const input = row.querySelector('input');
  const val = row.querySelector('.v');
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  val.textContent = String(value);
  input.addEventListener('input', () => {
    val.textContent = input.value;
  });
  input.addEventListener('change', () => onChange(key, Number(input.value)));
  return { row, input, val };
}

/**
 * @param {object} opts
 * @param {import('./DebugOverlay.js').DebugOverlay} opts.overlay
 * @param {import('../engine/ProceduralSakuraEngine.js').ProceduralSakuraEngine} opts.engine
 * @param {object} opts.refs
 * @param {(params: object) => void} opts.onRebuild
 * @param {(name: string) => void} opts.onPreset
 * @param {(cam: string) => void} opts.onCamera
 * @param {(n: number) => void} [opts.onCanopyCount]
 * @param {(s: number) => void} [opts.onCanopySize]
 * @param {(s: number) => void} [opts.onPeduncleScale]
 * @param {(opts: object) => void} [opts.onBlossomRender]
 * @param {() => object} opts.getStats
 */
export function mountAnalysisGui(opts) {
  const {
    overlay,
    engine,
    refs,
    onRebuild,
    onPreset,
    onCamera,
    onCanopyCount,
    onCanopySize,
    onPeduncleScale,
    onBlossomRender,
    getStats
  } = opts;
  if (document.querySelector('#analysis-gui')) return null;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el(`
    <div id="analysis-gui">
      <div class="ag-head"><span>ANALYSIS / DEBUG</span><span class="tog">▾</span></div>
      <div class="ag-body"></div>
    </div>
  `);
  document.body.appendChild(root);
  const body = root.querySelector('.ag-body');
  root.querySelector('.ag-head').addEventListener('click', () => {
    root.classList.toggle('collapsed');
    root.querySelector('.tog').textContent = root.classList.contains('collapsed') ? '▸' : '▾';
  });

  const s = overlay.state;
  const refreshLayers = () => overlay.apply(engine, refs);

  // ── Presets ──
  const presets = el(`<details open><summary>View presets</summary><div class="btns"></div></details>`);
  const pBtns = presets.querySelector('.btns');
  for (const [id, label] of [
    ['beauty', 'Beauty'],
    ['skeleton', 'Skeleton'],
    ['mesh', 'Mesh QC'],
    ['roots', 'Roots'],
    ['full', 'Full debug']
  ]) {
    const b = el(`<button type="button"></button>`);
    b.textContent = label;
    b.addEventListener('click', () => {
      onPreset(id);
      syncChecks();
      updateStats();
    });
    pBtns.appendChild(b);
  }
  body.appendChild(presets);

  // ── Layers ──
  const layers = el(`<details open><summary>Layers</summary><div class="layer-list"></div></details>`);
  const layerList = layers.querySelector('.layer-list');
  const layerDefs = [
    ['bark', 'Bark mesh'],
    ['wireframe', 'Bark wireframe'],
    ['normals', 'Vertex normals'],
    ['skeleton', 'Skeleton edges'],
    ['nodes', 'Skeleton nodes'],
    ['capsules', 'SDF capsules'],
    ['frames', 'PT frames (TNB)'],
    ['bounds', 'AABB bounds'],
    ['groundPlane', 'Grid / y=0 plane'],
    ['showShoots', 'Show shoots'],
    ['showRoots', 'Show roots'],
    ['canopy', 'Canopy blossoms'],
    ['grass', 'Grass'],
    ['moss', 'Moss'],
    ['petals', 'Falling petals'],
    ['calRefs', '1m cube / human']
  ];
  const checkMap = new Map();
  for (const [key, label] of layerDefs) {
    const row = checkbox(key, label, Boolean(s[key]), (k, v) => {
      overlay.set(k, v);
      if (k === 'showRoots' || k === 'showShoots') {
        overlay.syncSkeleton(engine.skeleton);
      }
      refreshLayers();
    });
    checkMap.set(key, row.querySelector('input'));
    layerList.appendChild(row);
  }
  body.appendChild(layers);

  function syncChecks() {
    for (const [key, input] of checkMap) {
      input.checked = Boolean(overlay.state[key]);
    }
  }

  // ── Bake quality ──
  const bake = el(`<details open><summary>Bark bake quality</summary><div class="bake"></div>
    <p class="hint">Finer voxel = smoother SDF→mesh (slower). Rebuild applies skeleton + MC.</p></details>`);
  const bakeBox = bake.querySelector('.bake');
  const bakeState = {
    voxelM: engine.barkMesher?.defaults?.voxelM ?? 0.065,
    attractorCount: engine.barkMesher?.defaults?.attractorCount ?? 700,
    rootAttractorCount: engine.barkMesher?.defaults?.rootAttractorCount ?? 350,
    maxIterations: engine.barkMesher?.defaults?.maxIterations ?? 160,
    maxRootIterations: engine.barkMesher?.defaults?.maxRootIterations ?? 110,
    simplifyCellScale: engine.barkMesher?.defaults?.simplifyCellScale ?? 1.15,
    seed: engine.barkMesher?.defaults?.seed ?? 42,
    twigDensity: engine.barkMesher?.defaults?.twigDensity ?? 1,
    twigBranchMult: engine.barkMesher?.defaults?.twigBranchMult ?? 2,
    forkYM: engine.barkMesher?.defaults?.forkYM ?? 2
  };
  const sliders = {};
  for (const def of [
    ['voxelM', 'Voxel size (m)', 0.04, 0.2, 0.005],
    ['attractorCount', 'Crown attractors', 200, 1600, 50],
    ['rootAttractorCount', 'Root attractors', 80, 900, 20],
    ['maxIterations', 'Crown iterations', 40, 320, 10],
    ['maxRootIterations', 'Root iterations', 30, 240, 10],
    ['simplifyCellScale', 'Simplify cell×voxel', 0.8, 2.5, 0.05],
    ['seed', 'Seed', 1, 999, 1]
  ]) {
    const [key, label, min, max, step] = def;
    const ctl = slider(key, label, min, max, step, bakeState[key], (k, v) => {
      bakeState[k] = v;
    });
    sliders[key] = ctl;
    bakeBox.appendChild(ctl.row);
  }
  const bakeBtns = el(`<div class="btns"></div>`);
  for (const [id, label] of [
    ['draft', 'Draft'],
    ['playable', 'Playable'],
    ['high', 'High'],
    ['rebuild', 'Rebuild now']
  ]) {
    const b = el(`<button type="button" class="${id === 'rebuild' ? '' : 'ghost'}"></button>`);
    b.textContent = label;
    b.addEventListener('click', () => {
      if (id !== 'rebuild') {
        const presetsQ = {
          draft: { voxelM: 0.14, attractorCount: 280, rootAttractorCount: 140, maxIterations: 70, maxRootIterations: 50, simplifyCellScale: 1.8 },
          playable: { voxelM: 0.065, attractorCount: 700, rootAttractorCount: 350, maxIterations: 160, maxRootIterations: 110, simplifyCellScale: 1.15 },
          high: { voxelM: 0.045, attractorCount: 1100, rootAttractorCount: 520, maxIterations: 220, maxRootIterations: 150, simplifyCellScale: 1.0 }
        };
        Object.assign(bakeState, presetsQ[id]);
        for (const [k, ctl] of Object.entries(sliders)) {
          ctl.input.value = String(bakeState[k]);
          ctl.val.textContent = String(bakeState[k]);
        }
      }
      onRebuild({ ...bakeState });
      updateStats();
    });
    bakeBtns.appendChild(b);
  }
  bakeBox.appendChild(bakeBtns);
  body.appendChild(bake);

  // ── Foliage / canopy ──
  const foliage = el(
    `<details open><summary>Foliage / canopy</summary><div class="foliage"></div>
    <p class="hint">Count / size are live. Twig density &amp; branching rebuild the skeleton (bark bake).</p></details>`
  );
  const foliageBox = foliage.querySelector('.foliage');
  const canopyCtl = slider(
    'canopyCount',
    'Blossoms (canopy)',
    100,
    2_000_000,
    1000,
    engine.canopy?.count ?? 12000,
    (_k, v) => {
      onCanopyCount?.(v);
      updateStats();
    }
  );
  // Also apply while dragging for immediate feedback
  canopyCtl.input.addEventListener('input', () => {
    const v = Number(canopyCtl.input.value);
    canopyCtl.val.textContent = String(v);
    onCanopyCount?.(v);
  });
  foliageBox.appendChild(canopyCtl.row);

  const sizeCtl = slider(
    'blossomSize',
    'Blossom size',
    0.25,
    2.5,
    0.05,
    engine.canopy?.sizeScale ?? 1,
    (_k, v) => {
      onCanopySize?.(v);
      updateStats();
    }
  );
  sizeCtl.input.addEventListener('input', () => {
    const v = Number(sizeCtl.input.value);
    sizeCtl.val.textContent = v.toFixed(2);
    onCanopySize?.(v);
  });
  foliageBox.appendChild(sizeCtl.row);

  const rebuildTwigs = () => {
    onRebuild({ ...bakeState });
    updateStats();
  };

  const twigDensCtl = slider(
    'twigDensity',
    'Small branch density',
    0.25,
    3,
    0.05,
    bakeState.twigDensity,
    (_k, v) => {
      bakeState.twigDensity = v;
      if (engine.barkMesher?.defaults) engine.barkMesher.defaults.twigDensity = v;
      rebuildTwigs();
    }
  );
  twigDensCtl.input.addEventListener('input', () => {
    const v = Number(twigDensCtl.input.value);
    twigDensCtl.val.textContent = v.toFixed(2);
    bakeState.twigDensity = v;
  });
  foliageBox.appendChild(twigDensCtl.row);

  const twigBranchCtl = slider(
    'twigBranchMult',
    'Small branch branching ×',
    0.5,
    4,
    0.1,
    bakeState.twigBranchMult,
    (_k, v) => {
      bakeState.twigBranchMult = v;
      if (engine.barkMesher?.defaults) engine.barkMesher.defaults.twigBranchMult = v;
      rebuildTwigs();
    }
  );
  twigBranchCtl.input.addEventListener('input', () => {
    const v = Number(twigBranchCtl.input.value);
    twigBranchCtl.val.textContent = v.toFixed(1);
    bakeState.twigBranchMult = v;
  });
  foliageBox.appendChild(twigBranchCtl.row);

  const pedCtl = slider(
    'peduncleScale',
    'Peduncle (attach twig) ×',
    0.15,
    3.5,
    0.05,
    engine.canopy?.peduncleScale ?? 1,
    (_k, v) => {
      onPeduncleScale?.(v);
      updateStats();
    }
  );
  pedCtl.input.addEventListener('input', () => {
    const v = Number(pedCtl.input.value);
    pedCtl.val.textContent = v.toFixed(2);
    onPeduncleScale?.(v);
  });
  foliageBox.appendChild(pedCtl.row);

  const forkCtl = slider(
    'forkYM',
    'First branch height (m)',
    0.3,
    5,
    0.05,
    bakeState.forkYM,
    (_k, v) => {
      bakeState.forkYM = v;
      if (engine.barkMesher?.defaults) engine.barkMesher.defaults.forkYM = v;
      rebuildTwigs();
    }
  );
  forkCtl.input.addEventListener('input', () => {
    const v = Number(forkCtl.input.value);
    forkCtl.val.textContent = v.toFixed(2);
    bakeState.forkYM = v;
  });
  foliageBox.appendChild(forkCtl.row);
  body.appendChild(foliage);

  // ── Blossom render / lighting ──
  const renderBox = el(
    `<details open><summary>Blossom render</summary><div class="render"></div>
    <p class="hint">Shadows on by default (blossoms shade each other). Lower emissive if blown out.</p></details>`
  );
  const renderPane = renderBox.querySelector('.render');
  const mat = engine.canopy?.material;
  const renderState = {
    castShadow: engine.canopy?.castShadow !== false,
    receiveShadow: engine.canopy?.receiveShadow !== false,
    primaryColor: colorToHex(mat?.color),
    centerColor: colorToHex(mat?.userData?.uniforms?.uPetalCore?.value),
    emissiveIntensity: mat?.emissiveIntensity ?? 0.22,
    brightBoost: mat?.userData?.uniforms?.uBrightBoost?.value ?? 0.28,
    edgeFade: mat?.userData?.uniforms?.uEdgeFade?.value ?? 0.85,
    roughness: mat?.roughness ?? 0.62,
    opacity: mat?.opacity ?? 1,
    exposure: 1.0,
    sunIntensity: engine.sun?.intensity ?? 1.35,
    hemiIntensity: engine.hemi?.intensity ?? 0.72
  };

  renderPane.appendChild(
    colorPicker('primaryColor', 'Primary color', renderState.primaryColor, (_k, v) => {
      renderState.primaryColor = v;
      onBlossomRender?.(renderState);
    })
  );
  renderPane.appendChild(
    colorPicker('centerColor', 'Center color', renderState.centerColor, (_k, v) => {
      renderState.centerColor = v;
      onBlossomRender?.(renderState);
    })
  );

  renderPane.appendChild(
    checkbox('castShadow', 'Blossom cast shadow', renderState.castShadow, (_k, v) => {
      renderState.castShadow = v;
      onBlossomRender?.(renderState);
    })
  );
  renderPane.appendChild(
    checkbox('receiveShadow', 'Blossom receive shadow', renderState.receiveShadow, (_k, v) => {
      renderState.receiveShadow = v;
      onBlossomRender?.(renderState);
    })
  );

  for (const def of [
    ['emissiveIntensity', 'Emissive', 0, 1.2, 0.01],
    ['brightBoost', 'Bright boost', 0, 1.2, 0.01],
    ['edgeFade', 'Edge fade', 0, 1, 0.01],
    ['roughness', 'Roughness', 0.1, 1, 0.01],
    ['opacity', 'Opacity', 0.2, 1, 0.01],
    ['exposure', 'Tone exposure', 0.4, 1.8, 0.01],
    ['sunIntensity', 'Sun intensity', 0.2, 2.5, 0.05],
    ['hemiIntensity', 'Hemi intensity', 0.1, 1.5, 0.05]
  ]) {
    const [key, label, min, max, step] = def;
    const ctl = slider(key, label, min, max, step, renderState[key], (k, v) => {
      renderState[k] = v;
      onBlossomRender?.(renderState);
    });
    ctl.input.addEventListener('input', () => {
      const v = Number(ctl.input.value);
      ctl.val.textContent = v.toFixed(2);
      renderState[key] = v;
      onBlossomRender?.(renderState);
    });
    renderPane.appendChild(ctl.row);
  }
  body.appendChild(renderBox);

  // ── Camera ──
  const cam = el(`<details><summary>Camera</summary><div class="btns"></div></details>`);
  const camBtns = cam.querySelector('.btns');
  for (const [id, label] of [
    ['hero', 'Hero'],
    ['trunk', 'Trunk'],
    ['roots', 'Roots'],
    ['top', 'Top'],
    ['wire', 'Close mesh']
  ]) {
    const b = el(`<button type="button" class="ghost"></button>`);
    b.textContent = label;
    b.addEventListener('click', () => onCamera(id));
    camBtns.appendChild(b);
  }
  body.appendChild(cam);

  // ── Stats ──
  const statsBox = el(`<details open><summary>Live stats</summary><div class="stats">—</div></details>`);
  const statsEl = statsBox.querySelector('.stats');
  body.appendChild(statsBox);

  function updateStats() {
    const st = getStats();
    statsEl.textContent = [
      `nodes ${st.nodes ?? '—'}  edges ${st.edges ?? '—'}`,
      `shoots ${st.shootEdges ?? '—'}  roots ${st.rootEdges ?? '—'}`,
      `bark tris ${st.barkTris ?? '—'}  voxel ${st.voxelM ?? '—'} m`,
      `bake ${st.bakeMs != null ? st.bakeMs.toFixed(0) + ' ms' : '—'}`,
      `simplify ${st.simplify ?? '—'}`,
      `draw ${st.drawCalls ?? '—'}  scene tris ${st.triangles ?? '—'}`,
      `canopy placed ${st.canopyCount ?? '—'} / target ${engine.canopy?.count ?? '—'}`,
      `blossom size ×${(engine.canopy?.sizeScale ?? 1).toFixed(2)}  peduncle ×${(engine.canopy?.peduncleScale ?? 1).toFixed(2)}`,
      `twigs ${st.twigEdges ?? '—'}  dens ×${Number(bakeState.twigDensity).toFixed(2)}  branch ×${Number(bakeState.twigBranchMult).toFixed(1)}`,
      `fork ${Number(bakeState.forkYM).toFixed(2)} m  falling ${engine.fallingPetals?.count ?? '—'}`,
      `ground petals ${engine.fallingPetals?.groundCount ?? 0}`
    ].join('\n');
  }

  updateStats();
  const timer = setInterval(updateStats, 1000);

  // Keyboard shortcuts
  const onKey = (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === '1') onPreset('beauty');
    if (e.key === '2') onPreset('skeleton');
    if (e.key === '3') onPreset('mesh');
    if (e.key === '4') onPreset('roots');
    if (e.key === '5') onPreset('full');
    if (e.key === '`') root.classList.toggle('collapsed');
    syncChecks();
  };
  window.addEventListener('keydown', onKey);

  return {
    root,
    updateStats,
    getBakeParams: () => ({ ...bakeState }),
    dispose() {
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
      root.remove();
      style.remove();
    }
  };
}
