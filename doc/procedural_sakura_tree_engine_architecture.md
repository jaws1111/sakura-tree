# Technical Specification: Procedural Sakura Tree Engine (Three.js / WebGL / WebGPU)

---

## 0. Units, Coordinate Frame & Real-World Scale (Mandatory)

All geometry, physics, SDF distances, wind, and lighting **must** use the International System of Units (SI). There is no “artist unit,” no inch/foot path, and no silent scale factor in shaders.

### 0.1 Engine Contract
| Quantity | Unit | Three.js / code rule |
| :--- | :--- | :--- |
| Length, position, radius, SDF distance | **metre (m)** | `1.0` world unit ≡ `1.0 m` |
| Area / volume (derived) | m² / m³ | Never hard-code cm in vertex buffers |
| Time | **second (s)** | `clock.getDelta()` is seconds; never treat it as frames |
| Linear velocity / acceleration | m·s⁻¹ / m·s⁻² | Gravity $g = 9.81\,\mathrm{m\,s^{-2}}$ |
| Angular velocity | rad·s⁻¹ | |
| Mass (if used) | kilogram (kg) | Petals use effective mass + drag, not toy numbers |
| Angles | radian (rad) | Degrees only at UI boundaries; convert immediately |

**Forbidden:** mixing centimetre mesh authors with metre scene graphs; gravity like `-0.85` without a unit; petal lengths of `0.45` when the real organ is ~1.8 cm; trunk base radius `1.2` (that is a multi-metre pillar, not a cherry bole).

**Allowed millimetre literals** only as *documentation comments* or named constants that convert at definition time:
```js
const MM = 0.001; // m
const CM = 0.01;  // m
export const PETAL_LENGTH = 18 * MM; // 0.018 m
```

### 0.2 Reference Organism — Mature Ornamental Sakura (*Prunus serrulata* / ‘Kanzan’-class)

Botanical ranges (nursery & urban inventory literature) clamped into a single **default hero tree** the engine targets:

| Part | Real-life range | Default engine value | Notes |
| :--- | :--- | :--- | :--- |
| Overall height $H$ | 6–12 m (Kanzan often 8–10 m) | **9.0 m** | Ground to crown tip |
| Crown spread / diameter | 5–10 m | **8.0 m** ($R_{\mathrm{crown}}=4.0\,\mathrm{m}$) | Vase → spreading with age |
| Trunk DBH (breast height ≈ 1.3 m) | urban median ~0.15 m; mature ornamentals larger | **0.28 m** | Radius at DBH $r_{\mathrm{dbh}}=0.14\,\mathrm{m}$ |
| Trunk base flare radius | — | **0.18–0.22 m** | Ground buttress, not DBH |
| Clear bole to first major fork | ~1.5–2.5 m | **2.0 m** | |
| Primary limb radius at attach | — | **0.06–0.10 m** | |
| Terminal twig radius | few mm | **0.003–0.006 m** | Below voxel size → capsule fallback |
| Flower diameter | 3.0–4.0 cm (to ~6 cm double cvs.) | **0.036 m** | |
| Petal length × width | ~1.5–1.9 cm × ~1.1–1.7 cm | **0.018 × 0.014 m** | Single petal lamina |
| Petals per simple flower | 5 | 5 | Doubles use more petals / LOD cards |
| Flowers per cluster (umbel) | 2–5 | **4** open + 2 buds | |
| Pedicel length | up to ~4 cm | **0.025–0.040 m** | |
| Leaf length (out of bloom focus) | 5–13 cm | optional LOD | |
| Horizontal lenticel pitch (vertical) | ~0.8–2.5 cm | **0.015 m** mean | UV $V$ still in metres |
| Bark furrow depth (aged trunk) | ~2–8 mm | $A_{\mathrm{bark}}=0.004\,\mathrm{m}$ | Decays to 0 on twigs |
| Root collar / soil contact | — | $y=0$ ground plane | |
| Lateral root depth | shallow ornamental | **1.2 m** ($y\in[-1.2,-0.04]$) | Most mass in upper soil |
| Tap / sinker depth | — | **1.6 m** | Central underground axis |
| Root plate spread | ≈ drip-line | **$\approx 4.2\,\mathrm{m}$** | $1.05\,R_{\mathrm{crown}}$ |
| Primary lateral radius at collar | — | **0.11 m** | Tapers to $5\,\mathrm{mm}$ tips |

### 0.3 Scene & Environment Defaults (metres)
| Element | Default |
| :--- | :--- |
| Ground plane | $y = 0$ |
| Tree origin | $(0, 0, 0)$ at root collar |
| Park patch extent | $40\,\mathrm{m} \times 40\,\mathrm{m}$ around tree |
| Camera eye-height (standing) | $1.6\,\mathrm{m}$ |
| Near / far clip | $0.05\,\mathrm{m}$ / $250\,\mathrm{m}$ |
| Sun distance (dir. light target offset) | position magnitude irrelevant; keep direction only |
| Ambient wind | $1.5\,\mathrm{m\,s^{-1}}$ |
| Gust peak | $5.0\,\mathrm{m\,s^{-1}}$ |
| Falling-petal terminal speed | $0.9\,\mathrm{m\,s^{-1}}$ (drag-limited; not free-fall) |
| Grass blade height | $0.08$–$0.18\,\mathrm{m}$ (lawn / soft meadow) |
| Grass blade width | $0.003$–$0.006\,\mathrm{m}$ |
| Moss cushion / strand length | $0.005$–$0.015\,\mathrm{m}$ |

### 0.4 Validation Checklist (CI / debug HUD)
1. Draw a **1.0 m** calibration cube and a **1.70 m** human proxy next to the bole — trunk must not exceed ~0.45 m diameter at breast height for the default hero.
2. A single petal AABB diagonal must be $\approx 0.02\,\mathrm{m}$, never decimetre-scale.
3. SDF sphere-trace hit distances and MC voxel size are metres; $\varepsilon_{\mathrm{hit}} = 5\times10^{-4}\,\mathrm{m}$ (0.5 mm).
4. Integrate physics with $\Delta t$ in seconds and $g=+9.81\,\mathrm{m\,s^{-2}}$ downward (store $\vec{g}=(0,-9.81,0)$).
5. Any constant without an explicit unit in its name is treated as a **bug**.

---

## 1. Executive Review & Architectural Critique

The preliminary proposal captured high-level concepts (space colonization, Frenet-Serret frames, instanced foliage), but lacked the mathematical rigor, geometric edge-case handling, **metric scale discipline**, and graphics pipeline considerations required for production-grade rendering. 

### Critical Shortcomings & Engineering Solutions

1. **Branch Junctions: Skeleton → Volume → Mesh (Chosen Pipeline)**
   * *Critique:* Pure Frenet-Serret generalized-cylinder sweeps create self-intersections and hard creases at bifurcations. Runtime per-frame Marching Cubes on the main thread also tanks frame time and yields unstable UVs.
   * *Solution:* Adopt a **three-stage bark pipeline** that keeps junctions smooth while remaining rasterization-friendly at runtime:
     1. **Branch Skeleton** — space-colonization graph with tapered radii (Leonardo exponent) and parallel-transport frames for parameterization.
     2. **Ray-Marchable Volume** — each segment is a tapered capsule SDF; segments combine via polynomial smooth-min; bark grooves are subtractive anisotropic displacement in the field.
     3. **Mesh Extraction** — offline / worker bake via Marching Cubes (or Surface Nets) at iso-level 0, then remap UVs from nearest skeleton arc-length + angle. Runtime path draws the baked `BufferGeometry`; optional debug ray-march AABB preview validates the volume before bake.

2. **Naïve Normal Inversion on Foliage**
   * *Critique:* Simply setting vertex normals radially outward from the canopy center destroys microscopic self-shadowing and causes leaves to appear as flat billboard spheres under directional lighting.
   * *Solution:* Implement **Dual-Normal Weighted Blending**. The geometry shader preserves micro-facet normals $\vec{N}_{\text{micro}}$ (accounting for petal curvature and vein creases) and linearly blends them with macro-envelope normals $\vec{N}_{\text{macro}}$ calculated from the centroid of each branch cluster:
     $$\vec{N}_{\text{final}} = \text{normalize}\big((1 - \alpha)\vec{N}_{\text{micro}} + \alpha \vec{N}_{\text{macro}}\big), \quad \alpha \in [0.6, 0.85]$$

3. **Petal Geometry Monotony**
   * *Critique:* A single flat petal or uniform quad, regardless of shader quality, yields an artificial look when multiplied thousands of times.
   * *Solution:* Design an analytic **Parametric Petal Mesh Generator** capable of generating parametric sub-variants via a localized seed. This includes the apical notch, central longitudinal fold, parabolic cupping, and basal hinge.

4. **Kinematic Decoupling of Drifting Petals**
   * *Critique:* Standard particle emitters spawn unconnected particles with linear fall patterns.
   * *Solution:* Implement a dual-mode dynamic solver:
     * **Mode A (Atmospheric/Turbulent):** 3D Divergence-Free Curl Noise vector field.
     * **Mode B (Romantic/Flocking):** Craig Reynolds' 3D Boids formulation modified with localized aerodynamic drag, terminal velocity clamping, and variable gravity.

---

## 2. Geometric Core: Parametric Petal Generator

A realistic cherry blossom petal is not flat; it features an apical cleft (notch), a longitudinal center crease, cupping toward the adaxial surface, and an arched hinge at the receptacle.

```
          Apical Notch (Cleft)
             / \       / \
            /   \_____/   \
           /               \
          |     Adaxial     |
          |     Surface     |  <-- Cross-sectional parabolic cup
           \   (Creased)   /
            \             /
             \     |     /
              \    |    /
               \___|___/
                 Hinge / Receptacle
```

### 2.1 Analytic Boundary & Height Function
We define the 2D footprint of the petal over normalized domain coordinates $(u, v) \in [0, 1]^2$, where $v$ is the longitudinal axis (base to tip) and $u$ is the lateral axis (left to right, centered at $0.5$).

The half-width function $W(v)$ defines the characteristic spade-like profile with an apical notch:
$$W(v) = W_{\text{max}} \cdot \left( v^{0.6} \cdot (1 - v)^{0.4} \right) \cdot \Big[ 1.0 - \beta_{\text{notch}} \cdot \exp\Big( -\frac{(v - 1.0)^2}{2\sigma_{\text{notch}}^2} \Big) \cdot \exp\Big( -\frac{(u - 0.5)^2}{2\sigma_{\text{cleft}}^2} \Big) \Big]$$

Where (all lengths in **metres** after scaling by petal size):
* Petal length $L = 0.018\,\mathrm{m}$ (1.8 cm); full width $2 W_{\max}\cdot L \approx 0.014\,\mathrm{m}$.
* $W_{\text{max}}$: Normalized half-width coefficient ($\approx 0.39$ of $L$), so physical half-width $\approx 0.007\,\mathrm{m}$.
* $\beta_{\text{notch}} \in [0.4, 0.85]$: Depth factor of the terminal cleft (dimensionless).
* $\sigma_{\text{notch}}, \sigma_{\text{cleft}}$: Dimensionless decay in $(u,v)$ parameter space.
* Cup / curl / crease amplitudes $C_{\ast}$ are fractions of $L$ (defaults: cup $0.12\,L$, curl $0.08\,L$, crease $0.05\,L$) → physical deflections of **1–2 mm**, matching real lamina cupping.

The vertical deflection (height profile) $Z(u, v)$ imparts cupping and folding (output already in metres once multiplied by $L$):
$$Z(u, v) = L\cdot\Big[
\underbrace{-c_{\text{cup}} \cdot 4(u - 0.5)^2 \cdot v^{0.5}}_{\text{Transverse Cupping}} + \underbrace{c_{\text{curl}} \cdot v^2}_{\text{Longitudinal Curl}} - \underbrace{c_{\text{crease}} \cdot |u - 0.5| \cdot (1 - v)}_{\text{Central V-Crease}}
\Big]$$

### 2.2 Triangle Budget & Micro-Topology Allocation
Given a **Medium-to-High triangle budget**:
* **Petal Resolution:** A single petal is discretized onto a regular grid of $M \times N$ subdivisions, where $M = 7$ (lateral) and $N = 11$ (longitudinal).
* **Vertex Count:** 77 vertices, producing 120 triangles per petal.
* **Flower Construction:** 5 petals form a single flower ($120 \times 5 = 600$ tris); flower diameter $\approx 0.036\,\mathrm{m}$.
* **Cluster Construction:** 1 Blossom Cluster archetype aggregates 4 open flowers, 2 semi-opened buds (30 tris each), and 1 central stamen receptacle core (80 tris). Physical cluster diameter $\approx 0.10$–$0.14\,\mathrm{m}$.
* **Total Cluster Triangles:** $\approx 2{,}540$ triangles.
* **Canopy Scale:** For an 8 m crown, $\approx 3{,}000$–$6{,}000$ visible clusters is botanically dense; $15{,}000$ is an upper cinematic budget (~38 M virtual tris) managed via frustum culling, dynamic LOD, and single-pass instancing.

### 2.3 Structural Variant Bank
To prevent GPU asset duplication while maintaining visual variety, the procedural engine constructs an internal **Variant Geometry Buffer** containing $K = 4$ unique geometric archetypes baked into a single static `BufferGeometry` interleaved layout:

```
[ Variant 0: Standard Cupped ]
[ Variant 1: Asymmetric Twist (Wind-deformed) ]
[ Variant 2: Deep Apical Notch (Wild Specie Typology) ]
[ Variant 3: Immature / Budding Compact ]
```

Each archetype shares the identical UV unwrapping scheme, enabling batched draws with variation controlled via instance-level attributes:
* `aInstanceVariantOffset`: Offset within the shared buffer or index-level selection.
* `aInstanceMorphWeight`: Morph target scalar interpolated inside the vertex shader to deform between cupped and flattened variants.

---

## 3. Bark Pipeline: Skeleton → Ray-March Volume → Mesh

Cherry bark must read as one continuous living surface through every crotch. The engine therefore never stitches independent tube meshes. It grows a skeleton, embeds it in an analytic SDF volume (ray-marchable), then extracts a single manifold mesh for real-time rasterization.

```
                      [Root Attraction Seed]
                                 │
                     [Space Colonization Loop]
                     (Influence Radius Di, Dk)
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       [Trunk Spline Backbone]         [Secondary Boughs]
        (Catmull-Rom Smoothing)         (Phototropic Bias)
                 │                               │
                 └───────────────┬───────────────┘
                                 │
              [STAGE A — Branch Skeleton Graph]
         nodes, edges, radii, parallel-transport frames
                                 │
              [STAGE B — Ray-Marchable SDF Volume]
     tapered capsules ∪ smooth-min ∪ bark groove field
         (optional AABB sphere-trace debug preview)
                                 │
              [STAGE C — Isosurface → Mesh Bake]
     Marching Cubes / Surface Nets @ iso = 0 (Worker)
         UV remap from nearest skeleton (θ, s)
                                 │
                   [Baked BufferGeometry + Bark Material]
```

### 3.1 Stage A — Space Colonization Skeleton (Shoots **and** Roots)
All positions and radii below are in **metres**, sized to the §0.2 hero tree ($H=9.0\,\mathrm{m}$, $R_{\mathrm{crown}}=4.0\,\mathrm{m}$, $r_{\mathrm{base}}=0.20\,\mathrm{m}$).

The skeleton hub is the **root collar** at $(0,0,0)$:
* **Shoots** occupy $y \ge 0$ (bole, limbs, twigs).
* **Roots** occupy $y < 0$ (underground) — a tap/sinker plus a shallow spreading plate. Cherry ornamentals are not deep-rooted; most laterals live in the upper $\sim 1.2\,\mathrm{m}$ of soil and extend roughly to the crown drip-line.

```
                    [Crown attractors y∈[2,9]]
                              │
                     [Space colonization ↑]
                              │
              [Trunk bole]  y: 0 → 2 m (fork)
                              │
                    ★ COLLAR (0,0,0) ★
                     ┌────────┴────────┐
                     ▼                 ▼
            [Taproot y→−1.6 m]   [Lateral root plate]
                                   attractors y∈[−1.2,−0.04]
                                   spread ≈ 4.2 m, geotropism ↓
```

1. **Crown Attraction Volumes:** Scatter $N_{\text{attract}}$ points in an inverted asymmetrical paraboloid (metres):
   $$X^2 + Z^2 \le k_1 \cdot (Y - Y_{\mathrm{fork}}) \cdot (H - Y) + \sigma_{\mathrm{noise}},\quad
   Y \in [Y_{\mathrm{fork}}, H],\quad Y_{\mathrm{fork}}=2.0\,\mathrm{m}$$
2. **Root Attraction Volumes (underground):** Scatter $N_{\text{root}}$ points in a shallow plate biased toward the soil surface:
   $$Y \in [-D_{\mathrm{root}}, -0.04],\quad D_{\mathrm{root}}=1.2\,\mathrm{m},\quad
   \sqrt{X^2+Z^2} \le R_{\mathrm{root}}(Y),\quad R_{\mathrm{root}}^{\max}\approx 4.2\,\mathrm{m}$$
3. **Growth Steps (metric, multi-resolution):**
   * Primary / secondary shoots: $\Delta L = 0.25\,\mathrm{m}$; twigs $0.08$–$0.12\,\mathrm{m}$
   * Roots: $\Delta L \approx 0.14\,\mathrm{m}$; kill / influence $D_k\approx 0.32\,\mathrm{m}$, $D_i\approx 0.95\,\mathrm{m}$
   * Root growth uses **geotropism** (downward bias) + radial plate bias; hard clamp $y \le -0.03\,\mathrm{m}$ so roots never break the soil plane except at the collar.
4. **Leonardo da Vinci Exponent** — applied **separately** to shoot and root subgraphs so roots do not inflate the bole:
   $$r_{\text{parent}} = \left( \sum_{i=1}^{k} r_{\text{child}, i}^{\Delta} \right)^{\frac{1}{\Delta}}, \quad \Delta = 2.45$$
   * Shoots: clamp collar / base $r_{\mathrm{base}}=0.20\,\mathrm{m}$, tip $\ge 0.003\,\mathrm{m}$.
   * Roots: primary lateral at collar $r\approx 0.11\,\mathrm{m}$, tip $\ge 0.005\,\mathrm{m}$; tap tip $\approx 0.012\,\mathrm{m}$.
5. **Parallel Transport Frames:** Store $\vec{T}, \vec{N}, \vec{B}$ per node. Arc-length $s$ is **signed** metres from the collar: $s>0$ aerial, $s<0$ underground (path length with sign by kind).

Each edge $e = (a \to b)$ becomes a **tapered capsule descriptor**: endpoints $\mathbf{a}, \mathbf{b}$ (m), radii $r_a, r_b$ (m), arc-lengths $s_a, s_b$ (m), and `isRoot` flag. **AABB bounds must include negative $Y$** — never clamp $\min Y$ to $0$ or underground wood is silently dropped from the SDF bake.

### 3.2 Stage B — Ray-Marchable Volume (Analytic SDF)

The volume is an analytic signed distance field $f(\mathbf{p})$ with $f < 0$ inside wood. It is valid for both sphere-tracing (preview / shadow cones) and grid sampling (mesh bake).

#### 3.2.1 Tapered Capsule Primitive
For edge endpoints $\mathbf{a}, \mathbf{b}$ and radii $r_a \to r_b$:
$$
\begin{aligned}
\mathbf{ba} &= \mathbf{b} - \mathbf{a},\quad
h = \mathrm{saturate}\!\left(\frac{(\mathbf{p}-\mathbf{a})\cdot\mathbf{ba}}{\mathbf{ba}\cdot\mathbf{ba}}\right),\\
r(h) &= \mathrm{mix}(r_a, r_b, h),\\
d_{\mathrm{cap}}(\mathbf{p}) &= \|(\mathbf{p}-\mathbf{a}) - \mathbf{ba}\,h\| - r(h)
\end{aligned}
$$

#### 3.2.2 Smooth Union Across the Skeleton
Polynomial smooth-min (Quilez) blends crotches without explicit junction topology:
$$
\mathrm{smin}(d_1, d_2, k) = \min(d_1,d_2) - \frac{h^2 k}{4},\quad
h = \max\!\big(k - |d_1 - d_2|,\, 0\big)/k
$$
$$
f_{\mathrm{wood}}(\mathbf{p}) = \mathrm{smin}_{e \in E}\big(d_{\mathrm{cap},e}(\mathbf{p}),\, k_{\mathrm{blend}}(r_e)\big)
$$
Blend radius $k_{\mathrm{blend}}$ scales with local radius ($\approx 0.35\,r$, metres) so thick trunk forks fillet more than thin twigs (e.g. $k\approx 0.07\,\mathrm{m}$ at the bole, $k\approx 0.002\,\mathrm{m}$ on twigs).

**BVH / segment culling:** evaluate only the $K$ nearest capsules (KD-tree or hierarchical AABB over edges). Full $O(|E|)$ evaluation is reserved for offline bake; runtime ray-march preview uses the BVH.

#### 3.2.3 Bark Groove Field (Volumetric Displacement)
Cherry furrows follow the local branch axis, not world axes. Two groove fields (trunk-aligned and branch-aligned) cross-fade by depth, then carve the wood field. $G\in[0,1]$ is dimensionless; $A_{\mathrm{bark}}$ carries metres:
$$
\begin{aligned}
\theta &= \mathrm{atan2}(\vec{N}\cdot\mathbf{q},\, \vec{B}\cdot\mathbf{q}),\quad
\mathbf{q} = \mathbf{p} - \mathbf{C}(s^\star)\\
G_{\mathrm{trunk}} &= \big|\sin(n_\ell\,\theta + \omega s + \phi\,\sin(\eta s))\big|\\
G_{\mathrm{branch}} &= \big|\sin(n_b\,\theta' + \omega' s' + \ldots)\big|\\
G &= (1-w)\,G_{\mathrm{trunk}} + w\,G_{\mathrm{branch}}\\
f(\mathbf{p}) &= f_{\mathrm{wood}}(\mathbf{p}) + A_{\mathrm{bark}}\,G\cdot\big(1 - \tfrac{\mathrm{depth}}{\mathrm{depth}_{\max}}\big)
\end{aligned}
$$
* $A_{\mathrm{bark}} = 0.004\,\mathrm{m}$ (4 mm) on aged trunk; linearly → $0$ for $r < 0.015\,\mathrm{m}$.
* Angular / longitudinal frequencies $\omega, \eta$ use **rad per metre** of arc-length $s$ (e.g. $\eta \approx 8\,\mathrm{rad\,m^{-1}}$).
* Horizontal lenticels remain a **shader-stage** detail on the extracted mesh (see §4.2), not a second meshing pass.

#### 3.2.4 Sphere-Tracing Contract (Preview / Debug)
For a ray $\mathbf{o} + t\vec{d}$ with $t$ in metres:
$$
t_{i+1} = t_i + f(\mathbf{o} + t_i\vec{d}),\quad
\text{hit when } |f| < \varepsilon \text{ or } t > t_{\max}
$$
$\varepsilon = 5\times 10^{-4}\,\mathrm{m}$ (0.5 mm); $t_{\max}$ = camera far plane. Confine marches to per-bough AABBs (TreeGen-style hybrid: rasterize AABB → fragment sphere-trace). Adaptive step counts by camera distance. This path is **authoring/validation only**; production frames draw the baked mesh.

### 3.3 Stage C — Isosurface Extraction → Mesh

1. **Bounds:** axis-aligned box padded by $\max r + A_{\mathrm{bark}} + k_{\mathrm{blend}}$ (metres). Hero tree ≈ $[-4.5,4.5]\times[0,9.2]\times[-4.5,4.5]\,\mathrm{m}$.
2. **Grid:** choose voxel size from metric targets, not arbitrary integers:
   * Trunk / primary: $\Delta x \approx 0.025\,\mathrm{m}$ (2.5 cm) → ~360 cells on the 9 m axis if uniform; prefer **narrow-band / hierarchical** volumes so only wood neighbourhood is sampled.
   * Twigs with $r < 1.5\,\Delta x$: skip MC; emit swept capsule meshes instead.
3. **Extract:** Marching Cubes at iso-level $0$ (metres SDF). Surface Nets OK when quad connectivity aids LOD collapse.
4. **Normals:** analytic $\nabla f$ via central differences with $h=0.5\,\Delta x$.
5. **UV Remap (deterministic, metric):** for each extracted vertex $\mathbf{v}$, find nearest skeleton edge, project to $(s, \theta)$ in that edge’s parallel-transport frame:
   * $U = \theta / 2\pi$ (dimensionless)
   * $V = s$ **in metres** (shader scales by lenticel density $\rho_\ell \approx 1/0.015 = 67\,\mathrm{m^{-1}}$)
6. **Seams & Welding:** $\epsilon_{\mathrm{weld}} = 0.25\,\Delta x$; optional quadratic edge collapse to hit the §6 triangle budget.
7. **Worker Bake:** Stages B–C in a Web Worker; main thread uploads transferable buffers once.

### 3.4 Why This Order (Research Notes)
* **Smooth junctions without hand-authored crotch topology** — capsule smooth-min is the industry-default organic CSG join (SDF toolkits, printable SDF trees).
* **Ray-march volume first** validates blend radius, bark amplitude, and missing twigs *before* paying for a dense mesh (hybrid TreeGen insight: curves/volume for shape, raster mesh for leaves/runtime).
* **Mesh second** restores cheap shadow maps, deferred/forward materials, and instanced moss scattering on real triangles — pure full-screen ray-march of an entire sakura canopy is too expensive next to 15k blossom clusters.
* **UV from skeleton**, not from MC triangulation order, keeps lenticels coherent across rebakes when resolution changes.

---

## 4. Shaders, UV Mapping & Materials

```
                                MeshStandardNodeMaterial
                                            │
       ┌────────────────────────┬───────────┴───────────┬────────────────────────┐
       ▼                        ▼                       ▼                        ▼
[Albedo Map (fBm)]     [Normal / Roughness]     [Subsurface Scattering]   [Vertex Animation]
 • Translucent Pink     • High-frequency split   • Wrap lighting ($K_w$)   • Dual-frequency
 • Basal Chlorophyll      bark lenticels         • Transmission mask        wind sway
 • Vein Networks        • Micro-vein grooves     • Back-scatter color     • High-Hz flutter
```

### 4.1 Petal Micro-Shading Pipeline
The petal material is built upon `MeshPhysicalMaterial` via custom shader injection to balance performance and subsurface light transport.

#### Translucency & Subsurface Approximation (Fragment Stage)
Standard PBR models treat surfaces as opaque interfaces, which makes cherry petals look like pink plastic. We inject an analytical forward-scattering approximation:
```glsl
// GLSL: Subsurface Scattering & Transmission Evaluation
vec3 calculatePetalSubsurface(
    vec3 lightDir, 
    vec3 viewDir, 
    vec3 normal, 
    vec3 lightColor, 
    vec3 baseColor, 
    float thickness
) {
    // Distorted light vector pointing toward the viewer through the petal
    vec3 vLight = lightDir + normal * 0.35;
    float fLdotV = max(0.0, dot(-viewDir, vLight));
    
    // Forward-peaked transmission power curve
    float forwardScatter = pow(fLdotV, 3.5) * 1.8;
    
    // Diffuse wrap lighting to simulate back-face light saturation
    float wrapScatter = max(0.0, (dot(normal, lightDir) + 0.45) / 1.45);
    
    vec3 sssColor = mix(baseColor, vec3(1.0, 0.42, 0.58), 0.65);
    return lightColor * sssColor * (forwardScatter * thickness + wrapScatter * 0.2);
}
```

#### Analytical Dual-Normal Interpolation (Vertex Stage)
```glsl
attribute vec3 aClusterCenter;
attribute float aNormalBlendFactor;

void main() {
    // Standard Frenet surface normal
    vec3 vNormalMicro = normalize(normalMatrix * normal);
    
    // Macro envelope normal: pointing outward from cluster centroid
    vec3 vNormalMacro = normalize(normalMatrix * (position - aClusterCenter));
    
    // Blend to soften lighting transitions
    vTransferredNormal = normalize(mix(vNormalMicro, vNormalMacro, aNormalBlendFactor));
}
```

### 4.2 Procedural Bark Shader: Horizontal Lenticels
Cherry bark features distinct horizontal lenticels (corky lens-shaped pores) breaking through smooth, dark grey-brown periderm. Mesh `uv.y` **is arc-length in metres** (§3.3); the shader converts to lenticel cells using a real pitch of ~1.5 cm:

```glsl
// Horizontal Lenticel Generator — uv.y in metres along branch
float proceduralBarkLenticels(vec2 uv) {
    // ~8 cells around circumference; ~1.5 cm vertical pitch
    const float LENTICEL_PITCH_M = 0.015;
    vec2 st = vec2(uv.x * 8.0, uv.y / LENTICEL_PITCH_M);
    vec2 ipos = floor(st);
    vec2 fpos = fract(st);

    float n = hash21(ipos);
    float lenticel = 0.0;

    if (n > 0.62) {
        float xCenter = 0.5 + 0.3 * sin(n * 6.28);
        // Lens ~1–3 cm wide, ~2–4 mm tall in param space
        float dist = abs(fpos.x - xCenter) * 1.8 + abs(fpos.y - 0.5) * 6.0;
        lenticel = smoothstep(0.4, 0.0, dist) * n;
    }
    return lenticel;
}
```

---

## 5. Falling Petal System: Dual-Mode Physics Core

To deliver both realistic aerodynamic behavior and stylized visual motion, the engine implements two distinct runtime modes selectable via configuration. **All forces use SI:** positions in m, velocities in m·s⁻¹, accelerations in m·s⁻², $\Delta t$ in s.

```
                     [Particle Initialization]
                     (Canopy Volume Sampling)
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
       [Mode A: 3D Curl Noise]       [Mode B: Flocking / Boids]
        • Incompressible field        • Local neighborhood scan
        • High-frequency flutter      • Flocking vectors (S, A, C)
        • Rapid crosswinds            • Visual romance / grouping
                 │                             │
                 └──────────────┬──────────────┘
                                │
                   [Aerodynamic Lift & Drag]
                   (Angle-of-Attack Tumbling)
                                │
                  [Ground Collision & Settling]
                   (Lock to ground; fade/respawn)
```

### 5.1 Mode A: 3D Divergence-Free Curl Noise Solver
Turbulent air currents are computed by taking the curl of a 3D Simplex potential field $\vec{\Psi}(\mathbf{x})$ (potential scaled so $\nabla\times\Psi$ yields **m·s⁻¹**):
$$\vec{v}_{\text{fluid}}(\mathbf{x}) = \nabla \times \vec{\Psi}(\mathbf{x}) = \left( \frac{\partial \Psi_z}{\partial y} - \frac{\partial \Psi_y}{\partial z}, \, \frac{\partial \Psi_x}{\partial z} - \frac{\partial \Psi_z}{\partial x}, \, \frac{\partial \Psi_y}{\partial x} - \frac{\partial \Psi_x}{\partial y} \right)$$
* Incompressibility ($\nabla \cdot \vec{v}_{\text{fluid}} = 0$) prevents particles from clustering into unphysical density spikes.
* Integrate with true gravity and ambient wind (both SI):
  $$\vec{a} = \vec{g} + \vec{a}_{\mathrm{drag}}(\vec{v}) + \vec{a}_{\mathrm{curl}},\quad
  \vec{g}=(0,-9.81,0)\,\mathrm{m\,s^{-2}},\quad
  \|\vec{v}_{\mathrm{term}}\|\approx 0.9\,\mathrm{m\,s^{-1}}$$
  Quadratic drag $a_{\mathrm{drag}} = -k_d\,\|\vec{v}\|\vec{v}$ is tuned once so flat-facing petals approach $v_{\mathrm{term}}$, not free-fall. Ambient wind $\vec{W}_{\mathrm{ambient}}$ defaults to $1.5\,\mathrm{m\,s^{-1}}$ horizontal.

### 5.2 Mode B: Extended 3D Flocking (Romantic Boids Formulation)
Petals drift in coordinated, swirling ribbons before gently fluttering down.

For petal $i$ with position $\mathbf{p}_i$ (m) and velocity $\mathbf{v}_i$ (m·s⁻¹), within neighborhood radius $R = 0.45\,\mathrm{m}$ (romantic clustering scale, not kilometres):
1. **Separation:** Prevents unnatural clustering (output treated as acceleration after gain $k_{\mathrm{sep}}$ in s⁻² scaling):
   $$\vec{a}_{\text{sep}} = k_{\text{sep}}\sum_{j \ne i}^{K} \frac{\mathbf{p}_i - \mathbf{p}_j}{\|\mathbf{p}_j - \mathbf{p}_i\|^2}$$
2. **Alignment:** Matches travel velocities:
   $$\vec{a}_{\text{align}} = k_{\text{align}}\Big(\tfrac{1}{K}\sum_{j=1}^{K}\mathbf{v}_j - \mathbf{v}_i\Big)$$
3. **Cohesion:** Keeps local petal groups intact:
   $$\vec{a}_{\text{coh}} = k_{\text{coh}}\Big(\big(\tfrac{1}{K}\sum_{j=1}^{K}\mathbf{p}_j\big) - \mathbf{p}_i\Big)$$
4. **Gravity & lift (SI):**
   $$\vec{a}_{g} = \vec{g}\,\big(1.0 - C_{\text{lift}} \cdot |\hat{v}_i \cdot \hat{n}_i|\big),\quad \vec{g}=(0,-9.81,0)$$
   Flat-facing petals ($|\hat{v}\cdot\hat{n}|\approx 1$) approach $v_{\mathrm{term}}\approx 0.9\,\mathrm{m\,s^{-1}}$; edge-on petals fall faster (still drag-capped $\le 2.5\,\mathrm{m\,s^{-1}}$).

### 5.3 Aerodynamic Tumbling & Ground Settling
Each petal tracks orientation via a quaternion $\mathbf{q}_i$ and angular velocity $\vec{\omega}_i$ (rad·s⁻¹).
* Aerodynamic torque (N·m / I → rad·s⁻² after inertia absorb into $\kappa$):
  $$\vec{\alpha} = \kappa_{\text{aero}}\,(\mathbf{v}_i \times \hat{n}_i)$$
* **Ground Accumulation:** When $y \le y_{\mathrm{ground}}(x,z)$ (metres; flat default $0$):
  1. Set $v_{y} = 0$.
  2. Damp horizontal velocity: $\vec{v}_{xz} \leftarrow \vec{v}_{xz} \cdot e^{-k_{\mathrm{slide}}\Delta t}$ with $k_{\mathrm{slide}}\approx 4\,\mathrm{s^{-1}}$ (frame-rate independent).
  3. Align the petal normal with the terrain up-vector.
  4. After resting lifetime $T_{\text{decay}}\in[8,20]\,\mathrm{s}$, fade and respawn in the canopy volume.

---

## 6. Optimization Matrix & Triangle Budget Strategy

```
World scale: 1 unit = 1 m (§0)
Hero tree: H = 9.0 m, crown Ø = 8.0 m
Total Scene Budget: 40M - 60M Virtual Polygons
Real-Time Rendering Target: 60 FPS on Modern GPUs (Direct Compute / Batched Draws)
```

| Component | Physical extent | Target Triangle Budget | Draw Calls | Key Optimization |
| :--- | :--- | :--- | :--- | :--- |
| **Trunk & Primary (SDF→mesh)** | bole $r\!\approx\!0.20\,\mathrm{m}$, $H\!\approx\!9\,\mathrm{m}$ | $85{,}000$ | 1 | Worker MC bake; metric voxel $\Delta x\!\approx\!0.025\,\mathrm{m}$ |
| **Secondary & Terminal Twigs** | $r\ge 0.003\,\mathrm{m}$ | $220{,}000$ | 1 | Capsule fallback below voxel Nyquist |
| **Blossom Clusters** | cluster Ø $\approx 0.12\,\mathrm{m}$ | up to $38\,\mathrm{M}$ virtual | 1–3 | Instancing + LOD; petal mesh in metres |
| **Drifting Petals** | lamina $0.018\times0.014\,\mathrm{m}$ | $240{,}000$ ($2$–$3\mathrm{k}$ active) | 1 | SI drag / $v_{\mathrm{term}}=0.9\,\mathrm{m\,s^{-1}}$ |
| **Terrain + Grass** | $40\times40\,\mathrm{m}$ patch | blades $80\mathrm{k}$–$400\mathrm{k}$ | 1–4 tiles | Instanced strips; heightfield metres |
| **Moss (bark + ground)** | strands $5$–$15\,\mathrm{mm}$ | $50\mathrm{k}$–$200\mathrm{k}$ | 1–2 | Up-normal + shade bias scatter |
| **Post-Processing** | screen | 2 quads | 3 | Bloom / SSAO / DoF |

---

## 7. Environment, Terrain, Grass & Moss

The sakura reads as a place only when the ground plane, undergrowth, and bark epiphytes share the **same metric world and the same wind field**. This section captures researched best practices (Ghost of Tsushima / threenames Grasslands compute→indirect pipeline, Three.js `InstancedMesh` grass guides, sylva / imoss moss strands, GrassSystemThreeJS moss-on-upfacing-surfaces).

### 7.1 Terrain (metres)
* Heightfield $h(x,z)$ in metres; default gentle park mound $\lvert h\rvert \le 0.35\,\mathrm{m}$ over a $40\times40\,\mathrm{m}$ patch.
* Same analytic $h$ on GPU (displacement) and CPU (petal / camera collision) — bit-compatible if possible.
* Material splat by **slope** (rock on steep) and **height** (damp hollows darker); share a world-space moisture noise with moss/grass age so dirt and blades agree.
* Chunk size $8\,\mathrm{m}$; LOD skirts hang $\sim 0.15\,\mathrm{m}$ to hide cracks.

### 7.2 Grass — Instanced Blades (best practice)
**Do not** spawn one `Mesh` per blade. Use one (or few tiled) `InstancedMesh` with a low-poly strip.

| Parameter | SI default | Rationale |
| :--- | :--- | :--- |
| Blade height | $0.08$–$0.18\,\mathrm{m}$ | Soft park meadow under sakura, not prairie |
| Blade width | $0.003$–$0.006\,\mathrm{m}$ | Real Poaceae cross-section |
| Segments per blade | 3–5 | Enough for wind curvature |
| Candidate spacing | $0.04$–$0.08\,\mathrm{m}$ | Dense near trunk drip-line |
| Near draw radius | $18\,\mathrm{m}$ | Feathered cull ±14% by hash (Grasslands) |
| Far carpet | lit terrain albedo beyond | Avoid hard grass ring |

**Pipeline (WebGL baseline → WebGPU upgrade path):**
1. Place candidates on $XZ$ jittered grid; reject by density hash, slope $>35^\circ$, and under dense canopy shade optionally thinned.
2. Snap $Y$ to $h(x,z)$; orient with terrain normal (frames from **static** height, not wind-displaced positions).
3. Vertex wind: displace only upper vertices; dual-octave world-XZ gust + flutter; sample the **same** wind vector field as petals/branches ($1.5$–$5\,\mathrm{m\,s^{-1}}$).
4. Clumping (Voronoi / coarse grid): shared facing + height boost — uniform random grass reads as static.
5. WebGPU path (optional): compute cull → atomic compact → `drawIndexedIndirect` (GoT / Grasslands). CPU never readbacks blade lists.

**Shading:** wrap diffuse + thin-blade translucency; blend blade normals toward terrain normal with distance to kill specular aliasing; view-space thicken so edge-on blades do not vanish.

### 7.3 Moss & Lichen
Two coupled systems, both metric:

**A. Ground / stone moss carpet**
* Coverage mask from FBM + upward-facing factor $\max(\hat{n}\cdot\hat{y},0)^p$ and moisture noise.
* Micro-displacement $2$–$8\,\mathrm{mm}$ so moss has volume (GrassSystemThreeJS pattern).
* Optional instanced short strands ($5$–$12\,\mathrm{mm}$) in deep shade near the bole.

**B. Bark epiphytic moss (trunk & forks)**
* Scatter on baked bark mesh triangles where $\hat{n}\cdot\hat{y} > 0.35$ and local radius $r > 0.04\,\mathrm{m}$ (twigs stay clean).
* Prefer north / shade bias and crotch concavity (mean curvature or SDF groove depth).
* Strand geometry: 4–6 segment tapered blades, length $0.006$–$0.015\,\mathrm{m}$, clumped with flow-field noise (imoss / sylva).
* Lichen: sparse high-frequency albedo speckles in the bark shader (no extra geo), cooler grey-green, stronger on older trunk.

### 7.4 Shared Atmosphere Contract
```
                    [World Wind Field W(x,t) in m·s⁻¹]
                     ┌──────────┼──────────┬──────────┐
                     ▼          ▼          ▼          ▼
                  Branches   Petals     Grass      Moss tips
                  (macro)   (curl+drag) (vertex)  (micro)
```
One gust must visibly travel across grass → bole moss → canopy petals. Express all damping as per-second rates ($1-e^{-k\Delta t}$), never per-frame constants.

### 7.5 Environment Budget (40×40 m patch)
| Layer | Count / resolution | Notes |
| :--- | :--- | :--- |
| Terrain grid | $1\,\mathrm{m}$ quads near, $4\,\mathrm{m}$ far | Skirts + splat |
| Grass instances | $1.2\times 10^5$ default ($4\times 10^5$ cinematic) | Tiled InstancedMesh |
| Ground moss strands | $4\times 10^4$ | Shade pools |
| Bark moss strands | $6\times 10^4$ | Up-facing trunk/forks |
| Fill plants (optional) | sparse ferns / clover cards | Same wind |

---

## 8. Reference Implementation Notes (Metric)

Illustrative Three.js excerpts. **Every length literal is metres**; see `units.js` constants in the implementation package. Remains a sketch — production modules split skeleton / SDF / mesher / petals / grass.

```javascript
/**
 * Procedural Sakura Tree Engine
 * Modern Three.js (ES6 / WebGL2 / WebGPU-ready)
 */

import * as THREE from 'three';

/** SI helpers — 1 Three.js unit = 1 metre */
export const MM = 0.001;
export const CM = 0.01;
export const G_EARTH = new THREE.Vector3(0, -9.81, 0); // m·s⁻²
export const PETAL_LENGTH_M = 18 * MM;   // 0.018 m
export const PETAL_WIDTH_M = 14 * MM;    // 0.014 m full width
export const TREE_HEIGHT_M = 9.0;
export const CROWN_RADIUS_M = 4.0;
export const TRUNK_BASE_RADIUS_M = 0.20;
export const V_TERM_PETAL = 0.9;         // m·s⁻¹
export const WIND_AMBIENT = 1.5;         // m·s⁻¹

// ============================================================================
// 1. PARAMETRIC PETAL GEOMETRY GENERATOR (WITH APICAL NOTCH & CUPPING)
// ============================================================================

export class ParametricPetalBuilder {
  /**
   * Generates a detailed petal BufferGeometry.
   * All size inputs are metres (defaults match Prunus serrulata).
   * @returns {THREE.BufferGeometry}
   */
  static createPetalGeometry({
    length = PETAL_LENGTH_M,
    maxWidth = PETAL_WIDTH_M,
    notchDepth = 0.45,
    cleftSharpness = 0.04,
    cupIntensity = 0.12,   // fraction of length → ~2 mm cup
    curlIntensity = 0.08,
    creaseIntensity = 0.05,
    segmentsU = 8,
    segmentsV = 12
  } = {}) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    // Evaluate position using analytic shape equations
    const samplePoint = (u, v) => {
      // Lateral mapping: u in [0, 1] -> xRel in [-0.5, 0.5]
      const xRel = u - 0.5;
      
      // Normalized half-width envelope
      const baseWidth = Math.pow(v, 0.6) * Math.pow(1.0 - v, 0.45) * 2.0;
      
      // Apical notch modulation
      const distFromTip = v - 1.0;
      const notchDecay = Math.exp(-(distFromTip * distFromTip) / 0.008) * 
                         Math.exp(-(xRel * xRel) / cleftSharpness);
      const widthFactor = Math.max(0.0, baseWidth * (1.0 - notchDepth * notchDecay));
      
      // maxWidth is full lamina width in metres; half-span uses 0.5 * maxWidth
      const x = xRel * maxWidth * widthFactor;
      const y = v * length;

      // Vertical deflection in metres (intensities are fractions of length)
      const cup = -cupIntensity * length * 4.0 * (xRel * xRel) * Math.sqrt(v);
      const curl = curlIntensity * length * Math.pow(v, 2.5);
      const crease = -creaseIntensity * length * Math.abs(xRel) * (1.0 - v);
      const z = cup + curl + crease;

      return new THREE.Vector3(x, y, z);
    };

    // Construct vertex grid
    for (let iv = 0; iv <= segmentsV; iv++) {
      const v = iv / segmentsV;
      for (let iu = 0; iu <= segmentsU; iu++) {
        const u = iu / segmentsU;
        const pt = samplePoint(u, v);
        positions.push(pt.x, pt.y, pt.z);
        uvs.push(u, v);

        // Compute analytical finite-difference normals
        const delta = 0.005;
        const ptU = samplePoint(Math.min(1.0, u + delta), v);
        const ptV = samplePoint(u, Math.min(1.0, v + delta));
        
        const dU = new THREE.Vector3().subVectors(ptU, pt);
        const dV = new THREE.Vector3().subVectors(ptV, pt);
        const norm = new THREE.Vector3().crossVectors(dU, dV).normalize();
        
        // Ensure normals face the adaxial surface
        if (norm.z < 0) norm.negate();
        normals.push(norm.x, norm.y, norm.z);
      }
    }

    // Generate topology index buffer
    const stride = segmentsU + 1;
    for (let iv = 0; iv < segmentsV; iv++) {
      for (let iu = 0; iu < segmentsU; iu++) {
        const a = iv * stride + iu;
        const b = (iv + 1) * stride + iu;
        const c = (iv + 1) * stride + (iu + 1);
        const d = iv * stride + (iu + 1);

        // Double-sided index assignment
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    return geometry;
  }

  /**
   * Generates a multi-petal blossom cluster geometry.
   * @returns {THREE.BufferGeometry}
   */
  static createBlossomClusterGeometry() {
    const clusterGeom = new THREE.BufferGeometry();
    const petalBaseGeom = this.createPetalGeometry();
    
    const clusterPositions = [];
    const clusterNormals = [];
    const clusterUvs = [];
    const clusterIndices = [];
    
    let indexOffset = 0;
    const flowerCount = 4;
    const petalsPerFlower = 5;

    for (let f = 0; f < flowerCount; f++) {
      // Cluster offsets
      // Cluster offsets in metres (~10–12 cm umbel span)
      const clusterPos = new THREE.Vector3(
        (Math.random() - 0.5) * 0.10,
        (Math.random() - 0.5) * 0.06,
        (Math.random() - 0.5) * 0.10
      );

      for (let p = 0; p < petalsPerFlower; p++) {
        const angle = (p / petalsPerFlower) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
        const pitch = 0.35 + Math.random() * 0.15; // Natural outward opening tilt
        
        const euler = new THREE.Euler(pitch, 0, angle, 'ZYX');
        const rotMat = new THREE.Matrix4().makeRotationFromEuler(euler);
        
        const posAttr = petalBaseGeom.getAttribute('position');
        const normAttr = petalBaseGeom.getAttribute('normal');
        const uvAttr = petalBaseGeom.getAttribute('uv');
        const indicesArray = petalBaseGeom.getIndex().array;

        for (let i = 0; i < posAttr.count; i++) {
          const v = new THREE.Vector3().fromBufferAttribute(posAttr, i);
          const n = new THREE.Vector3().fromBufferAttribute(normAttr, i);
          
          v.applyMatrix4(rotMat).add(clusterPos);
          n.applyMatrix4(rotMat).normalize();

          clusterPositions.push(v.x, v.y, v.z);
          clusterNormals.push(n.x, n.y, n.z);
          clusterUvs.push(uvAttr.getX(i), uvAttr.getY(i));
        }

        for (let i = 0; i < indicesArray.length; i++) {
          clusterIndices.push(indicesArray[i] + indexOffset);
        }
        indexOffset += posAttr.count;
      }
    }

    clusterGeom.setAttribute('position', new THREE.Float32BufferAttribute(clusterPositions, 3));
    clusterGeom.setAttribute('normal', new THREE.Float32BufferAttribute(clusterNormals, 3));
    clusterGeom.setAttribute('uv', new THREE.Float32BufferAttribute(clusterUvs, 2));
    clusterGeom.setIndex(clusterIndices);

    return clusterGeom;
  }
}

// ============================================================================
// 2. PROCEDURAL SHADERS & MATERIALS
// ============================================================================

export class SakuraMaterialFactory {
  /**
   * PBR Cherry Blossom Shader with Subsurface Scattering and Radial Normal Blending.
   */
  static createBlossomMaterial() {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffd5e5),
      roughness: 0.35,
      metalness: 0.02,
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: 0.1
    });

    material.userData.uniforms = {
      uTime: { value: 0 },
      uWindStrength: { value: 0.4 },
      uWindDirection: { value: new THREE.Vector3(1.0, 0.2, 0.5).normalize() },
      uSubsurfaceColor: { value: new THREE.Color(0xff4d79) }
    };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = material.userData.uniforms.uTime;
      shader.uniforms.uWindStrength = material.userData.uniforms.uWindStrength;
      shader.uniforms.uWindDirection = material.userData.uniforms.uWindDirection;
      shader.uniforms.uSubsurfaceColor = material.userData.uniforms.uSubsurfaceColor;

      // Inject custom attributes and wind displacement
      shader.vertexShader = `
        attribute vec3 aClusterCenter;
        attribute float aInstancePhase;
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec3 uWindDirection;
        varying vec3 vWorldNormal;
        varying vec3 vViewVec;
        ${shader.vertexShader}
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>

        // Procedural multi-frequency branch and petal flutter
        float flutter = sin(uTime * 4.0 + aInstancePhase + transformed.x * 12.0) * 
                        cos(uTime * 2.5 + transformed.y * 8.0);
        
        // Wind displacement in metres (~1–3 cm petal flutter)
        vec3 windOffset = uWindDirection * (flutter * 0.012 * uWindStrength);
        transformed += windOffset;

        // Radial normal blending
        vec3 macroNormal = normalize(position - aClusterCenter);
        transformedNormal = normalize(mix(transformedNormal, macroNormal, 0.75));
        `
      );

      // Inject Subsurface Scattering approximation into the fragment shader
      shader.fragmentShader = `
        uniform vec3 uSubsurfaceColor;
        ${shader.fragmentShader}
      `;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>

        // Forward-scatter light transmission
        vec3 lightDir = normalize(vec3(5.0, 10.0, 7.5));
        float forwardSSS = pow(max(0.0, dot(-vViewPosition, lightDir)), 3.0) * 0.65;
        gl_FragColor.rgb += uSubsurfaceColor * forwardSSS;
        `
      );
    };

    return material;
  }
}

// ============================================================================
// 3. FALLING PETALS SYSTEM: DUAL-MODE PHYSICS CORE (BOIDS & CURL NOISE)
// ============================================================================

export class FallingPetalDriftSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {number} count Petal instance count
   * @param {Object} bounds Simulation AABB size in metres {x,y,z}
   */
  constructor(scene, count = 3000, bounds = { x: 20, y: TREE_HEIGHT_M + 1, z: 20 }) {
    this.count = count;
    this.bounds = bounds; // metres
    this.mode = 'BOIDS'; // Options: 'CURL_NOISE' | 'BOIDS'
    this.gravity = G_EARTH.clone(); // m·s⁻²
    this.vTerm = V_TERM_PETAL;      // m·s⁻¹
    this.windAmbient = new THREE.Vector3(WIND_AMBIENT, 0, 0.2);

    // Falling petals use the same real lamina size (LOD: fewer segments)
    this.geometry = ParametricPetalBuilder.createPetalGeometry({
      length: PETAL_LENGTH_M,
      maxWidth: PETAL_WIDTH_M,
      segmentsU: 4,
      segmentsV: 6
    });

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffbccc,
      roughness: 0.4,
      side: THREE.DoubleSide
    });

    this.instancedMesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Dynamic state arrays
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.rotations = new Float32Array(count * 3);
    this.rotVelocities = new Float32Array(count * 3);

    this.dummy = new THREE.Object3D();
    this.initParticles();
    scene.add(this.instancedMesh);
  }

  initParticles() {
    for (let i = 0; i < this.count; i++) {
      this.resetParticle(i, true);
    }
  }

  resetParticle(i, randomY = false) {
    const i3 = i * 3;
    // Positions in metres within the park / canopy AABB
    this.positions[i3] = (Math.random() - 0.5) * this.bounds.x;
    this.positions[i3 + 1] = randomY ? Math.random() * this.bounds.y : this.bounds.y;
    this.positions[i3 + 2] = (Math.random() - 0.5) * this.bounds.z;

    // Velocities in m·s⁻¹
    this.velocities[i3] = (Math.random() - 0.5) * 0.4 + this.windAmbient.x * 0.3;
    this.velocities[i3 + 1] = -this.vTerm * (0.5 + Math.random() * 0.5);
    this.velocities[i3 + 2] = (Math.random() - 0.5) * 0.4 + this.windAmbient.z * 0.3;

    this.rotations[i3] = Math.random() * Math.PI * 2;
    this.rotations[i3 + 1] = Math.random() * Math.PI * 2;
    this.rotations[i3 + 2] = Math.random() * Math.PI * 2;

    // Angular velocity in rad·s⁻¹
    this.rotVelocities[i3] = (Math.random() - 0.5) * 4.0;
    this.rotVelocities[i3 + 1] = (Math.random() - 0.5) * 4.0;
    this.rotVelocities[i3 + 2] = (Math.random() - 0.5) * 4.0;
  }

  /** Quadratic drag toward terminal speed (frame-rate independent). */
  applyDrag(i3, dt) {
    const vx = this.velocities[i3];
    const vy = this.velocities[i3 + 1];
    const vz = this.velocities[i3 + 2];
    const spd = Math.hypot(vx, vy, vz) + 1e-6;
    // a_drag ≈ -g * (v / v_term)^2 along velocity when near terminal
    const kd = 9.81 / (this.vTerm * this.vTerm);
    const scale = kd * spd * dt;
    this.velocities[i3] -= vx * scale;
    this.velocities[i3 + 1] -= vy * scale;
    this.velocities[i3 + 2] -= vz * scale;
  }

  /**
   * Computes an analytical 3D curl field.
   */
  /** Returns a divergence-free velocity kick in m·s⁻¹ (scaled). */
  computeCurl(x, y, z, time) {
    const eps = 0.15;           // finite-diff step (m)
    const spatialFreq = 0.35;   // rad·m⁻¹ — ~18 m wavelength eddies
    const amp = 0.35;           // m·s⁻¹ curl magnitude

    const p = spatialFreq;
    const n1 = Math.sin((y + time) * p) + Math.cos((z - time) * p);
    const n2 = Math.sin((z + time) * p) + Math.cos((x - time) * p);
    const n3 = Math.sin((x + time) * p) + Math.cos((y - time) * p);

    return new THREE.Vector3(
      (n3 - n2) / eps * amp * eps,
      (n1 - n3) / eps * amp * eps * 0.35,
      (n2 - n1) / eps * amp * eps
    );
  }

  /**
   * Advances the physics simulation.
   * @param {number} delta Frame delta time
   * @param {number} time Global elapsed time
   */
  update(delta, time) {
    const i3Max = this.count * 3;
    const boidsRange = 0.45; // metres
    const boidsRangeSq = boidsRange * boidsRange;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;

      // Gravity (m·s⁻²) × Δt (s) → Δv (m·s⁻¹)
      this.velocities[i3 + 1] += this.gravity.y * delta;

      if (this.mode === 'CURL_NOISE') {
        const curl = this.computeCurl(
          this.positions[i3], 
          this.positions[i3 + 1], 
          this.positions[i3 + 2], 
          time
        );
        // curl returns m·s⁻¹ perturbation field sampled as acceleration proxy
        this.velocities[i3] += curl.x;
        this.velocities[i3 + 1] += curl.y;
        this.velocities[i3 + 2] += curl.z;

      } else if (this.mode === 'BOIDS') {
        // Local neighborhood aggregation
        let neighborCount = 0;
        let avgVelX = 0, avgVelY = 0, avgVelZ = 0;
        let sepX = 0, sepY = 0, sepZ = 0;

        // Sample nearby particles within a fixed stride window
        const sampleStep = 6;
        for (let j = 0; j < this.count; j += sampleStep) {
          if (i === j) continue;
          const j3 = j * 3;
          const dx = this.positions[i3] - this.positions[j3];
          const dy = this.positions[i3 + 1] - this.positions[j3 + 1];
          const dz = this.positions[i3 + 2] - this.positions[j3 + 2];
          const distSq = dx * dx + dy * dy + dz * dz;

          if (distSq < boidsRangeSq && distSq > 0.0001) {
            neighborCount++;
            avgVelX += this.velocities[j3];
            avgVelY += this.velocities[j3 + 1];
            avgVelZ += this.velocities[j3 + 2];

            const invDist = 1.0 / distSq;
            sepX += dx * invDist;
            sepY += dy * invDist;
            sepZ += dz * invDist;
          }
        }

        if (neighborCount > 0) {
          const invN = 1.0 / neighborCount;
          // Apply flocking forces: alignment and separation
          this.velocities[i3] += (avgVelX * invN - this.velocities[i3]) * 0.15 * delta;
          this.velocities[i3 + 2] += (avgVelZ * invN - this.velocities[i3 + 2]) * 0.15 * delta;

          this.velocities[i3] += sepX * 0.08 * delta;
          this.velocities[i3 + 2] += sepZ * 0.08 * delta;
        }

      }

      this.applyDrag(i3, delta);

      // Soft clamps in m·s⁻¹ (gust + fall)
      this.velocities[i3] = THREE.MathUtils.clamp(this.velocities[i3], -5.0, 5.0);
      this.velocities[i3 + 1] = THREE.MathUtils.clamp(this.velocities[i3 + 1], -2.5, 1.0);
      this.velocities[i3 + 2] = THREE.MathUtils.clamp(this.velocities[i3 + 2], -5.0, 5.0);

      // Integrate position (m) and orientation (rad)
      this.positions[i3] += this.velocities[i3] * delta;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * delta;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * delta;

      this.rotations[i3] += this.rotVelocities[i3] * delta;
      this.rotations[i3 + 1] += this.rotVelocities[i3 + 1] * delta;
      this.rotations[i3 + 2] += this.rotVelocities[i3 + 2] * delta;

      // Ground plane y = 0 m
      if (this.positions[i3 + 1] <= 0.0) {
        this.resetParticle(i, false);
      }

      // Update instance transform
      this.dummy.position.set(this.positions[i3], this.positions[i3 + 1], this.positions[i3 + 2]);
      this.dummy.rotation.set(this.rotations[i3], this.rotations[i3 + 1], this.rotations[i3 + 2]);
      this.dummy.updateMatrix();

      this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }
}

// ============================================================================
// 4. MAIN ORCHESTRATOR & GENERATION PIPELINE
// ============================================================================

export class ProceduralSakuraEngine {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.clock = new THREE.Clock();

    this.initEnvironment();
    this.buildTree();
    this.initPetalDrift();
  }

  initEnvironment() {
    const hemiLight = new THREE.HemisphereLight(0xfff0f5, 0x332222, 0.85);
    this.scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff5ea, 1.6);
    // Direction only — offsets in metres for shadow camera framing (~tree scale)
    sunLight.position.set(15, 25, 10);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 60;      // m
    sunLight.shadow.camera.left = -12;   // m
    sunLight.shadow.camera.right = 12;
    sunLight.shadow.camera.top = 12;
    sunLight.shadow.camera.bottom = -12;
    sunLight.shadow.bias = -0.0001;
    this.scene.add(sunLight);
  }

  buildTree() {
    // 1. Placeholder bole ONLY until SDF→mesh bake lands.
    //    Radii and height are real metres for Prunus serrulata (§0.2).
    const boleHeight = 2.0; // m to first fork
    const trunkGeom = new THREE.CylinderGeometry(
      0.14,                    // radius at DBH-ish top of bole (m)
      TRUNK_BASE_RADIUS_M,     // 0.20 m base flare
      boleHeight,
      24,
      16
    );
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x2d2426,
      roughness: 0.9,
      metalness: 0.05
    });
    const trunk = new THREE.Mesh(trunkGeom, trunkMat);
    trunk.position.y = boleHeight * 0.5;
    trunk.castShadow = true;
    this.scene.add(trunk);
    // Production: replace with BarkVolumeMesher.bake(skeleton) → BufferGeometry

    // 2. Generate instanced canopy (cluster meshes already in metres)
    const clusterGeom = ParametricPetalBuilder.createBlossomClusterGeometry();
    const clusterMat = SakuraMaterialFactory.createBlossomMaterial();
    this.blossomMaterial = clusterMat;

    const clusterCount = 4000;
    this.canopyInstancedMesh = new THREE.InstancedMesh(clusterGeom, clusterMat, clusterCount);
    this.canopyInstancedMesh.castShadow = true;

    // Anchor clusters in crown envelope (metres): fork 2 m → tip 9 m, R ≤ 4 m
    const dummy = new THREE.Object3D();
    const clusterCenters = new Float32Array(clusterCount * 3);
    const instancePhases = new Float32Array(clusterCount);
    const yFork = 2.0;
    const H = TREE_HEIGHT_M;
    const R = CROWN_RADIUS_M;

    for (let i = 0; i < clusterCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const y = yFork + Math.random() * (H - yFork);
      const radiusMax = R * Math.sqrt(Math.max(0, (y - yFork) / (H - yFork))) * (1.15 - 0.35 * ((y - yFork) / (H - yFork)));
      const radius = Math.random() * radiusMax;

      const x = Math.cos(theta) * radius + (Math.random() - 0.5) * 0.2;
      const z = Math.sin(theta) * radius + (Math.random() - 0.5) * 0.2;

      dummy.position.set(x, y, z);
      dummy.rotation.set(
        Math.random() * 0.4,
        Math.random() * Math.PI * 2,
        Math.random() * 0.4
      );
      dummy.scale.setScalar(0.85 + Math.random() * 0.3); // ~±15% size jitter
      dummy.updateMatrix();

      this.canopyInstancedMesh.setMatrixAt(i, dummy.matrix);

      clusterCenters[i * 3] = x;
      clusterCenters[i * 3 + 1] = y;
      clusterCenters[i * 3 + 2] = z;
      instancePhases[i] = Math.random() * Math.PI * 2;
    }

    // Assign custom instanced canopy attributes
    clusterGeom.setAttribute(
      'aClusterCenter',
      new THREE.InstancedBufferAttribute(clusterCenters, 3)
    );
    clusterGeom.setAttribute(
      'aInstancePhase',
      new THREE.InstancedBufferAttribute(instancePhases, 1)
    );

    this.scene.add(this.canopyInstancedMesh);
  }

  initPetalDrift() {
    this.petalSystem = new FallingPetalDriftSystem(this.scene, 3500);
  }

  /**
   * Engine loop entry point.
   */
  tick() {
    const delta = this.clock.getDelta();
    const time = this.clock.getElapsedTime();

    if (this.blossomMaterial?.userData?.uniforms) {
      this.blossomMaterial.userData.uniforms.uTime.value = time;
    }

    if (this.petalSystem) {
      this.petalSystem.update(delta, time);
    }
  }
}
```