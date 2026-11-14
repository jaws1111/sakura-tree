/**
 * Control panel (v1.2): tabbed — Tree · Foliage · Scene · Ground · Petals & wind · View / debug.
 * No external GUI dependency. Every control is registered with a key so the whole panel can be saved to / restored from
 * localStorage (Save · Reset in the View tab). Test ids: tab-<id>, size-preset-<key>, tree-apply, tree-auto, tree-cost,
 * mesher-select, time-<preset>, …
 */
import {
  SIZE_PRESETS,
  SIZE_LIMITS,
  DEFAULT_TREE_SPEC,
  normalizeTreeSpec,
  estimateCost,
  matchPreset
} from '../tree/treeSpec.js';
import { LANDSCAPE } from '../env/terrain.js';
import { SWAY_U } from '../env/sceneUniforms.js';
import { TIME_PRESETS } from '../env/atmosphere.js';
import { MOSS_U } from '../env/moss.js';
import { CINEMATIC_MODES, CINEMATIC_MODE_IDS } from './CinematicCamera.js';
import { applyRenderLook, lookCatalog, parseRenderLookId, setBlossomUserScale } from './renderLooks.js';

const STORE_KEY = 'sakura.v12.settings';

const CSS = `
#analysis-gui {
  position: fixed; top: 10px; right: 10px; z-index: 20;
  width: 318px; max-height: calc(100vh - 20px); overflow: auto;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #f3e6ea; background: rgba(18, 10, 14, 0.9);
  border: 1px solid rgba(255, 170, 190, 0.28); border-radius: 8px;
  backdrop-filter: blur(8px); user-select: none;
}
#analysis-gui.collapsed .ag-body, #analysis-gui.collapsed .ag-tabs { display: none; }
#analysis-gui .ag-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; cursor: pointer;
  border-bottom: 1px solid rgba(255,170,190,0.18);
  color: #ffb6c8; font-weight: 600; letter-spacing: 0.04em;
}
#analysis-gui .ag-tabs { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 8px 0; }
#analysis-gui .ag-tabs button[role="tab"] {
  background: transparent; color: #ffb0c4; border: 1px solid rgba(255,176,196,0.3);
  border-radius: 4px 4px 0 0; padding: 4px 7px;
}
#analysis-gui .ag-tabs button[role="tab"][aria-selected="true"] { background: #ffb0c4; color: #1a1014; font-weight: 600; }
#analysis-gui .ag-body { padding: 4px 8px 10px; }
#analysis-gui .pane { display: none; }
#analysis-gui .pane.active { display: block; }
#analysis-gui details {
  border: 1px solid rgba(255,170,190,0.12); border-radius: 6px;
  margin: 6px 0; padding: 0 6px 6px; background: rgba(255,255,255,0.02);
}
#analysis-gui summary { cursor: pointer; padding: 6px 2px; color: #ffc4d2; font-weight: 600; }
#analysis-gui h4 { margin: 10px 0 2px; color: #ffc4d2; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }
#analysis-gui label.row { display: flex; align-items: center; gap: 8px; margin: 3px 0; color: #e8d5db; }
#analysis-gui label.row span.k { flex: 1; }
#analysis-gui label.row input[type="checkbox"] { accent-color: #ff8fad; }
#analysis-gui label.row select { background: #2a1a20; color: #f3e6ea; border: 1px solid rgba(255,176,196,0.4); border-radius: 4px; padding: 2px; }
#analysis-gui label.slider { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 5px 0; color: #e8d5db; }
#analysis-gui label.slider input[type="range"] { grid-column: 1 / -1; width: 100%; accent-color: #ff8fad; }
#analysis-gui label.slider .v { color: #ffb6c8; }
#analysis-gui .btns { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
#analysis-gui button {
  font: inherit; color: #1a1014; background: #ffb0c4; border: 0; border-radius: 4px;
  padding: 4px 7px; cursor: pointer;
}
#analysis-gui button.ghost { background: transparent; color: #ffb0c4; border: 1px solid rgba(255,176,196,0.45); }
#analysis-gui button.on { background: #ffb0c4; color: #1a1014; }
#analysis-gui button:hover { filter: brightness(1.08); }
#analysis-gui .stats { margin-top: 6px; padding: 6px; border-radius: 4px; background: rgba(0,0,0,0.28); color: #d8c4cc; white-space: pre-wrap; }
#analysis-gui .hint { color: #a89098; font-size: 10px; margin-top: 4px; }
#analysis-gui .cost { margin-top: 2px; padding: 4px 6px; border-radius: 4px; background: rgba(0,0,0,0.28); color: #d8c4cc; }
#analysis-gui .cost.mid { color: #ffd98a; }
#analysis-gui .cost.high { color: #ff9a8a; }
#analysis-gui input.color { width: 42px; height: 22px; padding: 0; border: 1px solid rgba(255,176,196,0.45); background: transparent; cursor: pointer; }
`;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function colorToHex(c) {
  if (!c) return '#ff8fbc';
  if (typeof c === 'string') return c.startsWith('#') ? c : `#${c}`;
  if (c.isColor || (c.r != null && c.g != null && c.b != null)) {
    return `#${c.getHexString?.() ?? ((Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255)).toString(16).padStart(6, '0')}`;
  }
  return '#ff8fbc';
}

/**
 * @param {object} opts
 * @param {import('./DebugOverlay.js').DebugOverlay} opts.overlay
 * @param {import('../engine/ProceduralSakuraEngine.js').ProceduralSakuraEngine} opts.engine
 * @param {object} opts.refs { cal, human }
 * @param {import('three').WebGLRenderer} opts.renderer
 * @param {{ rebuildTree: Function, camera: (n: string) => void, preset: (n: string) => void, getStats: () => object }} opts.actions
 */
export function mountAnalysisGui(opts) {
  const { overlay, engine, refs, actions, sceneComposer } = opts;
  if (document.querySelector('#analysis-gui')) return null;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el(`
    <div id="analysis-gui" data-testid="control-panel">
      <div class="ag-head"><span>SAKURA · CONTROLS</span><span class="tog">▾</span></div>
      <div class="ag-tabs" role="tablist"></div>
      <div class="ag-body"></div>
    </div>
  `);
  document.body.appendChild(root);
  const tabsBar = root.querySelector('.ag-tabs');
  const body = root.querySelector('.ag-body');
  root.querySelector('.ag-head').addEventListener('click', () => {
    root.classList.toggle('collapsed');
    root.querySelector('.tog').textContent = root.classList.contains('collapsed') ? '▸' : '▾';
  });

  // ───────────────────────── tiny widget kit ─────────────────────────
  /** key → { get(): any, set(v: any): void } — for save / load */
  const registry = new Map();
  let loading = false;

  const panes = {};
  function addTab(id, label) {
    const b = el(`<button type="button" role="tab" aria-selected="false" data-testid="tab-${id}"></button>`);
    b.textContent = label;
    const pane = el(`<div class="pane" role="tabpanel" data-testid="pane-${id}"></div>`);
    b.addEventListener('click', () => selectTab(id));
    tabsBar.appendChild(b);
    body.appendChild(pane);
    panes[id] = { button: b, pane };
    return pane;
  }
  function selectTab(id) {
    for (const [k, p] of Object.entries(panes)) {
      const on = k === id;
      p.button.setAttribute('aria-selected', on ? 'true' : 'false');
      p.pane.classList.toggle('active', on);
    }
  }

  function heading(parent, text) {
    const h = el('<h4></h4>');
    h.textContent = text;
    parent.appendChild(h);
  }
  function hint(parent, text) {
    const p = el('<p class="hint"></p>');
    p.textContent = text;
    parent.appendChild(p);
  }
  function buttons(parent, defs) {
    const box = el('<div class="btns"></div>');
    for (const d of defs) {
      const b = el(`<button type="button" class="${d.ghost ? 'ghost' : ''}"></button>`);
      b.textContent = d.label;
      if (d.testid) b.setAttribute('data-testid', d.testid);
      b.addEventListener('click', () => d.onClick(b));
      box.appendChild(b);
    }
    parent.appendChild(box);
    return box;
  }

  /**
   * @param {HTMLElement} parent
   * @param {{key:string,label:string,min:number,max:number,step:number,value:number,digits?:number,live?:boolean,apply:(v:number)=>void,testid?:string}} d
   * live = apply while dragging; otherwise on release.
   */
  function slider(parent, d) {
    const digits = d.digits ?? (d.step >= 1 ? 0 : d.step >= 0.1 ? 1 : 2);
    const row = el(`<label class="slider"><span class="k"></span><span class="v"></span><input type="range"/></label>`);
    row.querySelector('.k').textContent = d.label;
    const input = row.querySelector('input');
    const val = row.querySelector('.v');
    input.min = String(d.min);
    input.max = String(d.max);
    input.step = String(d.step);
    input.value = String(d.value);
    if (d.testid) input.setAttribute('data-testid', d.testid);
    input.setAttribute('aria-label', d.label);
    const show = () => {
      val.textContent = Number(input.value).toFixed(digits);
    };
    show();
    input.addEventListener('input', () => {
      show();
      if (d.live !== false) d.apply(Number(input.value));
    });
    input.addEventListener('change', () => {
      if (d.live === false) d.apply(Number(input.value));
    });
    const ctl = {
      row,
      input,
      get: () => Number(input.value),
      set: (v, apply = true) => {
        input.value = String(v);
        show();
        if (apply) d.apply(Number(input.value));
      },
      /** update the display without invoking apply */
      sync: (v) => {
        input.value = String(v);
        show();
      }
    };
    registry.set(d.key, ctl);
    parent.appendChild(row);
    return ctl;
  }

  function checkbox(parent, d) {
    const row = el(`<label class="row"><span class="k"></span><input type="checkbox"/></label>`);
    row.querySelector('.k').textContent = d.label;
    const input = row.querySelector('input');
    input.checked = Boolean(d.value);
    if (d.testid) input.setAttribute('data-testid', d.testid);
    input.setAttribute('aria-label', d.label);
    input.addEventListener('change', () => d.apply(input.checked));
    const ctl = {
      row,
      input,
      get: () => input.checked,
      set: (v, apply = true) => {
        input.checked = Boolean(v);
        if (apply) d.apply(input.checked);
      }
    };
    if (d.key) registry.set(d.key, ctl);
    parent.appendChild(row);
    return ctl;
  }

  function colorPicker(parent, d) {
    const row = el(`<label class="row"><span class="k"></span><input type="color" class="color"/></label>`);
    row.querySelector('.k').textContent = d.label;
    const input = row.querySelector('input');
    input.value = d.value;
    input.setAttribute('aria-label', d.label);
    input.addEventListener('input', () => d.apply(input.value));
    registry.set(d.key, {
      get: () => input.value,
      set: (v, apply = true) => {
        input.value = v;
        if (apply) d.apply(v);
      }
    });
    parent.appendChild(row);
  }

  // ───────────────────────── TREE ─────────────────────────
  const treePane = addTab('tree', 'Tree');
  const treeUi = { ...engine.treeSpec };
  const extrasUi = { ...engine.bakeExtras };
  let treeDirty = false;
  let autoApply = true;
  let rebuildTimer = null;
  const sizeBtns = new Map();
  const costEl = el('<div class="cost" data-testid="tree-cost"></div>');

  function refreshTreeUi() {
    const spec = normalizeTreeSpec(treeUi);
    const est = estimateCost(spec);
    costEl.textContent = `${spec.heightM.toFixed(1)} m tall · crown ⌀ ${(spec.crownRadiusM * 2).toFixed(1)} m · ~${est.estNodes.toLocaleString()} wood nodes · ${est.costLabel}${treeDirty ? ' · pending' : ''}`;
    costEl.className = `cost ${est.costClass}`;
    const m = matchPreset(spec);
    for (const [k, b] of sizeBtns) b.classList.toggle('on', k === m);
  }
  function commitTree() {
    clearTimeout(rebuildTimer);
    treeDirty = false;
    refreshTreeUi();
    actions.rebuildTree({ patch: normalizeTreeSpec(treeUi), extras: { ...extrasUi } });
  }
  function markTree() {
    treeDirty = true;
    refreshTreeUi();
    if (loading) return;
    if (autoApply) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(commitTree, 450);
    }
  }

  heading(treePane, 'Size');
  const presetBox = buttons(
    treePane,
    Object.entries(SIZE_PRESETS).map(([key, p]) => ({
      label: p.label,
      ghost: true,
      testid: `size-preset-${key}`,
      onClick: () => {
        Object.assign(treeUi, normalizeTreeSpec({ ...treeUi, heightM: p.heightM, crownRadiusM: p.crownRadiusM, forkYM: p.forkYM }));
        for (const k of ['heightM', 'crownRadiusM', 'forkYM']) registry.get(k)?.sync(treeUi[k]);
        markTree();
      }
    }))
  );
  [...presetBox.children].forEach((b, i) => sizeBtns.set(Object.keys(SIZE_PRESETS)[i], b));

  const treeSlider = (key, label, [min, max], step, testid) =>
    slider(treePane, {
      key,
      label,
      min,
      max,
      step,
      value: treeUi[key],
      testid,
      live: false,
      apply: (v) => {
        treeUi[key] = v;
        const norm = normalizeTreeSpec(treeUi);
        // keep the fork below the crown top
        if (key !== 'forkYM' && Math.abs(norm.forkYM - treeUi.forkYM) > 1e-6) {
          treeUi.forkYM = norm.forkYM;
          registry.get('forkYM')?.sync(norm.forkYM);
        }
        markTree();
      }
    });
  treeSlider('heightM', 'Tree height (m)', SIZE_LIMITS.heightM, 0.1, 'tree-height');
  treeSlider('crownRadiusM', 'Crown radius (m)', SIZE_LIMITS.crownRadiusM, 0.1, 'tree-crown');
  treeSlider('forkYM', 'Trunk height / first fork (m)', [0.3, 8], 0.05, 'tree-fork');
  treeSlider('complexity', 'Complexity (branches & twigs)', SIZE_LIMITS.complexity, 0.05, 'tree-complexity');
  treePane.appendChild(costEl);
  checkbox(treePane, {
    key: 'treeAuto',
    label: 'Re-grow automatically',
    value: autoApply,
    testid: 'tree-auto',
    apply: (v) => {
      autoApply = v;
    }
  });

  heading(treePane, 'Variety');
  slider(treePane, {
    key: 'seed',
    label: 'Seed',
    min: 1,
    max: 999,
    step: 1,
    value: extrasUi.seed,
    live: false,
    apply: (v) => {
      extrasUi.seed = v;
      markTree();
    }
  });
  slider(treePane, {
    key: 'twigBranchMult',
    label: 'Small-branch forking ×',
    min: 0.5,
    max: 4,
    step: 0.1,
    value: extrasUi.twigBranchMult,
    live: false,
    apply: (v) => {
      extrasUi.twigBranchMult = v;
      markTree();
    }
  });
  slider(treePane, {
    key: 'rootEmergence',
    label: 'Surface roots / nebari',
    min: 0,
    max: 1,
    step: 0.05,
    value: extrasUi.rootEmergence ?? 0.35,
    live: false,
    testid: 'root-emergence',
    apply: (v) => {
      extrasUi.rootEmergence = v;
      markTree();
    }
  });
  hint(treePane, '0 = roots stay underground. Raise to lift buttress / surface laterals above the soil.');
  buttons(treePane, [
    {
      label: 'New seed',
      ghost: true,
      testid: 'tree-new-seed',
      onClick: () => registry.get('seed').set(1 + Math.floor(Math.random() * 998))
    },
    { label: 'Rebuild now', testid: 'tree-apply', onClick: commitTree }
  ]);

  heading(treePane, 'Grove');
  hint(
    treePane,
    'Global: size, mesher, blossoms and falling petals apply to every tree. Only seeds differ. Each tree has its own petal shower.'
  );
  slider(treePane, {
    key: 'groveCount',
    label: 'Companion trees',
    min: 0,
    max: 3,
    step: 1,
    value: engine.groveCount ?? 0,
    testid: 'grove-count',
    live: false,
    apply: (v) => {
      if (loading) return;
      engine.setGroveCount(v).then(() => updateStats());
    }
  });
  buttons(treePane, [
    {
      label: 'Reseed grove',
      ghost: true,
      testid: 'grove-reseed',
      onClick: () => {
        if (loading) return;
        engine.reseedGrove().then(() => updateStats());
      }
    }
  ]);

  heading(treePane, 'Mesher');
  const mesherRow = el(
    `<label class="row"><span class="k">Bark mesher</span><select data-testid="mesher-select">` +
      `<option value="hybrid">v1.1 hybrid (surface nets + tubes)</option>` +
      `<option value="mc">v1.0 marching cubes + proxies</option></select></label>`
  );
  const mesherSel = mesherRow.querySelector('select');
  mesherSel.value = extrasUi.mesher;
  mesherSel.addEventListener('change', () => {
    extrasUi.mesher = mesherSel.value;
    markTree();
  });
  registry.set('mesher', {
    get: () => mesherSel.value,
    set: (v, apply = true) => {
      mesherSel.value = v;
      extrasUi.mesher = v;
      if (apply) markTree();
    }
  });
  treePane.appendChild(mesherRow);
  slider(treePane, {
    key: 'voxelScale',
    label: 'Mesh coarseness × (lower = finer)',
    min: 0.6,
    max: 2.2,
    step: 0.05,
    value: extrasUi.voxelScale,
    live: false,
    apply: (v) => {
      extrasUi.voxelScale = v;
      markTree();
    }
  });
  hint(
    treePane,
    'Size changes re-fit the whole scene (sway, shadows, moss ring, petals). Complexity scales crown attractors; rebuild cost grows roughly linearly with it.'
  );
  refreshTreeUi();

  // ───────────────────────── FOLIAGE ─────────────────────────
  const foliagePane = addTab('foliage', 'Foliage');
  heading(foliagePane, 'Blossoms · all trees');
  hint(
    foliagePane,
    'Canopy LOD: near + far blossom meshes with screen-space cull. Falling petals use distance LOD (not meshopt — petals are already 1–2 quads).'
  );
  const canopy = engine.canopy;
  const mat = canopy?.material;
  const countCtl = slider(foliagePane, {
    key: 'canopyCount',
    label: 'Blossoms (canopy)',
    min: 100,
    max: 2_000_000,
    step: 500,
    value: canopy?.count ?? 12000,
    live: false,
    apply: (v) => {
      engine.setGlobalCanopyCount?.(v);
      updateStats();
    }
  });
  void countCtl;
  slider(foliagePane, {
    key: 'blossomSize',
    label: 'Blossom size',
    min: 0.25,
    max: 3,
    step: 0.05,
    value: canopy?.sizeScale ?? 1,
    live: false,
    apply: (v) => engine.setGlobalBlossomSize?.(v)
  });
  slider(foliagePane, {
    key: 'peduncle',
    label: 'Peduncle (attach twig) ×',
    min: 0.15,
    max: 3.5,
    step: 0.05,
    value: canopy?.peduncleScale ?? 1,
    live: false,
    apply: (v) => engine.setGlobalPeduncleScale?.(v)
  });

  const renderState = {
    castShadow: canopy?.castShadow !== false,
    receiveShadow: canopy?.receiveShadow !== false,
    primaryColor: colorToHex(mat?.userData?.uniforms?.uColorPrimary?.value ?? mat?.color),
    centerColor: colorToHex(mat?.userData?.uniforms?.uColorCenter?.value ?? mat?.userData?.uniforms?.uPetalCore?.value),
    emissiveIntensity: mat?.emissiveIntensity ?? 0,
    edgeFade: Math.min(1, Math.max(0, ((mat?.userData?.uniforms?.uEdgeFade?.value ?? 0.045) - 0.01) / 0.11)),
    opacity: mat?.opacity ?? 1
  };
  const pushRender = () => engine.applyCanopyRenderOptions?.(renderState);
  heading(foliagePane, 'Blossom look');
  colorPicker(foliagePane, {
    key: 'primaryColor',
    label: 'Primary colour',
    value: renderState.primaryColor,
    apply: (v) => {
      renderState.primaryColor = v;
      pushRender();
    }
  });
  colorPicker(foliagePane, {
    key: 'centerColor',
    label: 'Centre colour',
    value: renderState.centerColor,
    apply: (v) => {
      renderState.centerColor = v;
      pushRender();
    }
  });
  checkbox(foliagePane, {
    key: 'castShadow',
    label: 'Blossoms cast shadow',
    value: renderState.castShadow,
    apply: (v) => {
      renderState.castShadow = v;
      pushRender();
    }
  });
  checkbox(foliagePane, {
    key: 'receiveShadow',
    label: 'Blossoms receive shadow',
    value: renderState.receiveShadow,
    apply: (v) => {
      renderState.receiveShadow = v;
      pushRender();
    }
  });
  for (const [key, label, min, max, step] of [
    ['emissiveIntensity', 'Emissive', 0, 1.2, 0.01],
    ['edgeFade', 'Edge fade', 0, 1, 0.01],
    ['opacity', 'Opacity', 0.2, 1, 0.01]
  ]) {
    slider(foliagePane, {
      key,
      label,
      min,
      max,
      step,
      value: renderState[key],
      apply: (v) => {
        renderState[key] = v;
        pushRender();
      }
    });
  }
  slider(foliagePane, {
    key: 'blossomBright',
    label: 'Bright ×',
    min: 0,
    max: 2,
    step: 0.01,
    value: 1,
    apply: (v) => setBlossomUserScale({ bright: v })
  });
  slider(foliagePane, {
    key: 'blossomAo',
    label: 'Blossom AO ×',
    min: 0,
    max: 2,
    step: 0.01,
    value: 1,
    apply: (v) => setBlossomUserScale({ ao: v })
  });
  slider(foliagePane, {
    key: 'blossomRough',
    label: 'Roughness ×',
    min: 0,
    max: 2,
    step: 0.01,
    value: 1,
    apply: (v) => setBlossomUserScale({ rough: v })
  });

  // ───────────────────────── SCENE (time of day, sky) ─────────────────────────
  const scenePane = addTab('scene', 'Scene');
  const atmos = engine.atmosphere;
  heading(scenePane, 'Time of day');
  const clockEl = el('<div class="cost" data-testid="clock-label"></div>');
  const timeBtns = new Map();
  const timeBox = buttons(
    scenePane,
    [
      ['sunrise', 'Sunrise'],
      ['day', 'Day'],
      ['sunset', 'Sunset'],
      ['night', 'Night']
    ].map(([id, label]) => ({
      label,
      ghost: true,
      testid: `time-${id}`,
      onClick: () => registry.get('hours').set(TIME_PRESETS[id])
    }))
  );
  [...timeBox.children].forEach((b, i) => timeBtns.set(['sunrise', 'day', 'sunset', 'night'][i], b));
  const syncClock = () => {
    if (!atmos) return;
    clockEl.textContent = `${atmos.clockLabel} · ${atmos.periodLabel}${atmos.keyLight === 'moon' ? ' · moonlight' : ''}`;
    for (const [id, b] of timeBtns) b.classList.toggle('on', atmos.periodLabel === id);
  };
  const hoursCtl = slider(scenePane, {
    key: 'hours',
    label: 'Clock (h)',
    min: 0,
    max: 24,
    step: 0.05,
    value: atmos?.hours ?? 13,
    testid: 'time-slider',
    apply: (v) => {
      atmos?.setTime(v);
      syncClock();
    }
  });
  scenePane.appendChild(clockEl);
  checkbox(scenePane, {
    key: 'autoCycle',
    label: 'Animate the day',
    value: atmos?.autoCycle ?? false,
    testid: 'time-animate',
    apply: (v) => {
      if (atmos) atmos.autoCycle = v;
    }
  });
  slider(scenePane, {
    key: 'cycleSeconds',
    label: 'Day length (s)',
    min: 20,
    max: 600,
    step: 10,
    value: atmos?.cycleSeconds ?? 120,
    apply: (v) => {
      if (atmos) atmos.cycleSeconds = v;
    }
  });
  heading(scenePane, 'Sky & light');
  const atmosSlider = (key, label, min, max, step, prop) =>
    slider(scenePane, {
      key,
      label,
      min,
      max,
      step,
      value: atmos?.[prop] ?? 1,
      apply: (v) => {
        if (!atmos) return;
        atmos[prop] = v;
        atmos.refresh();
      }
    });
  atmosSlider('azimuthDeg', 'Sun path rotation (°)', -180, 180, 1, 'azimuthDeg');
  atmosSlider('cloudCover', 'Cloud cover', 0, 1, 0.01, 'cloudCover');
  atmosSlider('cloudSpeed', 'Cloud speed ×', 0, 6, 0.1, 'cloudSpeed');
  atmosSlider('hazeScale', 'Haze ×', 0, 3, 0.05, 'hazeScale');
  atmosSlider('starScale', 'Stars ×', 0, 2, 0.05, 'starScale');
  atmosSlider('exposureBias', 'Exposure ×', 0.5, 1.8, 0.01, 'exposureBias');
  atmosSlider('sunLightScale', 'Sun light ×', 0, 2, 0.05, 'sunLightScale');
  atmosSlider('hemiScale', 'Sky fill light ×', 0, 2, 0.05, 'hemiScale');
  atmosSlider('moonLightScale', 'Moon light ×', 0, 2, 0.05, 'moonLightScale');
  syncClock();

  // ───────────────────────── GROUND ─────────────────────────
  const groundPane = addTab('ground', 'Ground');
  heading(groundPane, 'Landscape');
  const compassDeg = ((LANDSCAPE.mountainAzimuth + Math.PI / 2) * 180) / Math.PI;
  const landscapeState = {
    meadowScale: LANDSCAPE.meadowScale,
    hillScale: LANDSCAPE.hillScale,
    mountainScale: LANDSCAPE.mountainScale,
    riverScale: LANDSCAPE.riverScale ?? 1,
    range: compassDeg
  };
  const pushLandscape = () =>
    engine.setLandscapeParams({
      meadowScale: landscapeState.meadowScale,
      hillScale: landscapeState.hillScale,
      mountainScale: landscapeState.mountainScale,
      riverScale: landscapeState.riverScale,
      mountainAzimuth: -Math.PI / 2 + (landscapeState.range * Math.PI) / 180
    });
  for (const [key, label, min, max, step] of [
    ['meadowScale', 'Summit texture', 0, 2.5, 0.05],
    ['hillScale', 'Valley depth ×', 0, 2.5, 0.05],
    ['mountainScale', 'Mountains height ×', 0, 2, 0.05],
    ['riverScale', 'Creek depth ×', 0, 1.5, 0.05],
    ['range', 'Mountain range direction (°)', -180, 180, 5]
  ]) {
    slider(groundPane, {
      key,
      label,
      min,
      max,
      step,
      value: landscapeState[key],
      live: false,
      apply: (v) => {
        landscapeState[key] = v;
        if (!loading) pushLandscape();
      }
    });
  }
  hint(
    groundPane,
    'φ / zen plan: sandō gravel → torii → hero clearing → creek ford; sakura alley + knolls. 0° = mountains behind the hero view.'
  );

  heading(groundPane, 'Ground shader');
  const tu = engine.terrain?.uniforms;
  const uniformSlider = (key, label, min, max, step, uname, def) =>
    slider(groundPane, {
      key,
      label,
      min,
      max,
      step,
      value: tu?.[uname]?.value ?? def,
      apply: (v) => {
        if (tu?.[uname]) tu[uname].value = v;
      }
    });
  uniformSlider('bumpAmt', 'Bump strength', 0, 1.6, 0.02, 'uBumpAmt', 0.5);
  uniformSlider('detailTile', 'Texture tiling ×', 0.5, 2.5, 0.05, 'uDetailTile', 1);
  uniformSlider('wet', 'Wetness', 0, 1, 0.02, 'uWet', 0);
  uniformSlider('flowers', 'Wild flowers', 0, 1.6, 0.05, 'uFlowerAmt', 1.05);

  heading(groundPane, 'Grass');
  slider(groundPane, {
    key: 'grassCount',
    label: 'Grass density (tufts)',
    min: 2000,
    max: 60000,
    step: 1000,
    value: engine.budget?.config?.grassCount ?? 36000,
    live: false,
    apply: (v) => {
      engine.grass?.setCount(v);
      if (engine.budget?.config) engine.budget.config.grassCount = v;
    }
  });
  slider(groundPane, {
    key: 'grassHeight',
    label: 'Grass height ×',
    min: 0.3,
    max: 3,
    step: 0.05,
    value: 1,
    apply: (v) => engine.grass?.setHeightScale(v)
  });
  slider(groundPane, {
    key: 'grassWind',
    label: 'Grass wind motion',
    min: 0,
    max: 3,
    step: 0.05,
    value: 1,
    apply: (v) => engine.grass?.setWindAmount(v)
  });

  heading(groundPane, 'Moss');
  slider(groundPane, {
    key: 'groundMoss',
    label: 'Ground moss coverage',
    min: 0,
    max: 1.6,
    step: 0.05,
    value: engine.ecology?.groundMoss ?? 1,
    live: false,
    testid: 'moss-ground',
    apply: (v) => engine.setGroundMoss(v)
  });
  slider(groundPane, {
    key: 'barkMoss',
    label: 'Bark moss coverage',
    min: 0,
    max: 1.2,
    step: 0.05,
    value: engine.ecology?.barkMoss ?? 0.8,
    live: false,
    testid: 'moss-bark',
    apply: (v) => engine.setBarkMoss({ coverage: v })
  });
  slider(groundPane, {
    key: 'barkMossThickness',
    label: 'Bark moss thickness (m)',
    min: 0.002,
    max: 0.03,
    step: 0.001,
    value: engine.ecology?.barkMossThickness ?? 0.011,
    digits: 3,
    apply: (v) => engine.setBarkMoss({ thickness: v })
  });
  slider(groundPane, {
    key: 'mossLush',
    label: 'Moss: dry ↔ lush',
    min: 0,
    max: 1,
    step: 0.02,
    value: MOSS_U.uMossLush.value,
    apply: (v) => {
      MOSS_U.uMossLush.value = v;
    }
  });
  slider(groundPane, {
    key: 'mossBump',
    label: 'Moss bump',
    min: 0,
    max: 2.5,
    step: 0.05,
    value: MOSS_U.uMossBump.value,
    apply: (v) => {
      MOSS_U.uMossBump.value = v;
    }
  });

  // ───────────────────────── PETALS & WIND ─────────────────────────
  const petalPane = addTab('petals', 'Petals & wind');
  const fall = engine.fallingPetals;
  heading(petalPane, 'Falling petals · all trees');
  hint(
    petalPane,
    'Every tree has its own shower. Knobs are global. LOD: canopy dual-mesh + screen cull; falling petals cull past ~58 m (meshopt InstancedMesh2 is for heavy meshes — petals stay impostors).'
  );
  checkbox(petalPane, {
    key: 'showerOn',
    label: 'Shower running',
    value: fall?.enabled ?? true,
    testid: 'petal-enabled',
    apply: (v) => engine.applyPetalSettings?.({ enabled: v })
  });
  slider(petalPane, {
    key: 'fallingPetalCount',
    label: 'Petal pool cap (grove total)',
    min: 200,
    max: 48_000,
    step: 100,
    value: engine.petalPoolTotal ?? fall?.count ?? 8000,
    live: false,
    testid: 'petal-cap',
    apply: (v) => {
      engine.setGlobalPetalCount?.(v);
      updateStats();
    }
  });
  hint(
    petalPane,
    'Total pool across hero + companions (hero ~55%). Emission pauses when free slots run out.'
  );
  const petalSlider = (key, label, min, max, step, prop, testid) =>
    slider(petalPane, {
      key,
      label,
      min,
      max,
      step,
      value: fall?.[prop] ?? 1,
      testid,
      apply: (v) => engine.applyPetalSettings?.({ [prop]: v })
    });
  petalSlider('emissionRate', 'Petals released per second', 0, 150, 1, 'emissionRate', 'petal-rate');
  petalSlider('fallScale', 'Fall speed ×', 0.4, 2.5, 0.05, 'fallScale');
  petalSlider('windGain', 'Wind carry ×', 0, 3, 0.05, 'windGain');
  petalSlider('flutter', 'Flutter ×', 0, 3, 0.05, 'flutter');
  petalSlider('swirl', 'Curl swirl ×', 0, 3, 0.05, 'swirl');
  petalSlider('turbulence', 'Individual turbulence ×', 0, 3, 0.05, 'turbulence', 'petal-turbulence');
  petalSlider('groundLifeMin', 'Min time on the ground (s)', 30, 600, 5, 'groundLifeMin');
  petalSlider('groundLifeMax', 'Max time on the ground (s)', 60, 1800, 10, 'groundLifeMax');
  buttons(petalPane, [
    {
      label: 'Clear fallen petals',
      ghost: true,
      testid: 'petal-clear',
      onClick: () => {
        for (const f of engine.petalSystems?.() ?? [fall]) {
          f?.reseed?.({ clearGround: true });
          f?.prewarm?.(Math.min(f.count * 0.5, f.emissionRate * 8));
        }
        updateStats();
      }
    },
    {
      label: 'Burst',
      ghost: true,
      testid: 'petal-burst',
      onClick: () => {
        for (const f of engine.petalSystems?.() ?? [fall]) {
          f?.prewarm?.(Math.min(f.count * 0.35, 700));
        }
        updateStats();
      }
    }
  ]);
  const petalStatEl = el('<div class="stats" data-testid="petal-stats">—</div>');
  petalPane.appendChild(petalStatEl);
  heading(petalPane, 'Wind');
  slider(petalPane, {
    key: 'swayAmp',
    label: 'Tree sway ×',
    min: 0,
    max: 3,
    step: 0.05,
    value: SWAY_U.uSwayAmp.value,
    testid: 'sway-amount',
    apply: (v) => {
      SWAY_U.uSwayAmp.value = v;
    }
  });
  hint(petalPane, 'Trunk lean, limb oscillation and blossom motion share one wind field with grass and petals. 0 = still air for the tree.');

  // ───────────────────────── LAYOUT (scene plan) ─────────────────────────
  const layoutPane = addTab('layout', 'Layout');
  const composer = sceneComposer || engine.sceneComposer;
  heading(layoutPane, 'View');
  const viewModeBtns = new Map();
  const viewBox = buttons(layoutPane, [
    {
      label: '3D free',
      ghost: true,
      testid: 'view-free3d',
      onClick: () => {
        composer?.setMode?.('free3d');
        actions.camera?.('hero');
        for (const [id, b] of viewModeBtns) b.classList.toggle('on', id === 'free3d');
      }
    },
    {
      label: 'Top-down plan',
      ghost: true,
      testid: 'view-topdown',
      onClick: () => {
        composer?.setMode?.('topdown');
        for (const [id, b] of viewModeBtns) b.classList.toggle('on', id === 'topdown');
      }
    }
  ]);
  viewModeBtns.set('free3d', viewBox.children[0]);
  viewModeBtns.set('topdown', viewBox.children[1]);
  viewBox.children[0].classList.add('on');
  hint(
    layoutPane,
    'Top-down: click pink control points or props, then drag with the gizmo to reshape bezier river / paths and placements.'
  );

  heading(layoutPane, 'Scene presets');
  buttons(
    layoutPane,
    (composer?.presets || []).map((p) => ({
      label: p.name,
      ghost: true,
      testid: `scene-preset-${p.id}`,
      onClick: async () => {
        if (!composer) return;
        await composer.loadPreset(p.id);
        engine.syncShadows?.();
        updateStats();
      }
    }))
  );

  heading(layoutPane, 'Save / load scene');
  const sceneMsg = el('<p class="hint" data-testid="scene-msg"></p>');
  buttons(layoutPane, [
    {
      label: 'Save scene (browser)',
      testid: 'scene-save',
      onClick: () => {
        composer?.saveToLocalStorage?.();
        sceneMsg.textContent = 'Scene saved in this browser.';
      }
    },
    {
      label: 'Load scene (browser)',
      ghost: true,
      testid: 'scene-load',
      onClick: async () => {
        const d = composer?.loadFromLocalStorage?.();
        if (!d) {
          sceneMsg.textContent = 'No saved scene yet.';
          return;
        }
        await composer.applyDocument(d);
        sceneMsg.textContent = `Loaded “${d.name || 'scene'}”.`;
        updateStats();
      }
    },
    {
      label: 'Export JSON',
      ghost: true,
      testid: 'scene-export',
      onClick: () => {
        composer?.downloadJSON?.();
        sceneMsg.textContent = 'Downloaded sakura-scene.json.';
      }
    },
    {
      label: 'Import JSON…',
      ghost: true,
      testid: 'scene-import',
      onClick: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const text = await file.text();
            await composer.loadJSONText(text);
            sceneMsg.textContent = `Imported ${file.name}.`;
            updateStats();
          } catch (err) {
            sceneMsg.textContent = `Import failed: ${err?.message || err}`;
          }
        };
        input.click();
      }
    }
  ]);
  layoutPane.appendChild(sceneMsg);
  hint(
    layoutPane,
    'JSON stores bezier control points, path widths, prop transforms, and grove count. Tree seed stays in Tree tab.'
  );

  // ───────────────────────── VIEW / DEBUG ─────────────────────────
  const viewPane = addTab('view', 'View');
  const s = overlay.state;
  const refreshLayers = () => overlay.apply(engine, refs);
  heading(viewPane, 'Camera');
  buttons(
    viewPane,
    [
      ['hero', 'Hero'],
      ['horizon', 'Horizon'],
      ['under', 'Under crown'],
      ['trunk', 'Trunk'],
      ['roots', 'Roots'],
      ['top', 'Top'],
      ['wire', 'Close mesh']
    ].map(([id, label]) => ({
      label,
      ghost: true,
      testid: `cam-${id}`,
      onClick: () => {
        composer?.setMode?.('free3d');
        for (const [vid, b] of viewModeBtns) b.classList.toggle('on', vid === 'free3d');
        actions.camera(id);
      }
    }))
  );

  heading(viewPane, 'Cinematic');
  const cinema = actions.cinema;
  const cineHint = el('<p class="hint" data-testid="cine-hint"></p>');
  const cineModeBtns = new Map();
  const cineEnable = checkbox(viewPane, {
    key: 'cineEnabled',
    label: 'Cinematic mode',
    testid: 'cine-enabled',
    value: Boolean(cinema?.enabled),
    apply: (v) => {
      cinema?.setEnabled(v);
      syncCinema();
    }
  });
  const cineBtnRow = buttons(
    viewPane,
    CINEMATIC_MODE_IDS.map((id) => ({
      label: CINEMATIC_MODES[id].label,
      ghost: true,
      testid: `cine-mode-${id}`,
      onClick: () => {
        if (!cinema) return;
        cinema.setEnabled(true);
        cinema.setMode(id);
        cineEnable.input.checked = true;
        syncCinema();
      }
    }))
  );
  [...cineBtnRow.children].forEach((b, i) => cineModeBtns.set(CINEMATIC_MODE_IDS[i], b));
  viewPane.appendChild(cineHint);
  slider(viewPane, {
    key: 'cineSpeed',
    label: 'Cine speed ×',
    min: 0.25,
    max: 2.5,
    step: 0.05,
    value: cinema?.speed ?? 1,
    testid: 'cine-speed',
    format: (v) => v.toFixed(2),
    apply: (v) => cinema?.setSpeed(v)
  });
  hint(viewPane, '[C] toggle · [ ] [ ] cycle moods. Orbit is locked while cinematic is on.');

  heading(viewPane, 'Render look');
  const lookCatalogItems = lookCatalog();
  let renderLookId = 'photoreal';
  const lookButtons = new Map();
  function syncLookButtons() {
    for (const [id, button] of lookButtons) button.classList.toggle('on', id === renderLookId);
  }
  const lookBox = buttons(
    viewPane,
    lookCatalogItems.map((item) => ({
      label: item.label,
      ghost: true,
      testid: `look-${item.id}`,
      onClick: () => registry.get('renderLook').set(item.id)
    }))
  );
  lookCatalogItems.forEach((item, index) => lookButtons.set(item.id, lookBox.children[index]));
  registry.set('renderLook', {
    get: () => renderLookId,
    set(value, apply = true) {
      const id = parseRenderLookId(value);
      if (!id) return;
      if (apply) applyRenderLook(id);
      renderLookId = id;
      syncLookButtons();
    }
  });
  syncLookButtons();
  hint(viewPane, 'Photorealistic leaves the grade off. Anime-Ghibli grades the frame after the sun shafts.');

  heading(viewPane, 'Post FX');
  const fx = actions.postFX;
  checkbox(viewPane, {
    key: 'postFxEnabled',
    label: 'Bloom / god rays / SMAA',
    testid: 'postfx-enabled',
    value: fx ? fx.enabled : true,
    apply: (v) => fx?.setEnabled(v)
  });
  slider(viewPane, {
    key: 'postFxBloom',
    label: 'Gentle bloom ×',
    min: 0,
    max: 2,
    step: 0.05,
    value: 1,
    testid: 'postfx-bloom',
    format: (v) => v.toFixed(2),
    apply: (v) => fx?.setBloom(v)
  });
  slider(viewPane, {
    key: 'postFxRays',
    label: 'God rays ×',
    min: 0,
    max: 2,
    step: 0.05,
    value: 1,
    testid: 'postfx-rays',
    format: (v) => v.toFixed(2),
    apply: (v) => fx?.setGodrays(v)
  });
  hint(viewPane, 'Bloom is soft; shafts peak at sunrise/sunset. SMAA restores edges after the composer.');

  function syncCinema() {
    if (!cinema) return;
    cineEnable.input.checked = cinema.enabled;
    const snap = cinema.snapshot();
    const meta = CINEMATIC_MODES[snap.mode];
    cineHint.textContent = cinema.enabled
      ? `${meta?.label ?? snap.mode}${snap.shot && snap.shot !== snap.mode ? ` → ${CINEMATIC_MODES[snap.shot]?.label ?? snap.shot}` : ''} · FOV ${snap.fov.toFixed(0)}° — ${meta?.hint ?? ''}`
      : 'Off — free orbit. Pick a mood for scripted angles / FOV / pace.';
    for (const [id, b] of cineModeBtns) {
      b.classList.toggle('on', cinema.enabled && snap.mode === id);
    }
  }
  syncCinema();

  heading(viewPane, 'Analysis presets');
  buttons(
    viewPane,
    [
      ['beauty', 'Beauty'],
      ['skeleton', 'Skeleton'],
      ['mesh', 'Mesh QC'],
      ['roots', 'Roots'],
      ['full', 'Full debug']
    ].map(([id, label]) => ({
      label,
      ghost: true,
      onClick: () => {
        actions.preset(id);
        syncChecks();
        updateStats();
      }
    }))
  );
  heading(viewPane, 'Layers');
  const checkMap = new Map();
  for (const [key, label] of [
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
    ['calRefs', '1 m cube / human']
  ]) {
    const c = checkbox(viewPane, {
      label,
      value: Boolean(s[key]),
      apply: (v) => {
        overlay.set(key, v);
        if (key === 'showRoots' || key === 'showShoots') overlay.syncSkeleton(engine.skeleton);
        refreshLayers();
      }
    });
    checkMap.set(key, c.input);
  }
  function syncChecks() {
    for (const [key, input] of checkMap) input.checked = Boolean(overlay.state[key]);
  }

  heading(viewPane, 'Settings');
  const saveMsg = el('<p class="hint" data-testid="settings-msg"></p>');
  buttons(viewPane, [
    {
      label: 'Save settings',
      testid: 'settings-save',
      onClick: () => {
        saveMsg.textContent = saveSettings() ? 'Saved to this browser.' : 'Could not save (storage unavailable).';
      }
    },
    {
      label: 'Load',
      ghost: true,
      testid: 'settings-load',
      onClick: () => {
        saveMsg.textContent = loadSettings() ? 'Loaded.' : 'Nothing saved yet.';
      }
    },
    {
      label: 'Reset to defaults',
      ghost: true,
      testid: 'settings-reset',
      onClick: () => {
        try {
          localStorage.removeItem(STORE_KEY);
        } catch {
          /* ignore */
        }
        saveMsg.textContent = 'Saved settings cleared — reloading defaults.';
        setTimeout(() => location.reload(), 150);
      }
    }
  ]);
  viewPane.appendChild(saveMsg);

  heading(viewPane, 'Live stats');
  const statsEl = el('<div class="stats" data-testid="live-stats">—</div>');
  viewPane.appendChild(statsEl);

  // ───────────────────────── persistence ─────────────────────────
  const SKIP = new Set(['hours']); // the clock is a scene state, restored through autoCycle/time presets instead
  function snapshotSettings() {
    const values = {};
    for (const [k, c] of registry) if (!SKIP.has(k)) values[k] = c.get();
    values.hours = registry.get('hours').get();
    return { v: 1, values };
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshotSettings()));
      return true;
    } catch {
      return false;
    }
  }
  function loadSettings() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch {
      data = null;
    }
    if (!data?.values) return false;
    loading = true;
    try {
      // landscape knobs are applied once at the end
      for (const [k, v] of Object.entries(data.values)) {
        const c = registry.get(k);
        if (c) c.set(v, true);
      }
      pushLandscape();
    } finally {
      loading = false;
    }
    if (treeDirty) commitTree();
    syncClock();
    return true;
  }

  // ───────────────────────── stats ─────────────────────────
  function updateStats() {
    const st = actions.getStats();
    statsEl.textContent = [
      `tree ${engine.treeSpec.heightM.toFixed(1)} m · crown ⌀ ${(engine.treeSpec.crownRadiusM * 2).toFixed(1)} m · cx ${engine.treeSpec.complexity.toFixed(2)}`,
      `nodes ${st.nodes ?? '—'}  edges ${st.edges ?? '—'}`,
      `shoots ${st.shootEdges ?? '—'}  roots ${st.rootEdges ?? '—'}`,
      `bark tris ${st.barkTris ?? '—'}  voxel ${st.voxelM ?? '—'} m`,
      `bake ${st.bakeMs != null ? st.bakeMs.toFixed(0) + ' ms' : '—'}`,
      `simplify ${st.simplify ?? '—'}`,
      `draw ${st.drawCalls ?? '—'}  scene tris ${st.triangles ?? '—'}`,
      `canopy placed ${st.canopyCount ?? '—'} / target ${engine.canopy?.count ?? '—'}`,
      `moss: ${engine.moss?.groundCount ?? 0} cushions · ${engine.moss?.sporeCount ?? 0} spore stalks · bark shells ${engine.barkMoss?.shellTriangles ?? 0} tris`,
      `time ${atmos?.clockLabel ?? '—'} (${atmos?.periodLabel ?? '—'})`
    ].join('\n');
    const ps = fall?.stats?.();
    if (ps) {
      petalStatEl.textContent =
        `pool ${fall.count} · airborne ${ps.airborne} · resting ${ps.ground} · fading ${ps.fading} · free ${ps.free}` +
        `\nlife ~${Math.round(fall?.groundLifeMin ?? 0)}–${Math.round(fall?.groundLifeMax ?? 0)} s · rate ${fall?.emissionRate ?? 0}/s · turb ×${(fall?.turbulence ?? 1).toFixed(2)}`;
    }
    const pack = canopy?.getPackingStats?.();
    if (pack && statsEl) {
      // Append packing line into main stats so foliage fill is visible while tuning
      statsEl.textContent +=
        `\npack fill ${(pack.fill * 100).toFixed(0)}% · minDist ${pack.usedDist?.toFixed?.(3) ?? pack.minDist?.toFixed?.(3)} m · seats ${pack.candidates}`;
    }
  }

  selectTab('tree');
  updateStats();
  const timer = setInterval(() => {
    updateStats();
    if (atmos?.autoCycle) {
      hoursCtl.sync(atmos.hours);
    }
    syncClock();
  }, 700);

  // Keyboard shortcuts
  const onKey = (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === '1') actions.preset('beauty');
    if (e.key === '2') actions.preset('skeleton');
    if (e.key === '3') actions.preset('mesh');
    if (e.key === '4') actions.preset('roots');
    if (e.key === '5') actions.preset('full');
    if (e.key === '`') root.classList.toggle('collapsed');
    syncChecks();
  };
  window.addEventListener('keydown', onKey);

  // restore a previous session
  try {
    if (localStorage.getItem(STORE_KEY)) loadSettings();
  } catch {
    /* storage blocked */
  }

  return {
    root,
    updateStats,
    selectTab,
    syncCinema,
    saveSettings,
    loadSettings,
    setRenderLook(id) {
      registry.get('renderLook')?.set(id);
    },
    getTreeSpec: () => normalizeTreeSpec(treeUi),
    getBakeParams: () => ({ ...treeUi, ...extrasUi }),
    dispose() {
      clearInterval(timer);
      clearTimeout(rebuildTimer);
      window.removeEventListener('keydown', onKey);
      root.remove();
      style.remove();
    }
  };
}

export { DEFAULT_TREE_SPEC };
