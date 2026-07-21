import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

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
  if (currentVrm) currentVrm.update(delta);
  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
// VRM ローダー
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

function disposeCurrentVrm() {
  if (!currentVrm) return;
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

    currentVrm = vrm;
    scene.add(vrm.scene);

    frameModel(vrm.scene);
    showInfo(collectModelInfo(vrm, gltf, fileSize));

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

function loadFile(file) {
  if (!file) return;
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
  } else if (currentVrm) {
    dropzone.classList.add("hidden");
  }
});
