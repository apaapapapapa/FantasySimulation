# ADR 0007: 永続ジョブと有界Worker実行

P3 / Issue #1・#10の単一ホスト実行。計算はPiscina 5.3.2の再利用Worker、
保存とSQLite更新はAPIプロセスが所有する。WorkerはDB・保存先を受け取らない。
既定1 Worker、最大4かつCPUを最低1個残す。各Workerのold/young heap設定は
合計128 MiB。これはWASM・外部バッファやプロセスRSSの強制隔離ではない。

## 保存と実行

1. 公開revisionからmanifestとsimulationHashを固定し、予算を別に保存する。
2. 同じ利用者/エンドポイントの冪等キーと入力を照合する。別入力は409。
3. 正本hashに一致するready artifactを全件検証し、確定win/drawのみ再利用する。
4. 調整側が短いimmediate transactionでtokenと10秒leaseを取得する。
5. Workerは同じ`simulate`をpullし、128 KiB目標のNDJSONを一つだけ転送する。
   1 recordの最大4,000,001 bytesを例外上限とし、保存側のACKまで次を送らない。
6. 保存側は各recordを検証・圧縮し、全件のhashとcheckpointを再検証して確定配置する。
7. token・有効lease・中止状態を再確認し、結果/参照を一つのDB transactionで確定する。

leaseは約3.3秒ごとに更新する。失効したattemptを再取得するとtokenが変わり、
古い完了は拒否される。再取得は最大3回。中止のDB確定をWorker停止より先に行う。
timeoutは既定30秒でfailedを記録し、Workerを停止する。終了後もI/Oの解放を待つ。
失敗・中止・truncatedは予算とexpectedAttemptsを指定して明示再試行できる。
正常終了時のcloseも実行中attemptを失敗診断として保持し、待機jobは再起動で再開する。

調整側のPID・hostname・tokenをSQLiteに記録し、同一DBへの同時起動を拒否する。
保存rootは永続store IDに結び付け、別DBのrootや未所有の非空rootを採用しない。
同じホストで旧PIDが終了済みの場合だけ所有権を再取得する。PIDが再利用された場合や
ホスト/rootを移動した場合は保守的に起動を拒否し、既存データを消さない。
唯一の調整側になってから生成済みの未参照UUIDディレクトリとstagingを回収する。
DB参照がある記録は削除せず、読取時の欠落/破損をmissing/corruptとして保留する。

## 予算と診断

待機/実行中は合計128件、保存は16 GiBを既定上限とする。受付時に各jobへ20 MiB
（圧縮記録16 MiB＋manifest最大4 MB）を予約し、後着の失敗診断にも予約を侵食させない。
さらにWorker数×20 MiBを実ファイルの未確定書込用に確保する。
API設定で各上限を小さくできる。上限拡大は本ADRの計測・レビュー後に行う。

RSSを250ms間隔で監視し、1.5 GiBを超えれば受付を停止して実行を中止する。
これはサンプリングであり、瞬間最大値やOSによるハード制限ではない。
WorkerはJS heap、external、ArrayBufferと、初期化時に捕捉したWASM exportの
linear memory bytesを別々に報告する。WASM/ArrayBufferはexternalと重複し得るため
足し合わせない。RSSもWorkerごとの値として合算しない。
計算・初期化・ACK待ち・転送bytes・最大片サイズ・cold/warm・全保存時間を記録する。
計算時間内のTSルール/Rapier/境界往復は未分離。計測値は結果hashへ混ぜない。

破損結果を通常受付で黙って再計算しない。明示的なreplay-recoveryは現行engineで
保存manifestを実行できる場合だけ受理する。再計算した結果hashが元の不変正本と
完全一致した場合のみ新artifactをcacheに使う。不一致は関連artifactを全て隔離する。
対応しない過去engineは409で保留し、旧engine registryや入力の自動変換を行わない。
決定性違反の再試行禁止は`simulation_jobs.failure_code`で判定する。Drizzle 0003は
既存の該当診断から列だけを補完し、保存済みの本文・結果・replayを変更しない。
保存層はコード付きの未検出・競合・入力・容量・利用不能エラーを返し、HTTP変換は境界が行う。

API/Worker/保存の統合回帰は`battle-runtime.test.ts`と`worker-pool.test.ts`。
実プロセスの異常終了、再起動、二重送信、予算再試行、中止、timeout、破損、復旧、
Worker数/再利用のhash一致を検証する。1,000試合の統合性能は別の計測記録で判定する。
