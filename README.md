# webapp_vrm_viewer

VRMモデルビューワーのWebアプリ版。将来的にWindowsスタンドアロン版（Tauri + three.js + three-vrm）を作るための前段階として、まずWebアプリとして実装しています。

**公開URL:** https://verylowfreq.github.io/webapp_vrm_viewer/

## 機能

- VRMファイルの読み込み（ファイル選択 / ドラッグ&ドロップ）
- 初期姿勢のままモデルを表示
- マウス / タッチによる視点操作（回転・ズーム・パン）
- モデルの基本情報の表示
  - メタ情報：名前・作者・バージョン・規格（VRM 0.x / 1.0）
  - 統計：ポリゴン数・頂点数・マテリアル数・テクスチャ数・メッシュ数・ボーン数・モーフ数・ファイルサイズ
- PC・スマートフォン両対応（レスポンシブUI、タッチ操作、safe-area対応）

## 技術構成

- [three.js](https://threejs.org/) — 3D描画
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — VRMの読み込み・表示
- ビルド不要の構成（ES modules + import map）

依存ライブラリは `docs/vendor/` にバンドル済みで、外部CDNに依存せず動作します。

## ディレクトリ構成

```
docs/                        GitHub Pages 公開ディレクトリ
├── index.html               エントリポイント
├── main.js                  アプリ本体
├── style.css                スタイル
└── vendor/three/            three.js / three-vrm （バンドル済み）
```

## ローカルでの実行

`docs/` を任意の静的HTTPサーバーで配信してください（ES modules のため `file://` では動きません）。

```sh
cd docs
python3 -m http.server 8000
# http://localhost:8000/ を開く
```

## VRMサンプル

手元にVRMがない場合は、[VRoid Hub](https://hub.vroid.com/) などで配布されているモデルや、[vrm-samples](https://github.com/madjin/vrm-samples) のサンプルモデルで動作を確認できます。
