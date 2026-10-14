# 世界图志 · 世界观时间轴工具

> 基于 **Three.js + Vite** 的架空世界构建工具：把自己设计的平面地图或**真实地球地形**贴上球体，用**时间点**组织世界的演变（沧海桑田），在球面上按经纬度放置**条目 / 路线 / 势力区域**，还能用**地形工坊**像画等高线图一样捏出自己的山川河流。
> 地球只是一个示例世界——它可以是任何世界。
>
> **文档体系**：本 README 分为「架构介绍」与「版本迭代记录」两部分；配套文档见 [`docs/README.md`](docs/README.md)（更新规则）、[`docs/ADR.md`](docs/ADR.md)（重大决策）、[`docs/DESIGN.md`](docs/DESIGN.md)（当前阶段方案）、[`docs/TEMP.md`](docs/TEMP.md)（临时需求）。所有文档遵循「**区域顶部插入**」更新策略，最新内容始终在顶部。

---

## 第一部分 · 架构介绍

### 1. 技术栈与快速开始

- **技术栈**：Three.js `^0.186.1` + Vite `^8.3.4` + React `^19.3.0` + Zustand `^5.0.15`；原生 JavaScript（ESM，非 TypeScript）。
- **前端框架**：React + Zustand，仅接管 UI 层与状态层（`core/`、`view/` 不进框架）；构建产物相对路径，可静态部署。
- **命令**：`npm install` / `npm run dev`（http://localhost:5173）/ `npm run build`（dist/）。
- **验证脚本**（`scripts/`，依赖本机 Edge + 已启动 dev server）：`node scripts/verify-terrain.mjs`（地形端到端）、`node scripts/ui-test.mjs`（UI 交互）、`node scripts/shot.mjs`（截图）。
- **编程入口**：浏览器控制台 `window.world`（由 `src/api.js#installAPI` 挂载），提供 `help()/loadSample()/setTime()/generateRealEarth()/openWorkshop()/paintTerrain()/sampleTerrain()/importCities()/addEntry()/flyTo()/where()/resetView()` 等。

### 2. 核心概念

- **世界项目** = 时间点序列 + 底图（图片 / 栅格地形）+ 内容（条目/路线/区域），整体是一个可 JSON 序列化的对象（`src/core/project.js#createProject`）。
- **时间点（切面）**：手工定义的有序节点；每个时间点可绑定自己的地形快照——大陆漂移、沧海桑田就是切换时间点。底图沿时间轴向上继承（`project.js#mapAt/rasterAt`）。每个时间点还可以挂一张**配图**（`image` 字段，做法与条目配图完全一致）：它是这个时代的资料图（手稿、势力图、插画……），与「贴到球面上的底图」是两回事，渲染管线完全不读它，只随项目一起存与导出。在世界概览里上传与移除。
- **内容生命周期**：每条内容有「出现于 / 消失于」（`from/to` 时间点 id，留空 = 自始/至今），可见性判定唯一位置 `project.js#isActiveAt`（闭区间 `from <= index <= to`）。
- **栅格地形**：等距圆柱投影高度网格（默认 512×256，可升 1024×512）+ 河流通路；高度用归一化单位（0=海平面，[-4,4] 设计范围）。渲染成「色带 + hillshade」贴图，**GPU 顶点位移让山从球面上真正隆起**。
- **海陆掩膜（可选）**：一张二值「是陆是海」的图（`core/landmask.js`），只回答海陆判定，不参与高度。**不是强制规则**——自定义世界可以没有它，没有时按高度正负判海陆，与旧行为一致；真实地球预设自带一份 `public/textures/earth-water.png`，用来把低海拔城市从海里捞回来。
- **地形工坊**：全屏栅格画笔（抬升/降低/抹平/河流，硬笔/软笔），笔刷最小可到**一格**，每笔实时反映到球体；画布支持滚轮缩放与拖动平移；撤销/重做；一键从真实地球生成。

### 3. 分层架构

```
src/
  main.js          组装、编辑模式状态机（browse/add-entry/draw-route/draw-region）、
                  鼠标键盘交互、渲染循环（renderer.setAnimationLoop）
  config.js        画面设置（视角/光照/大气/星空/地形夸张/标注），localStorage 持久化
  utils.js         经纬度↔三维坐标、大圆弧插值、TweenManager 补间动画
  utils/files.js   浏览器文件操作：loadImage（栅格与海陆掩膜各自取用，互不依赖）
  api.js           window.world 编程接口（自动化/未来后端驱动入口）
  store/           状态层（Zustand，唯一状态源，全部可序列化）
    ui.js          交互态：编辑模式、选中、绘制中数据、草稿、浮层开关、提示条、工坊缩放读数、
                   layoutEpoch/touchLayout（「只有地形变了」信号，区别于内容变化）
    world.js       世界数据：project + 当前切面 + derived 派生快照（内容信号）+ mutateProject 写入收口
    view.js        画面设置：viewConfig 与 setViewConfig/applyView
    actions.js     复合动作：新建/载入/导出、飞行/复位视角、工坊、地形生成、示例世界、文件导入
  session.js       非序列化运行态：renderer/scene/相机/图层、当前网格、栅格解码缓存、
                   自动保存器、切面应用的竞态令牌（eraToken）与幂等记录（appliedEra）
  bridge.js        store → 三维的单向同步：订阅 derived/切面/选中，重建图层、应用切面、切面底图预解
  core/            数据核心层（纯数据/纯算法，不依赖 three）
    project.js     数据模型：时间点（含配图）/图片底图/栅格底图/条目/路线/区域 + 切面可见性
    raster.js      TerrainGrid：画笔（最小 1 格）/色带/hillshade/采样/重采样/PNG 编解码。只管「多高」
    landmask.js    LandMask：二值海陆场 + 离岸距离（倒角距离变换）。只管「是陆是海」，可选
    realearth.js   真实地球：高程图 + 海陆掩膜合成、河流栅格化、城市导入
    storage.js     IndexedDB 持久化 + 防抖自动保存 + .world.json 导出/导入
    sample.js      示例世界（真实地形 + 亚特兰蒂斯剧情）
  view/            3D 视图层（引擎封装边界，对外只暴露业务语义方法）
    render-layers.js  渲染趟次编号：场景 / 深度掩膜 / 内容（见「一帧三趟」）
    material-bin.js   材质回收桶：整层重建时复用材质，避免 GL 程序被连坐销毁
    globe.js       球体：GPU 高度位移 + 法线扰动 shader、深度掩膜球、大气辉光、星空、光照
    markers.js     条目标注层（Sprite，贴地 + 背面剔除拾取）
    routes.js      路线层（大圆弧细分 + Line2 像素宽度）
    regions.js     区域层（earcut 剖分 + 球面递归细分防弦陷）
    camera.js      自由翻滚相机：四元数 trackball 管旋转、OrbitControls 只管缩放，
                   + flyTo 球面飞行、resetView 复位视角
  ui/              UI 层（React）
    react/         五个面板组件 + mount.js（每面板一个 root）+ hooks.js（订阅派生信号）
      Toolbar / Timeline / Inspector / SettingsPanel / Workshop + panels/（检查器各子表单）
    registry.js    面板挂载表：容器 id → 组件
    workshop-session.js  工坊会话：网格、撤销/重做栈、指针涂抹、画布视图（缩放/平移）
                         （大 buffer 不进 store）
scripts/           headless Edge 端到端验证（verify-terrain / ui-test / shot）
public/            静态资源：data/*.geojson（河流/城市）、textures/earth-topology.png（高程）、
                   textures/earth-water.png（海陆掩膜）
```

依赖方向：`main → ui/store/bridge/view/core`，`ui → store`，`bridge → store/view/core`，`view → utils/core`，`core → 无（raster 不依赖 three）`。反向依赖仅两处：main 组装期把 `globe.group` 注入图层、globe 消费 raster 的画布。

### 4. 关键机制（架构要点）

- **GPU 地形位移**：`view/globe.js#_buildSphere` 在 `MeshPhongMaterial.onBeforeCompile` 注入顶点着色器——高度纹理（R+G 打包 16-bit）按 `NearestFilter` 采样，`transformed += normalize(position) * unpackHeight(texture2D(uHeightTex, uv).rg) * uExaggeration`；法线用高度场邻域差分扰动。位移只在 GPU，射线拾取对逻辑球面（未位移的 `globe.sphere`），放置内容天然自洽。
- **贴图对准**：`utils.js#latLngToVec3` 与 `SphereGeometry` 的 UV 展开一致。
- **球面弦陷防护**：区域按边长 ≤2° 递归四分割（`view/regions.js#pushSubdivided`，深度上限 6），路线走大圆弧 slerp 细分（`view/routes.js#arcPositions`，≤2°/段）。
- **背面剔除拾取**：`view/markers.js#pick` 按 `dot(标注方向, 相机方向) > 1/相机距离 + 0.02` 过滤地平线以下。
- **自由翻滚的相机**（`view/camera.js`）：OrbitControls 的球坐标把 `phi` 从相机位置 `acos` 出来，恒落在 `[0, π]`，绕极点时被夹住——这是表示法的限制，参数怎么调都过不去。所以旋转改由自己用四元数做 trackball：拖动时按「屏幕右 / 屏幕上」两个轴构造四元数，**同时**乘到相机的位置与 `up` 上。相机永远看原点、且 `up ⊥ 视线`，两者同步旋转后这个关系不变（OrbitControls 自己的坐标系里 `phi` 恒为 π/2，它的往返换算仍然精确），于是可以越过南北极、把地平线转歪。缩放仍交给 OrbitControls——距离计算与朝向无关，没必要重写。自转也改为绕世界 Y 轴（南北极）而非相机上方向：翻过球之后两者不一致，用后者会变成绕屏幕竖线打转。转晕了用 🧭 复位视角 / `world.resetView()` 回到正北朝上。
- **工坊画布视图**（`ui/workshop-session.js`）：画布按「一格一 CSS 像素」写死尺寸，缩放平移全走 CSS `transform: translate() scale()`，**不动画布分辨率**——改分辨率等于重采样，图会糊。缩放锚点直接用画布自己的 `getBoundingClientRect()` 算：它返回的是**变换后**的矩形，于是 `toGrid` 那条「屏幕坐标 → 网格坐标」的换算在任意缩放下自动成立，不必手写变换的逆。
- **栅格存储**：整张地形编码为一张 PNG（`core/raster.js#encodePNG`：R+G=16-bit 高度 [-4,4]，B=河流），IndexedDB 单条记录 500ms 防抖自动保存，导出为内嵌图片的单文件 `.world.json`（`core/storage.js`）。
- **数据驱动渲染（两级信号）**：store 里刻意区分两种变化——「内容变了」（增删改条目/路线/区域、切时间点）与「只是地形变了」（工坊画笔、`paintTerrain`）。
  - 前者 → `bridge.js#refreshLayers()` 从 `P.activeItems` 全量重建三层；
  - 后者 → `bridge.js#relayoutLayers()` 只把已有对象重新贴回新的地表高度，`derived` 快照与 50 张标注贴图一概不动。
  - 两级信号落在两个字段上：`store/world.js#derived`（内容）与 `store/ui.js#layoutEpoch`（地形），`bridge.js` 各订阅一个。
  - `bridge.js#applyEra()` 负责切面切换（含 `{project, key}` 幂等闸——一次 `setTime` 只应用一遍；`session.eraToken` 异步竞态守卫；栅格解码缓存 `session.gridCache`；以及空闲时预解邻近切面底图的 `preheatEras()`）。
- **一帧三趟渲染**（`view/render-layers.js` 定义层号，`main.js#render` 按序渲染三遍）：
  1. `LAYER_SCENE` — 球体、大气辉光、星空，正常写颜色与深度；
  2. `LAYER_MASK` — 与球面同半径的光滑球（`globe.js#_buildOverlayMask`，`colorWrite: false`），只写深度。渲染前 `clearDepth()`，于是它盖掉的是一张「没有山、只有球」的理想深度图；
  3. `LAYER_CONTENT` — 条目/路线/区域贴着这张深度图做测试。
  这样山挡不住内容（掩膜球没有隆起），而转到球背面仍会被正确遮挡（球体本身还在）。
- **材质回收桶**（`view/material-bin.js`）：three 用引用计数管 GL 程序，整层重建时若把旧材质 `dispose()` 掉，程序会跟着销毁、下一帧重新编译链接（实测一次切面切换 275ms）。桶把退下来的材质留下来复用，程序就一直在。图层重建路径上必须走它。
- **状态与视图分离**：UI 状态全在 `store/` 里（可序列化），three 对象与 `TerrainGrid` 等大 buffer 在 `session.js`；`bridge.js` 单向订阅 store 驱动三维，React 组件单向订阅 store 渲染自己，两边不互查 DOM。

### 5. 数据来源

| 数据 | 来源 | 位置 |
|---|---|---|
| 高程预设 `earth-topology.png` | 运行时 fetch 本地静态文件 | `core/realearth.js#loadElevation` |
| 海陆掩膜 `earth-water.png` | 运行时 fetch 本地静态文件 | `core/landmask.js#fromImage`（由 `core/realearth.js#buildRealEarthGrid` 调用） |
| 河流 `ne_50m_rivers.geojson` | 运行时 fetch 本地静态文件 | `core/realearth.js#rasterizeRivers` |
| 城市 `ne_110m_populated_places.geojson` | 运行时 fetch 本地静态文件 | `core/realearth.js#importCitiesAsEntries` |
| 示例世界剧情 | 硬编码 | `core/sample.js#buildSampleProject` |
| 画面设置 | localStorage | `config.js#loadViewConfig/saveViewConfig` |
| 项目持久化 | IndexedDB | `core/storage.js#idbPut/idbGet/createAutoSaver` |

**现状**：无后端 HTTP 请求、无 WebSocket/SSE/轮询；后端接入为后续版本目标。

### 6. 已知限制

- 高程预设仍用 8-bit 陆地 bump 图：陆地海拔精度有限，海洋深浅由「离岸距离」推导（大陆架坡度是算出来的，不是测出来的）。要真实测深得换 16-bit ETOPO，未来可升级——`core/raster.js` 只管高度，换数据源不牵动海陆掩膜与渲染。
- 河流是画笔通路，不随坡向汇流（D8 算法待做）。
- 跨 ±180° 勾画的区域三角剖分可能出错（`buildFillGeometry` 未拆线；`buildBorderGeometry` 已按短弧处理）。
- 底图切换为硬切（交叉淡化待做）。
- 无单元测试框架（仅 scripts/ 三个 E2E）；`main.js#main` 仍是约 300 行的组装函数（UI 与状态已外移，剩下渲染基础、鼠标键盘交互与启动）。

---

## 第二部分 · 版本迭代记录

> 更新规则：**新版本条目插入本列表顶部**（最新在上），保持「从头检索先见最新」。历史条目只追加不改。

### v0.0.3 工坊视口、时代插图与自由翻滚（2026-10-13）

1. **笔刷可以小到一格**：工坊画笔下限由 2 格放到 1 格。1 格不能沿用原来「距离 ≤ 半径」的判据——正交四邻的距离恰好也等于整数 1，会被一并圈进来，落成一个十字形的 5 格；改成 `radius <= 1` 时只命中指针所在的那一格（`core/raster.js#applyBrush`）。
2. **工坊画布可滚轮缩放与拖动平移**（`ui/workshop-session.js`）：滚轮以光标为锚点缩放（光标底下那一格保持不动），中键 / 右键 / Shift+左键拖动平移，顶栏加缩放读数与「⤢ 适应窗口」。画布不再靠 `object-fit: contain` 铺满，改为原尺寸 + CSS `transform`，缩放倍数 1×（适应窗口）到 32×；外层新增 `.wk-stage` 负责裁切，`ResizeObserver` 在窗口变化时重算适应比例并让容器中心那一格留在原地。
3. **时间点可挂一张配图**（`core/project.js` 的 `image` 字段）：做法与**条目配图完全一致**——世界概览里一个「⬆ 上传配图」，有图则显示图片与「移除配图」。配图属于时代，跟着切面走；它与「贴到球面上的底图」是两回事，渲染管线完全不读它，随项目一起保存与导出。
4. **相机可以任意方向翻滚**（`view/camera.js`）：原先的轨道相机受 OrbitControls 球坐标限制——`phi` 由 `acos` 导出、恒在 `[0, π]`，到极点就被夹死（实测从 88° 出发连续五次同向拖拽都停在 90.000）。改为自己用四元数做 trackball，拖动时同时旋转相机位置与 `up`，于是能越过南北极、把地平线转歪；缩放仍交给 OrbitControls。自转改为绕世界 Y 轴（南北极）而非相机上方向，`main.js` 传入真实秒数使帧率高低转速一致。新增 🧭 复位视角（`world.resetView()`）。
5. **项目菜单移除「导入真实城市」**：下拉菜单不再暴露这一项；`world.importCities()` 与时间点编辑器里的导入按钮保持不变。
6. **验收**：`scripts/verify-terrain.mjs` 与 `scripts/ui-test.mjs` 全绿、无运行时报错；`npm run build` 通过。

### v0.0.2 海陆掩膜与三处卡顿修复（2026-10-13）

1. **新增可选的海陆掩膜** `core/landmask.js` + `public/textures/earth-water.png`：二值「是陆是海」场（外扩 1 格抹掉图上的细河线、保住沿海城市），另提供 `distanceToLand()` 倒角距离变换，供海洋深浅推导使用。
2. **高程与海陆解耦**：`core/raster.js` 只管「多高」，`core/landmask.js` 只管「是陆是海」，两者互不认识；`core/realearth.js` 才把它们拼起来。掩膜是**可选的**——自定义世界不必有它，没有掩膜时按高度正负判海陆，与旧行为一致。不再为了真实厚度升级整个高程系统，现有视觉立体效果原样保留。
3. **修复城条目落水**：原实现用高程图亮度配 `seaLevel=0.04` 判海陆，上海 / 开罗 / 伦敦这类低海拔城市（源图上是纯黑像素）全部被判成海洋。改由掩膜裁定后，示例世界 50 个条目**全部落在陆地上**（改前 38 个在水里）。
4. **修复时代切换卡顿**：真根因是着色器被反复重新编译——three 用引用计数管 GL 程序，整层重建时把旧材质 `dispose()` 会让程序一起销毁，下一帧又得重新编译链接（实测单次 `getProgramInfoLog` 275ms）。新增 `view/material-bin.js`，退下来的材质进桶复用；`view/globe.js` 换底图不再置 `sphereMat.needsUpdate`；`bridge.js#applyEra` 加 `{project, key}` 幂等闸（一次 `setTime` 原会触发 2–3 遍）；另加 `bridge.js#preheatEras` 在空闲时预解别的时间点的底图。改后：切换那一帧**主线程长任务为 0**（改前每切一次 1 个 100ms+ 长任务）。
5. **修复地形编辑卡顿**：工坊画笔与 `world.paintTerrain()` 都不再全量重建图层，改为只重定位（`bridge.js#relayoutLayers`，store 侧新增 `layoutEpoch/touchLayout` 区分「内容变了」与「只是地形变了」）。`paintTerrain` 也不再走 `mutateProject`（它会连带重建 `derived` → 50 张标注贴图全部重画），并按画笔返回的脏区重绘色带而非整张全量。改后：工坊画布拖 30 点长帧 0（改前 32 个，最长 158ms）；脚本接口刷 30 笔长任务 870ms → ~200ms（剩下的是 PNG 编码与纹理上传本身）。
6. **修复条目/路线被地形挡住**：改为一帧三趟渲染（`view/render-layers.js` 定义 `LAYER_SCENE / LAYER_MASK / LAYER_CONTENT`）：① 球体/大气/星空 → ② 半径 1 的光滑球只写深度不写颜色 → ③ 条目/路线/区域对着②的深度做测试。于是山挡不住内容，转到球背面仍会被正确挡住（正面可见 29 个全部可拾取、背面 21 个一个都拾不到）。
7. 顺带修复示例世界「亚特兰蒂斯高地」跑到南半球：`core/sample.js#atCell` 用 `res` 当作纬度方向格数，实际纵向格数是横向的一半。
8. 图片读取搬到 `utils/files.js`（`loadImage`），栅格与掩膜各自取用，互不依赖。

### v0.0.1 UI 层与状态层 React 化（2026-10-13）

1. 引入 React 19 + Zustand：UI 层五个面板（顶栏 / 时间轴 / 检查器 / 画面设置 / 地形工坊）改由 React 组件渲染，每面板一个 root；`core/`、`view/` 不进框架。
2. 新增 `store/` 作为唯一状态源（分 ui / world / view / actions 四片，全部可 `JSON.stringify`），原先散在 `main.js#state` 与各面板闭包里的状态集中于此。
3. 新增 `session.js` 隔离非序列化运行态（renderer / 相机 / 图层 / 当前网格 / 解码缓存），`ui/workshop-session.js` 隔离工坊的网格与撤销栈等大 buffer。
4. 新增 `bridge.js` 承担 store → 三维的单向同步（重建图层、应用切面、绘制预览），删去原「数据一变就全量重绘面板」的 `renderUI()` 与其变更信号。
5. 画面设置去掉 lil-gui：14 项控制器以 React 重写，滑块/勾选/取色等效，星星数量保持「松手才提交」。
6. 检查器六个子表单重写：输入改非受控 + 换对象时 `key` 重挂载，保住连打不丢焦点与草稿不丢；绘制提交不再查 DOM 点按钮，改为直接调 store 动作。
7. 工坊外壳 React 化，画笔、撤销/重做仍为命令式（逐笔直接改网格、实时反映球面），撤销/重做按钮按可用态置灰。
8. 对外行为不变：`window.world` 的 18 个方法逐方法保持原有签名与效果，`#workshop .btn-primary`、`.mode-btn`、`.tl-chip` 等 E2E 依赖的 DOM 契约冻结不动。
9. 顺带修复绘制路径上三个既有缺陷：进入绘制模式抛错致检查器空白、「完成」按钮恒禁用使路线/区域无法提交、画出的区域名称永远丢失（表单以 `title` 提交而区域字段是 `name`）。

### v0.0.1 项目初版设计（2026-10-12）

1. 地图有三维展示，展示真实的山脉，河流，海洋，城市。
2. 可以直接导入预设的真实地球，并且允许编辑地形。
3. 时间轴切面：用时间点组织世界演变，底图沿时间轴继承，内容按「出现于 / 消失于」自动显隐。
4. 内容放置：条目（球面拾取 + 背面剔除）、路线（大圆弧细分）、势力区域（球面递归细分防弦陷）。
5. 地形工坊：抬升 / 降低 / 抹平 / 河流画笔（硬笔 / 软笔），每笔实时反映球面，支持撤销 / 重做。
6. 持久化：IndexedDB 防抖自动保存，支持单文件 `.world.json` 导出 / 导入。
7. 示例世界与编程入口：内置亚特兰蒂斯剧情样例，浏览器控制台 `window.world` 可编程驱动。
8. 验证脚本：三个 headless E2E（地形 / UI / 截图）。
