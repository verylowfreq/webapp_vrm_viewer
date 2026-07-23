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
- VRMA（VRMアニメーション, `.vrma`）の再生
  - 内蔵アニメーションをリストから選択して再生 / 一時停止 / 停止
  - `.vrma` ファイルの読み込み（ファイル選択 / ドラッグ&ドロップ）にも対応
- 表情の手動切り替え（VRM既定の感情プリセット：喜び / 怒り / 悲しみ / リラックス / 驚き）
  - モデルが持つプリセットのみ表示。アニメーション再生中でも手動表情が優先されます
- 加速度センサーで揺れ物を揺らす（スマホ向け）
  - 端末を揺さぶると、その加速度を spring bone の外力として注入し、髪やスカートが揺れます
- PC・スマートフォン両対応（レスポンシブUI、タッチ操作、safe-area対応）

## 技術構成

- [three.js](https://threejs.org/) — 3D描画
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — VRMの読み込み・表示
- [@pixiv/three-vrm-animation](https://github.com/pixiv/three-vrm) — VRMAの読み込み・再生
- ビルド不要の構成（ES modules + import map）

依存ライブラリは `docs/vendor/` にバンドル済みで、外部CDNに依存せず動作します。

## ディレクトリ構成

```
docs/                        GitHub Pages 公開ディレクトリ
├── index.html               エントリポイント
├── main.js                  アプリ本体
├── style.css                スタイル
├── animations/              内蔵VRMA
│   ├── animations.json      内蔵アニメーションの一覧（マニフェスト）
│   └── *.vrma               VRMAファイル
└── vendor/three/            three.js / three-vrm / three-vrm-animation （バンドル済み）
```

## 内蔵アニメーションの追加

内蔵アニメーションは `docs/animations/` のファイルと `animations.json` で管理しています。
追加するには次の2ステップだけです。

1. `.vrma` ファイルを `docs/animations/` に置く
2. `docs/animations/animations.json` の `animations` 配列にエントリを1つ追加する

```json
{
  "animations": [
    { "name": "テストモーション", "file": "test.vrma" },
    { "name": "追加したモーション", "file": "my_motion.vrma" }
  ]
}
```

- `name`: リストに表示される名前
- `file`: `docs/animations/` 内のファイル名

なお、アプリ上で `.vrma` をファイル選択 / ドラッグ&ドロップすれば、その場で一覧に追加して再生できます
（この方法はリポジトリへの同梱は不要です）。

> `.vrma` を配布する際は、その素材のライセンス・利用条件を必ず確認してください。

## 加速度センサー（揺れ物を揺らす）

スマートフォンで開くと、ツールバーに「揺れ物センサー」ボタンが表示されます。
ONにして端末を揺さぶると、髪やスカートなどの spring bone が揺れます。

- **HTTPS が必須**です（GitHub Pages 上では利用可。`http://` では動きません）。
- **iOS（Safari）** ではセンサー使用の許可が必要です。ボタンをタップすると許可ダイアログが出るので「許可」を選んでください。
- 揺れ物（spring bone）を持たないモデルではメッセージを表示し、ONになりません。
- 本体（ボディ）は動かさず、揺れ物のみが揺れます。OFFにすると元の状態に戻ります。

## ローカルでの実行

`docs/` を任意の静的HTTPサーバーで配信してください（ES modules のため `file://` では動きません）。

```sh
cd docs
python3 -m http.server 8000
# http://localhost:8000/ を開く
```

## VRMサンプル

手元にVRMがない場合は、[VRoid Hub](https://hub.vroid.com/) などで配布されているモデルや、[vrm-samples](https://github.com/madjin/vrm-samples) のサンプルモデルで動作を確認できます。
