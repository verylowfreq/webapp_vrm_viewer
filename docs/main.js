import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";

// ---------------------------------------------------------------------------
// DOM 参照
// ---------------------------------------------------------------------------
const canvas = document.getElementById("viewer");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const pickFileBtn = document.getElementById("pickFileBtn");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loadingText");
const toolbar = document.getElementById("toolbar");
const loadAnotherBtn = document.getElementById("loadAnotherBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const toggleInfoBtn = document.getElementById("toggleInfoBtn");
const infoPanel = document.getElementById("infoPanel");
const infoBody = document.getElementById("infoBody");
const closeInfoBtn = document.getElementById("closeInfoBtn");
const errorToast = document.getElementById("errorToast");
const toggleAnimBtn = document.getElementById("toggleAnimBtn");
const animPanel = document.getElementById("animPanel");
const closeAnimBtn = document.getElementById("closeAnimBtn");
const animList = document.getElementById("animList");
const playPauseBtn = document.getElementById("playPauseBtn");
const stopAnimBtn = document.getElementById("stopAnimBtn");
const addVrmaBtn = document.getElementById("addVrmaBtn");
const vrmaInput = document.getElementById("vrmaInput");
const toggleExprBtn = document.getElementById("toggleExprBtn");
const exprPanel = document.getElementById("exprPanel");
const closeExprBtn = document.getElementById("closeExprBtn");
const exprList = document.getElementById("exprList");
const shakeSensorBtn = document.getElementById("shakeSensorBtn");

// ---------------------------------------------------------------------------
// three.js セットアップ
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(0, 1.3, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.target.set(0, 1.0, 0);

// ライト
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444455, 1.2);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(1, 2, 2);
scene.add(dirLight);

// グリッド（床の目安）
const grid = new THREE.GridHelper(10, 20, 0x3a3f4a, 0x2a2e37);
scene.add(grid);

// 現在表示中の VRM
let currentVrm = null;

// アニメーション状態
let mixer = null; // 現在の VRM 用 AnimationMixer
let currentAction = null; // 再生中の AnimationAction
let currentAnimIndex = -1; // animations 配列内で選択中のインデックス
// 読み込み済み VRMA。{ name, source: "builtin"|"user", vrmAnimation }
const animations = [];

// 手動で選択中の表情プリセット名（null = なし）
let manualExpression = null;
// VRM 既定の感情プリセット（手動切り替えの対象）
const EXPRESSION_PRESETS = [
  { name: "happy", label: "喜び" },
  { name: "angry", label: "怒り" },
  { name: "sad", label: "悲しみ" },
  { name: "relaxed", label: "リラックス" },
  { name: "surprised", label: "驚き" },
];
// 現在のモデルが持つプリセットのみ（buildExpressionList で更新）
let availableExpressions = [];

// 加速度センサー（揺れ物を揺らす）
let sensorEnabled = false;
const shakeAccel = new THREE.Vector3(); // 現在注入中の加速度（ワールド）
const gravityLowPass = new THREE.Vector3(); // 重力成分のローパス（ハイパス用）
let gravityLowPassInit = false;
// 各 joint の base 重力。Map<joint, { dir: Vector3, power: number }>
let springBaseGravity = null;
const SHAKE_GAIN = 0.08; // 加速度→外力ゲイン
const SHAKE_DECAY = 0.8; // 毎フレーム減衰
const SHAKE_CLAMP = 30; // 各軸クランプ(m/s^2)
const _shakeForce = new THREE.Vector3(); // 作業用

// ---------------------------------------------------------------------------
// リサイズ対応
// ---------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------------
// 描画ループ
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  controls.update();
  if (mixer) mixer.update(delta);
  if (currentVrm) {
    // 手動表情はアニメーションより後・描画反映(update)より前に適用して優先させる
    applyManualExpression();
    // 加速度センサーの揺れを spring bone の外力として注入（update 前）
    applyShakeToSpringBones();
    currentVrm.update(delta);
  }
  // 揺れは毎フレーム減衰させ、静止すれば自然に収まる
  if (sensorEnabled) shakeAccel.multiplyScalar(SHAKE_DECAY);
  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
// VRM ローダー
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

// VRMA 用ローダー
const vrmaLoader = new GLTFLoader();
vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

function disposeCurrentVrm() {
  if (!currentVrm) return;
  stopAnimation();
  // 旧モデルの joint 参照を握ったままにしない
  springBaseGravity = null;
  mixer = null;
  scene.remove(currentVrm.scene);
  VRMUtils.deepDispose(currentVrm.scene);
  currentVrm = null;
}

async function loadVrmFromArrayBuffer(buffer, fileSize) {
  showLoading("モデルを解析中...");
  try {
    const gltf = await loader.parseAsync(buffer, "");
    const vrm = gltf.userData.vrm;
    if (!vrm) {
      throw new Error("VRMデータが見つかりませんでした（対応していないファイルの可能性があります）");
    }

    disposeCurrentVrm();

    // パフォーマンス最適化（未使用ジョイントの削除など）
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);

    // VRM0.x は後ろ向きなので正面を向かせる
    VRMUtils.rotateVRM0(vrm);

    // フラスタムカリングによる消失を防ぐ
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    // VRMA の視線アニメーションを反映させるためのプロキシ
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = "VRMLookAtQuaternionProxy";
      vrm.scene.add(proxy);
    }

    currentVrm = vrm;
    scene.add(vrm.scene);

    // このモデル用の AnimationMixer を用意（clip はモデル依存のため作り直す）
    mixer = new THREE.AnimationMixer(vrm.scene);
    currentAction = null;
    currentAnimIndex = -1;

    frameModel(vrm.scene);
    showInfo(collectModelInfo(vrm, gltf, fileSize));
    renderAnimList();
    updateAnimControls();
    buildExpressionList();
    // センサー有効中にモデルが変わったら、新モデルの揺れ物で取り直す
    if (sensorEnabled) {
      if (getSpringJoints().length === 0) {
        disableShakeSensor();
      } else {
        snapshotSpringBase();
      }
    }
    updateShakeButton();

    dropzone.classList.add("hidden");
    toolbar.classList.remove("hidden");
    infoPanel.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    showError(err.message || "読み込みに失敗しました");
    // 何も表示されていなければドロップゾーンに戻す
    if (!currentVrm) {
      dropzone.classList.remove("hidden");
      toolbar.classList.add("hidden");
    }
  } finally {
    hideLoading();
  }
}

// 拡張子でモデル(.vrm/.glb)とアニメーション(.vrma)を振り分ける
function loadFile(file) {
  if (!file) return;
  if (/\.vrma$/i.test(file.name)) {
    loadVrmaFile(file);
    return;
  }
  showLoading("ファイルを読み込み中...");
  const reader = new FileReader();
  reader.onload = () => loadVrmFromArrayBuffer(reader.result, file.size);
  reader.onerror = () => {
    hideLoading();
    showError("ファイルの読み込みに失敗しました");
  };
  reader.readAsArrayBuffer(file);
}

// ---------------------------------------------------------------------------
// VRMA（アニメーション）
// ---------------------------------------------------------------------------
// ArrayBuffer から VRMAnimation を取り出す
async function parseVrmAnimation(buffer) {
  const gltf = await vrmaLoader.parseAsync(buffer, "");
  const vrmAnimations = gltf.userData.vrmAnimations;
  if (!vrmAnimations || vrmAnimations.length === 0) {
    throw new Error("VRMAデータが見つかりませんでした");
  }
  return vrmAnimations[0];
}

// ユーザーが選択/ドロップした .vrma を読み込んでリストに追加し、即再生する
function loadVrmaFile(file) {
  showLoading("アニメーションを読み込み中...");
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const vrmAnimation = await parseVrmAnimation(reader.result);
      const name = file.name.replace(/\.vrma$/i, "");
      animations.push({ name, source: "user", vrmAnimation });
      renderAnimList();
      animPanel.classList.remove("hidden");
      if (currentVrm) {
        playAnimation(animations.length - 1);
      } else {
        showError("アニメーションを追加しました（VRMを読み込むと再生できます）");
      }
    } catch (err) {
      console.error(err);
      showError(err.message || "VRMAの読み込みに失敗しました");
    } finally {
      hideLoading();
    }
  };
  reader.onerror = () => {
    hideLoading();
    showError("ファイルの読み込みに失敗しました");
  };
  reader.readAsArrayBuffer(file);
}

// マニフェスト(animations.json)から内蔵アニメを読み込む
async function loadBuiltinAnimations() {
  try {
    const res = await fetch("./animations/animations.json");
    if (!res.ok) return;
    const manifest = await res.json();
    for (const entry of manifest.animations || []) {
      try {
        const buf = await (await fetch(`./animations/${entry.file}`)).arrayBuffer();
        const vrmAnimation = await parseVrmAnimation(buf);
        animations.push({
          name: entry.name || entry.file,
          source: "builtin",
          vrmAnimation,
        });
      } catch (err) {
        console.warn(`アニメーションの読み込みに失敗: ${entry.file}`, err);
      }
    }
    renderAnimList();
  } catch (err) {
    console.warn("animations.json の読み込みに失敗", err);
  }
}

// 指定インデックスのアニメーションを再生する
function playAnimation(index) {
  const entry = animations[index];
  if (!entry) return;
  if (!currentVrm || !mixer) {
    showError("先にVRMモデルを読み込んでください");
    return;
  }
  const clip = createVRMAnimationClip(entry.vrmAnimation, currentVrm);
  if (currentAction) currentAction.stop();
  currentAction = mixer.clipAction(clip);
  currentAction.reset();
  currentAction.setLoop(THREE.LoopRepeat, Infinity);
  currentAction.play();
  currentAnimIndex = index;
  renderAnimList();
  updateAnimControls();
}

// 再生 / 一時停止のトグル
function togglePause() {
  if (!currentAction) return;
  currentAction.paused = !currentAction.paused;
  updateAnimControls();
}

// 停止して初期姿勢へ戻す
function stopAnimation() {
  if (currentAction) {
    currentAction.stop();
    currentAction = null;
  }
  currentAnimIndex = -1;
  if (currentVrm) {
    currentVrm.humanoid?.resetNormalizedPose?.();
    currentVrm.expressionManager?.resetValues?.();
    currentVrm.update(0);
  }
  renderAnimList();
  updateAnimControls();
}

// ---------------------------------------------------------------------------
// カメラを対象モデルに合わせる
// ---------------------------------------------------------------------------
function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let distance = Math.abs(maxDim / Math.sin(fov / 2)) * 0.6;
  distance = Math.max(distance, 1.5);

  controls.target.copy(center);
  camera.position.set(center.x, center.y + size.y * 0.05, center.z + distance);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();

  saveHomeView();
}

let homeView = null;
function saveHomeView() {
  homeView = {
    pos: camera.position.clone(),
    target: controls.target.clone(),
  };
}
function resetView() {
  if (!homeView) return;
  camera.position.copy(homeView.pos);
  controls.target.copy(homeView.target);
  controls.update();
}

// ---------------------------------------------------------------------------
// モデル基本情報の収集
// ---------------------------------------------------------------------------
// VRM の規格バージョン表記を求める。
// three-vrm では VRM1.0 は metaVersion "1"、VRM0.x は "0"。
function formatSpecVersion(meta) {
  const mv = meta.metaVersion;
  if (mv === "1" || mv === 1) return "VRM 1.0";
  if (mv === "0" || mv === 0) return "VRM 0.x";
  if (meta.specVersion) return `VRM ${meta.specVersion}`;
  return "VRM 0.x";
}

// マテリアルからテクスチャを収集する。
// 標準マテリアルは .map などの直接プロパティに、
// MToon（ShaderMaterial）は .uniforms.<name>.value にテクスチャを持つ。
function collectTextures(mat, out) {
  for (const key in mat) {
    const v = mat[key];
    if (v && v.isTexture) out.add(v);
  }
  if (mat.uniforms) {
    for (const key in mat.uniforms) {
      const v = mat.uniforms[key] && mat.uniforms[key].value;
      if (v && v.isTexture) out.add(v);
    }
  }
}

function collectModelInfo(vrm, gltf, fileSize) {
  let triangles = 0;
  let vertices = 0;
  let meshCount = 0;
  let skinnedMeshCount = 0;
  const materials = new Set();
  const textures = new Set();
  let boneCount = 0;
  let morphTargetCount = 0;

  gltf.scene.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) {
      meshCount++;
      if (obj.isSkinnedMesh) skinnedMeshCount++;

      const geom = obj.geometry;
      if (geom) {
        const pos = geom.attributes.position;
        if (pos) vertices += pos.count;
        if (geom.index) {
          triangles += geom.index.count / 3;
        } else if (pos) {
          triangles += pos.count / 3;
        }
        if (geom.morphAttributes && geom.morphAttributes.position) {
          morphTargetCount += geom.morphAttributes.position.length;
        }
      }

      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        materials.add(mat);
        collectTextures(mat, textures);
      }
    }
    if (obj.isBone) boneCount++;
  });

  const meta = vrm.meta || {};

  const info = {
    meta: {
      name: meta.name || meta.title || "(不明)",
      authors: Array.isArray(meta.authors)
        ? meta.authors.join(", ")
        : meta.author || "(不明)",
      version: meta.version || "(不明)",
      specVersion: formatSpecVersion(meta),
    },
    stats: {
      triangles: Math.round(triangles),
      vertices: vertices,
      meshes: meshCount,
      skinnedMeshes: skinnedMeshCount,
      materials: materials.size,
      textures: textures.size,
      bones: boneCount,
      morphTargets: morphTargetCount,
      fileSize: fileSize,
    },
  };
  return info;
}

// ---------------------------------------------------------------------------
// 情報パネルの描画
// ---------------------------------------------------------------------------
function fmtNum(n) {
  return n.toLocaleString("ja-JP");
}
function fmtBytes(bytes) {
  if (bytes == null) return "(不明)";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function showInfo(info) {
  const rows = [];
  const section = (title) =>
    rows.push(`<div class="info-section-title">${title}</div>`);
  const row = (k, v) =>
    rows.push(
      `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`
    );

  section("メタ情報");
  row("名前", escapeHtml(info.meta.name));
  row("作者", escapeHtml(info.meta.authors));
  row("バージョン", escapeHtml(info.meta.version));
  row("規格", escapeHtml(info.meta.specVersion));

  section("統計");
  row("ポリゴン数", fmtNum(info.stats.triangles));
  row("頂点数", fmtNum(info.stats.vertices));
  row("マテリアル数", fmtNum(info.stats.materials));
  row("テクスチャ数", fmtNum(info.stats.textures));
  row("メッシュ数", `${fmtNum(info.stats.meshes)} (スキン ${fmtNum(info.stats.skinnedMeshes)})`);
  row("ボーン数", fmtNum(info.stats.bones));
  row("モーフ数", fmtNum(info.stats.morphTargets));
  row("ファイルサイズ", fmtBytes(info.stats.fileSize));

  infoBody.innerHTML = rows.join("");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// アニメーションパネルの描画
// ---------------------------------------------------------------------------
function renderAnimList() {
  if (animations.length === 0) {
    animList.innerHTML =
      '<div class="anim-empty">アニメーションがありません。<br>.vrmaファイルを追加してください。</div>';
    return;
  }
  animList.innerHTML = animations
    .map((a, i) => {
      const active = i === currentAnimIndex ? " active" : "";
      const badge = a.source === "builtin" ? "内蔵" : "追加";
      return `<button class="anim-item${active}" data-index="${i}">
        <span class="anim-name">${escapeHtml(a.name)}</span>
        <span class="anim-badge">${badge}</span>
      </button>`;
    })
    .join("");
}

// 再生/一時停止/停止ボタンの有効状態とラベルを更新する
function updateAnimControls() {
  const hasModel = !!currentVrm;
  const isPlaying = !!currentAction;
  playPauseBtn.disabled = !hasModel || currentAnimIndex < 0;
  stopAnimBtn.disabled = !isPlaying;
  const paused = currentAction ? currentAction.paused : true;
  playPauseBtn.textContent = isPlaying && !paused ? "⏸ 一時停止" : "▶ 再生";
}

// ---------------------------------------------------------------------------
// 表情（手動プリセット切り替え）
// ---------------------------------------------------------------------------
// 現在のモデルが持つプリセットを調べてチップを描画する
function buildExpressionList() {
  manualExpression = null;
  availableExpressions = [];
  const em = currentVrm && currentVrm.expressionManager;
  if (em) {
    availableExpressions = EXPRESSION_PRESETS.filter((p) =>
      em.getExpression(p.name)
    );
  }
  renderExprChips();
}

function renderExprChips() {
  if (availableExpressions.length === 0) {
    exprList.innerHTML =
      '<div class="expr-empty">このモデルには表情プリセットがありません。</div>';
    return;
  }
  const chips = [{ name: "", label: "なし" }, ...availableExpressions];
  exprList.innerHTML = chips
    .map((c) => {
      const active = (manualExpression || "") === c.name ? " active" : "";
      return `<button class="expr-chip${active}" data-expr="${c.name}">${escapeHtml(
        c.label
      )}</button>`;
    })
    .join("");
}

// 表情を選択する（name が空文字/null なら解除してニュートラルへ）
function setExpression(name) {
  manualExpression = name || null;
  const em = currentVrm && currentVrm.expressionManager;
  if (em && !manualExpression) {
    // 解除時は感情プリセットの重みをクリア
    for (const p of availableExpressions) em.setValue(p.name, 0);
  }
  renderExprChips();
}

// 毎フレーム、選択中の表情を再適用してアニメーションより優先させる
function applyManualExpression() {
  if (!manualExpression) return;
  const em = currentVrm && currentVrm.expressionManager;
  if (!em) return;
  for (const p of availableExpressions) {
    em.setValue(p.name, p.name === manualExpression ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// 加速度センサーで揺れ物（spring bone）を揺らす
// ---------------------------------------------------------------------------
function getSpringJoints() {
  const joints = currentVrm && currentVrm.springBoneManager?.joints;
  if (!joints) return [];
  return Array.from(joints); // Set/配列どちらでもよいよう配列化
}

// 各 joint の base 重力（向き・強さ）を控える
function snapshotSpringBase() {
  springBaseGravity = new Map();
  for (const joint of getSpringJoints()) {
    const s = joint.settings;
    springBaseGravity.set(joint, {
      dir: s.gravityDir.clone(),
      power: s.gravityPower,
    });
  }
}

// base 重力へ戻す
function restoreSpringBase() {
  if (!springBaseGravity) return;
  for (const [joint, base] of springBaseGravity) {
    joint.settings.gravityDir.copy(base.dir);
    joint.settings.gravityPower = base.power;
  }
}

// 揺れ（shakeAccel）を各 joint の外力として注入する
function applyShakeToSpringBones() {
  if (!sensorEnabled || !springBaseGravity) return;
  for (const [joint, base] of springBaseGravity) {
    // F = baseDir*basePower + shakeAccel*gain
    _shakeForce
      .copy(base.dir)
      .multiplyScalar(base.power)
      .addScaledVector(shakeAccel, SHAKE_GAIN);
    const len = _shakeForce.length();
    if (len > 1e-6) {
      joint.settings.gravityDir.copy(_shakeForce).multiplyScalar(1 / len);
      joint.settings.gravityPower = len;
    } else {
      // ほぼ0：向きは base のまま強さ0
      joint.settings.gravityDir.copy(base.dir);
      joint.settings.gravityPower = 0;
    }
  }
}

// DeviceMotion から揺れ加速度を取得する
function onDeviceMotion(e) {
  let ax, ay, az;
  const acc = e.acceleration;
  if (acc && (acc.x != null || acc.y != null || acc.z != null)) {
    // 重力を含まない加速度が取れる端末
    ax = acc.x || 0;
    ay = acc.y || 0;
    az = acc.z || 0;
  } else if (e.accelerationIncludingGravity) {
    // 重力込みしか無い端末：ローパスで重力を推定して差し引く（ハイパス）
    const g = e.accelerationIncludingGravity;
    const gx = g.x || 0,
      gy = g.y || 0,
      gz = g.z || 0;
    if (!gravityLowPassInit) {
      gravityLowPass.set(gx, gy, gz);
      gravityLowPassInit = true;
    } else {
      gravityLowPass.lerp(_shakeForce.set(gx, gy, gz), 0.1);
    }
    ax = gx - gravityLowPass.x;
    ay = gy - gravityLowPass.y;
    az = gz - gravityLowPass.z;
  } else {
    return;
  }
  // クランプしてワールド座標へ（デバイス軸をそのまま対応付け）
  const clamp = (v) => Math.max(-SHAKE_CLAMP, Math.min(SHAKE_CLAMP, v));
  shakeAccel.set(clamp(ax), clamp(ay), clamp(az));
}

async function enableShakeSensor() {
  const joints = getSpringJoints();
  if (joints.length === 0) {
    showError("このモデルには揺れ物（spring bone）がありません");
    return;
  }
  // iOS 13+ は明示的な許可が必要（ユーザー操作起点で呼ぶ）
  try {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === "function") {
      const res = await DME.requestPermission();
      if (res !== "granted") {
        showError("センサーの使用が許可されませんでした");
        return;
      }
    }
  } catch (err) {
    console.error(err);
    showError("センサーを利用できませんでした");
    return;
  }
  snapshotSpringBase();
  gravityLowPassInit = false;
  shakeAccel.set(0, 0, 0);
  window.addEventListener("devicemotion", onDeviceMotion);
  sensorEnabled = true;
  updateShakeButton();
}

function disableShakeSensor() {
  window.removeEventListener("devicemotion", onDeviceMotion);
  sensorEnabled = false;
  shakeAccel.set(0, 0, 0);
  restoreSpringBase();
  springBaseGravity = null;
  updateShakeButton();
}

function toggleShakeSensor() {
  if (sensorEnabled) disableShakeSensor();
  else enableShakeSensor();
}

// ボタンの表示・状態を更新する
function updateShakeButton() {
  // DeviceMotion 非対応環境では出さない
  if (!("DeviceMotionEvent" in window)) {
    shakeSensorBtn.classList.add("hidden");
    return;
  }
  shakeSensorBtn.classList.remove("hidden");
  shakeSensorBtn.classList.toggle("active", sensorEnabled);
  shakeSensorBtn.textContent = sensorEnabled ? "センサー ON" : "揺れ物センサー";
}

// ---------------------------------------------------------------------------
// UI ヘルパ
// ---------------------------------------------------------------------------
function showLoading(text) {
  loadingText.textContent = text || "読み込み中...";
  loading.classList.remove("hidden");
}
function hideLoading() {
  loading.classList.add("hidden");
}

let errorTimer = null;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => errorToast.classList.add("hidden"), 5000);
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------
pickFileBtn.addEventListener("click", () => fileInput.click());
loadAnotherBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  loadFile(file);
  fileInput.value = ""; // 同じファイルを再選択できるように
});

resetViewBtn.addEventListener("click", resetView);
toggleInfoBtn.addEventListener("click", () =>
  infoPanel.classList.toggle("hidden")
);
closeInfoBtn.addEventListener("click", () => infoPanel.classList.add("hidden"));

// アニメーション関連
toggleAnimBtn.addEventListener("click", () =>
  animPanel.classList.toggle("hidden")
);
closeAnimBtn.addEventListener("click", () => animPanel.classList.add("hidden"));
playPauseBtn.addEventListener("click", () => {
  if (currentAction) {
    togglePause();
  } else if (currentAnimIndex >= 0) {
    playAnimation(currentAnimIndex);
  }
});
stopAnimBtn.addEventListener("click", stopAnimation);
addVrmaBtn.addEventListener("click", () => vrmaInput.click());
vrmaInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadVrmaFile(file);
  vrmaInput.value = "";
});
animList.addEventListener("click", (e) => {
  const item = e.target.closest(".anim-item");
  if (!item) return;
  playAnimation(Number(item.dataset.index));
});

// 表情関連
toggleExprBtn.addEventListener("click", () =>
  exprPanel.classList.toggle("hidden")
);
closeExprBtn.addEventListener("click", () => exprPanel.classList.add("hidden"));
exprList.addEventListener("click", (e) => {
  const chip = e.target.closest(".expr-chip");
  if (!chip) return;
  setExpression(chip.dataset.expr);
});

// 加速度センサー（揺れ物）
shakeSensorBtn.addEventListener("click", toggleShakeSensor);

// ドラッグ & ドロップ（ページ全体で受け付ける）
["dragenter", "dragover"].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("hidden");
    dropzone.classList.add("dragover");
  });
});
["dragleave", "dragend"].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    // モデル表示中に領域外に出たら隠す
    if (currentVrm && e.type === "dragleave" && e.relatedTarget === null) {
      dropzone.classList.add("hidden");
    }
  });
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    loadFile(file);
  }
  // モデル表示中はドロップ後にオーバーレイを隠す
  if (currentVrm) {
    dropzone.classList.add("hidden");
  }
});

// 起動時に内蔵アニメーションを読み込む
loadBuiltinAnimations();
