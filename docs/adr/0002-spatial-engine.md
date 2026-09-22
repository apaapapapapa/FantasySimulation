# ADR 0002: 3D計算基盤と互換性の撤回

Issue #1の2026-09-22改訂を正本とする。P2は3D-01〜07、P3は3D-08および
Issue #10のR1/R2。表示・公開サイト・ランキングは今回の対象外。

## 決定

TypeScriptの公開契約・ルール・APIを継続し、衝突queryにはRapier 3D WASM
0.20.0を固定する。標準Character Controllerの端点だけでは壁沿いの折れ線や
両者の同時接触を扱えないため、physics境界で区間ごとのshape castを組み合わせる。
直立カプセル/球同士の相対運動はMinkowski和の円柱・両端球へ解析的sweepを行う。
これはTSのbinary64計算であり、静的地形queryはRapierのbinary32計算である。
単純なshape-pairごとのWASM境界往復を減らし、球端を含むRapierとの比較fixtureを設ける。
可変worldは試合が所有し、必ずfreeする。WASMの非同期初期化は計算呼出し前に済ませる。

旧basic/tick実装、API 201、schema、Goldenの互換は維持しない。
既存DBの通常起動時削除・自動変換は行わず、新規DBか明示的な開発用resetを要求する。
旧機能は新経路が利用可能になった関連PRで削除し、3D-08で残存参照を検査する。
新しい観戦記録は保存済みの表示状態を再生し、旧エンジンを呼び出さない。

## 数値・決定性

- 検証対象はNode.js 24.19.0、Linux x64とWindows x64。その他は未検証。
- 入力は整数mm、内部TSはbinary64のm。Rapierの境界でbinary32に変換される。
  Rapierの戻り値を表示単位へ丸めて判定へ戻さない。
- TS小数状態はIEEE754 binary64、big endianの16桁hex、負のゼロは正のゼロへ
  正規化する。非有限値は拒否する。Rapier snapshotはbytesのままhashする。
- 物理間隔20ms。操作の列挙・collider生成順はASCII ID順で固定するが、
  接触の解決に先着ID優先を使わない。同時の壁/身体は固定epsilon内なら壁を優先する。
- 旋回は1度間隔の整数sin表の線形補間を使う。生成はDecimal精度80、
  Taylor 80項、倍率10^9、half-even。`python scripts/generate-angle-table.py`で再生成する。
  実行時のsin/cosを使用しない。表・WASM・JS bindingのhashを実装identityへ含める。
- `engine:check`は3D実装を対象とする。新rules/schema/engineの版・全必要状態を
  新manifestと照合する契約は3D-02以降で追加する。試作のcheckpointsは戦闘状態全体ではない。
- 同一入力のhash一致と、主体・位置・向きを交換した対称性は別々に検証する。

## 試作の成立条件

`physics.test.ts`が同時正面接触、離脱、壁slideの折れ線、端点間の直線では
見落とす接触、動く身体への高速弾、薄い壁、照準を検証する。
同時の壁/身体の優先順位は独立した固定規則とし、3D-07で攻撃全体へ接続する。
`probe.test.ts`は同じ6000stepのgeometry workloadをLinux/Windowsの両CIで固定hashに照合する。
probeは正式な戦闘・AI・イベント・再生ログの代替ではない。

## 基準環境と確定する目標

基準機: AMD EPYC 9V74、利用可能CPU 8、RAM約21.5GiB、Linux x64、
Node24.19.0、ローカルコンテナのoverlayストレージ。物理ディスク型番/IOPSは未公開。
測定JSONに正確なRAM、CPU、実装/WASM/table digestを残す。CIは正しさの検査に用い、
共有runnerの時間をこの基準機の性能合否に用いない。

初期対象はローカル開発の1,000試合規模とする。495,000試合例は採用済み目標ではない。
各試合は最大6000step、障害物256、同時弾64。正式な統合fixtureは3D-08で確定する。

| 指標                                     | 基準機での受入目標                                                   |
| ---------------------------------------- | -------------------------------------------------------------------- |
| 試作単体warm計算                         | 中央値2秒以内、p95 4秒以内                                           |
| 統合単体warm（正式ログ・圧縮・保存あり） | 中央値4秒以内、p95 8秒以内                                           |
| 新規計算の代表バッチ                     | 1,000試合を4 Worker以下で30分以内（0.56試合/秒以上）                 |
| 並列条件                                 | Worker 1と4を比較。CPUをAPI/保存に最低1個残し、既定1、最大4          |
| メモリ                                   | Worker JS heap 128MiB、WASM/外部を含むプロセスRSS 1.5GiB以下         |
| 連続試行                                 | warmup後の後半高水位RSS増加64MiB以内。WASM/external/heapも分けて記録 |
| 保存                                     | 1試合の圧縮artifact合計16MiB以下、1,000試合で16GiB以下               |
| 初期運用予算                             | 待機128件、全保存16GiB、1試行実時間30秒（失敗として扱う）            |

これは最大規模リーグの処理性能を保証する値ではなく、既存基準機で短い開発反復を
可能にする初期容量である。バッチの全件を測らない場合、実測サンプルからの外挿であることを
明記し、1,000件実測の合格としない。目標変更はこのADRに理由を追加する。

## 計測と判断

`vp run bench:spatial`はopen/denseの固定入力それぞれcold 1回＋warm 20回。
最大6000stepを必ず処理し、cacheを使わない。WASM初期化、compute、hashを分離する。
computeはTS、Rapier、境界転送、試作checkpointとsnapshot生成を含み、この内訳は未分離。
正式イベント、圧縮、DB、artifact保存と複数Workerの性能は3D-08まで未検証。
計測用実時計を試合stateやhashに含めない。打切り・失敗を完走性能に混ぜない。

試作が成立すればTS+Rapierを条件付き採用し、統合受入は3D-08で別途判定する。
未達ならまずquery数、経路再計算、割当て、ログ転送/圧縮を測り改善する。
TSまたは境界コストが支配的で改善しない場合のみ同じ精度・ログ条件でRustコアを比較する。
言語変更自体を目的にせず、未達は未達のまま記録する。

公式根拠:

- <https://rapier.rs/docs/user_guides/javascript/determinism/>
- <https://rapier.rs/docs/user_guides/javascript/scene_queries/>
- <https://rapier.rs/docs/user_guides/javascript/character_controller/>
- <https://nodejs.org/api/worker_threads.html>

## 3D-01測定結果と試作採用

[基準機の測定JSON](../measurements/3d-01-linux.json)を保存した。20回のwarm実測で、
openは中央値11.5ms/p95 14.7ms、denseは中央値1,099.8ms/p95 1,643.4ms。
双方6000step完走、cache不使用。試作の中央値2秒/p95 4秒目標を満たした。
Linux/Windowsの同一Golden確認はこのPRの両CIを合格条件とする。

最初のdense測定は中央値4,330.9ms/p95 5,637.9msで未達だった。
保守的なswept AABB除外とshape再利用で中央値2,327.8msまで改善し、
直立カプセルの解析的sweepで上記まで改善した。stepや弾数は削減していない。
解析式は球端も含めて表面距離を検証した。比較対象のRapierのshape-pair castには
このfixtureで数mmの収束差があるため、両実装の浮動小数点結果が同一とは主張しない。
TS側解析式をprofileに明記し、新しいGoldenを固定した。

この結果に基づき、TS+Rapierを**試作採用**する。保存込みの正式採用は3D-08で判定する。
geometry workloadは早期勝敗やAIを持たず、正式戦闘の速度を保証しない。
JSONのメモリ値は各試行直後のサンプルであり、試行中の瞬間最大値やWASM領域単体の
測定ではない。連続Worker実行、完全TS状態/event hash、圧縮/保存、失敗/打切り分離は
統合ゲートで検証する。今回の値から495,000試合の完了時間を保証しない。
