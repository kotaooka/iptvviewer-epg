# iptvviewer-epg

IPTV Viewer 用の番組表（XMLTV）を毎日作って配るリポジトリ。

- [iptv-org/epg](https://github.com/iptv-org/epg) の取得ツールを GitHub Actions で毎日 03:17 JST に実行する。
- 対象は iptv-org のプレイリストに載っている局のうち、指定した国（既定：日本・アメリカ・イギリス・韓国）で番組表の取得元がある局。
- 取得元サイトが失敗した局は、別の取得元に切り替えて最大 4 回まで取り直す。
- 結果は Release `epg` に `guide.xml.gz` として置く。

```
https://github.com/kotaooka/iptvviewer-epg/releases/download/epg/guide.xml.gz
```

国や日数を変えて今すぐ作り直すときは Actions → Update EPG → Run workflow で入力する。定期実行の国は `.github/workflows/epg.yml` の `COUNTRIES` の既定値で変える。
