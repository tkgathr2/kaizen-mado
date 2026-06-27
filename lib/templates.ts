/**
 * 素人が最初の一歩を踏めるサジェストテンプレート。
 * 特定のシステム名は入れず汎用的に。
 * B レーン（page.tsx）が import して使う。
 */

export interface SuggestionTemplate {
  label: string;
  text: string;
}

export const SUGGESTION_TEMPLATES: SuggestionTemplate[] = [
  {
    label: "動作が遅い",
    text: "画面の動作が遅くて操作しにくいです。改善してほしいです。",
  },
  {
    label: "使い方が分からない",
    text: "どうやって使えばいいか分かりません。教えてもらえますか？",
  },
  {
    label: "エラーが出る",
    text: "操作中にエラーが表示されて先に進めません。",
  },
  {
    label: "こう変えてほしい",
    text: "今の表示や操作をこのように変えてほしいです：",
  },
  {
    label: "ボタン・メニューが見つからない",
    text: "やりたい操作のボタンやメニューが見当たりません。",
  },
  {
    label: "表示がおかしい",
    text: "画面の表示が崩れていたり、正しく見えない部分があります。",
  },
  {
    label: "もっと便利にしてほしい",
    text: "こんな機能があると便利だと思います：",
  },
  {
    label: "その他・自由に書く",
    text: "気になっていることを自由に書きます：",
  },
];
