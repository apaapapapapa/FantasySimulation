# 自動リリース

mainのLinux通常検証・性能比較・Security・ci-gate成功後、semantic-releaseが
前回タグ以降のコミットを解析し、対象変更があれば`vX.Y.Z`タグと
[GitHub Release](https://github.com/apaapapapapa/FantasySimulation/releases)を作成します。
PRでは公開せず、main実行は後続pushで中断しません。

| Conventional Commit                            | 更新             |
| ---------------------------------------------- | ---------------- |
| `fix:`、`perf:`                                | patch            |
| `feat:`                                        | minor            |
| `!`または`BREAKING CHANGE:`                    | major            |
| `docs:`、`chore:`、`ci:`、`test:`、`refactor:` | 単独では公開なし |

最大の更新幅を採用します。Squashの最終タイトルと本文に意図した種別・破壊的変更を残します。
タグがない場合の最初の対象変更は`v1.0.0`。`package.json`の版は更新しません。
対戦のrules/engine版・実装digestは別管理です。npm公開やWeb/APIデプロイは行いません。

releaseジョブだけ`contents: write`と標準`GITHUB_TOKEN`を使います。追加Secretは通常不要です。
Issue/PRへの自動コメント・ラベル変更は無効。保護ルールはActionsの`v*`作成と整合させます。

再試行はActions → CI → Run workflowでmainと正確なbaseline SHAを指定します。
ローカル解析は最新main/tagを取得し、環境変数に権限確認可能な`GITHUB_TOKEN`を渡して
`pnpm release:dry-run`。認証・push権限は検査しますがタグ/Releaseは作成しません。
タグ成功後にRelease作成だけ失敗した場合はログとタグのcommitを確認し、該当Releaseを補完します。
ジョブ成功と新規公開の有無は別に報告します。
