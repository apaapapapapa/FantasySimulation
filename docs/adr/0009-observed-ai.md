# ADR 0009: 観測と経験に基づく確率的AI

状態: 採用。Refs #1, #9, #10, #45。

## 入力と責務

`spatial-v1.11` / `observed-utility-v1` は一つのAIを使う。manifestのAI profile、
`empty-match-v1` 初期知識、rules revision内の数値、policy revision内の評価係数、
主体の明示seed、実装digestを固定する。旧rulesの保存revisionは読めるが、実行時の自動更新や
旧engine実行はしない。過去の保存display/replayはRecordedManifestで検証し、そのまま読める。

通常AIが受け取るのは自己の状態と遅延した観測だけである。敵の外観はsilhouette/surface/equipment、
傷はunknown/unhurt/hurt/severe/critical、行動は表示可能なphase、身体は見える寸法で表す。
正確な敵HP/MP、耐性、技の一覧、将来の位置・乱数、定義の逆引きは渡さない。
能力IDの名称やキャラクターIDを戦術の例外にしない。

`perceive` と効果観測境界だけが真の状態を受け取る。通常の命中反応はHP差ではなく、
10単位幅の粗い効果推定区間と、既知の元威力、2m距離帯、時刻、原因event/ability revisionにする。
盾吸収・部分遮蔽/距離減衰の反応はrange=nullで保持する。外れ・見えなかった結果は0として学習しない。
初版は命中部位を区別しない共通capsuleモデルで、経験から推定するのは防御込みの正味有効性である。
属性耐性だけの断定は限定鑑定を除いて行わない。

限定鑑定はenemy向けzero-radius hitscanの`reveal`効果。実際の射程/接触、視線、
power > revealWardの検査後、一属性のresistanceだけをprecisionBps幅へ丸める。
取得は能力delay + 本人のreaction後、expiryは取得元step + duration。真値のライブ参照は残さず、
失効後の新情報は得ない。持っているだけでは開示しない。未対応の取得形式は入力検証で拒否する。

## 地形・記憶・候補

`terrainKnowledge: surveyed` のシナリオだけ完全な静的地形/経路グラフを事前知識として扱う。
省略またはobservedでは本人の視野内の固定11方向rayから得た点/法線だけを遅延配送し、
半幅0.35mの小さな面として最大64個を記憶する。観測外のcollider形状は渡さない。
経路/回避用worldもこの局所地図から構築し、実worldのcast予算へ使用数を計上する。
未観測領域では0.75m以内の局所移動を試み、実際の壁・重力・移動は共通physicsが解決する。
この地図は完全な安全保証ではなく、誤認・未観測の衝突は起こり得る。

各actor/matchで独立した記憶を作り、Workerへ持ち越さない。未配送経験はFIFO32、既知経験は
rules.memorySamples（標準32）、標準TTL500step。容量/期限で失う既知の根拠はexpiredで記録する。
知覚sampleの配送後、過去の敵位置/地形は本人のmemoryStepsで失効する。決定に必要な記憶と
用途別PRNGをTS state hashへ含め、失敗intervalでそれらを確定しない。

policy.prioritiesは条件付き使用候補の集合として解釈する。配列やIDの順にutilityを加点しない。
自分のHP/MP・uses・cooldown・action phase・action speed・条件・観測上の射程/向きを先に検査する。
silencedは`magic`分類のactionの開始/発動を禁じる（#61 G-01）。移動不能、詠唱中の移動制限も尊重する。
開始時/発動時は共通戦闘処理で再検査し、未知の障害や状況変化による不発を許す。
有益で実行可能な候補がなければ通常の移動/待機。単一候補なら判断乱数は消費しない。

## 標準数値と計算

AI_RULES: horizon=50step、healthPrior=200、exploration=60、risk=800、kill=2400、
action=100、dodge=600。policyのattack/survival/exploration係数の既定は各10000bps。
全ての候補評価は有限の直接計算で、長期探索や外部モデルは使用しない。

- 有効性: 通常の未知事前値7500bps。赤い外観へのfire、青い外観へのiceだけ弱い6500bps/確信1000bps。
  同じ相手・属性・距離帯で、元威力差20%以内の可視命中だけを比較する。
  mean(粗い反応区間の中点/既知威力)をbpsへ変換し30000で上限。
  確信は件数×2500、上限9000。限定鑑定は一属性の残存倍率と確信10000。
  これらは推定値であり実際の防御/耐性計算へ代入しない。
- `r = min(1, 今後horizon内の既知燃焼ダメージ / max(1,自己HP))`。
  自己の防御/耐性と残存周期/期限/stack、shieldを使い、共通damage整数算術で見積もる。
  `b = min(1, r * max(1,cast時間)/horizon)`。
- 成功推定s = clampBps(8500 - aimErrorMilliDegrees/10 - 見えた移動速度[m/s]×150
  - 現在見えずlastSeenだけの場合2500)。敵の隠れた回避能力は読まない。
    傷のhealthPrior係数はunhurt/unknown=1、hurt=.85、severe=.5、critical=.25。
    撃破推定k = clampBps(s × min(1,推定威力/推定残HP) × (.1+.9×確信率))。
- 攻撃utility = (100 × min(8,推定威力/25) × s/10000 / (1+3r)
  - 2400 × k/10000 × (1-b)^2) × attack係数。
    探索値 = 60 × (1-確信率) × (1-r) × exploration係数。
- 本人に水で消せる燃焼があるself-water utility = (100 + 800×(.65+2r)) × survival係数。
  healは実際に欠けた自己HP分、shieldは既存盾量と見える弾、情報取得は一属性の不確かさ、
  状態付与/解除は既知の効果価値から評価する。自己水の候補があるだけでは状態を削除しない。
- 所要時間は共通actionClockのcast+active+recovery。costBpsはHPcost/自己HP + MPcost/自己MPを
  bpsへ丸め上限10000。見える弾数×.15、敵の可視cast=.25/active=.4から
  exposure = min(1,脅威×所要時間/horizon)を見積もる。
- weight = clamp(round((utility+探索値) × (1-.6×exposure) /
  (1+所要時間/horizon) / (1+costBps/5000)), 0, 1000000)。
  敵向けdamageの推定威力を合算し、確信度は既知基礎威力で加重平均する。
  攻撃評価と探索値は一能力につき一度計算し、自己支援効果のutilityを加算する。0weightは選ばない。最大32能力+dodgeで計算量を制限する。
  選択確率は整数weight/totalWeight。成功・撃破・生存推定とは別の量として記録する。

基準fixture（assessment.test.ts）は自己HP100/MP100、burn20、威力25、未知/unhurtの敵、
cast3+active1+recovery12、self-water MP4。攻撃81、水659、消火確率659/740=約89.05%。
これは固定の消火率ではない。同威力の有効命中を4回観測しcriticalの相手なら攻撃weightが水を超え、
burn危険を増すと生存選択の比率が上がる。長いcast/高costも不利になる。
実対戦fixtureのseed4は燃焼中のstep5で攻撃を選び、step8に発動し、step10以降も燃焼被害を受ける。
水の場合はcast後の通常効果解決で既存の消火可能statusだけを除去する。同時の新規燃焼は残る。

## 回避と乱数

観測した弾をsampleから等速外挿し、horizon内の接近を見積もる。真の将来軌跡は取得しない。
地上は左右、飛行は上下左右。身体capsuleの方向別寸法・可視弾半径・速度/加速度・自己の現在速度から
到達可能性を判定し、反応に間に合わない方向や既知の壁/床/天井を除外する。
他の見える弾に対する最小余裕距離[m]×1000を丸め1..10000で重み付けする。
回避種別を選んだ後だけ方向を抽選する。球形飛行体の完全同等fixtureは4方向とも100。
地上への自由な上下移動や未実装の伏せ動作は付与しない。通常経路のjump機能は維持する。
詠唱中にも移動可能なら回避でき、発動/被弾は共通移動・連続衝突で解決する。

判断用action/dodgeはactorSeed xor 0x243f6a88 / 0x85a308d3（0なら1）をxorshiftで一度進める。
照準は既存の独立stream。判断streamへ敵の定義/hashや全manifest hashを混ぜない。
候補は能力定義のcanonical JSONで正規化し、同一内容の最後のID順は等utility候補の識別だけに使う。
xorshift非ゼロ状態空間2^32-1を0始まりに写し、不完全な最終bucketをrejectionして偏りを避ける。
最大128draw超過はtruncated。唯一候補はdraw0。action選択はdodge方向や照準streamを消費しない。

## 記録・検証・変更の根拠

subjectiveなdecision/knowledgeと全知のdamage/cost結果を別eventにする。cognition eventに正本の
resource before/afterやdamageを混在させない。候補35、除外160、経験32、地形64、方向4、乱数用途2に制限し、
既存Journal/Worker/backpressure/gzip上限で保存する。P4表示機能は別Issue。

PR #57 regressions retain explicit arithmetic: melee declares at 55/85/115/145,
contacts five steps later and applies 25 damage at the next boundary (151-step mutual defeat).
The fast projectile case retains six-step mutual defeat/trajectory/physics; cognition changes
only events/state. Historical replay is unchanged. Terminal-boundary tests use enemy shots:
five steps survive, six steps include the final lethal interval. Pillar permutation tests
allow 15s for two 6000-step runs; this is not a performance acceptance threshold.
The seven fixed inputs retain Worker/fairness/fast-check coverage; current CI is Linux-only.
Review regressions cover enemy shields, contact-position sight, interval-start facing and
compound damage aggregation. Expected outputs were not generated from the candidate.
