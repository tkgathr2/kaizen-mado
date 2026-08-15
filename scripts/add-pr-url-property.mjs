// ── Notion DB「🔁 カイゼンくん 改善チケットDB」に「PR URL」（url型）プロパティを追加する ──
// 背景：kz-sweep のレビューリマインド（stallペイロード）が row.prUrl を参照できるよう、
// execute/callback route が review 結果受信時に PR URL をこのプロパティへ書き込む
// （lib/tickets.ts setPrUrl）。DB側にプロパティが無いと PATCH は 400 で fail-safe に握り潰される
// だけで動作は壊れないが、実際にstallカードへ prUrl を載せるにはこのプロパティが要る。
//
// 実行: node --env-file=.env.local scripts/add-pr-url-property.mjs
// NOTION_TOKEN / NOTION_DATABASE_ID は .env.local から読む（値は一切標準出力しない）。
const token = process.env.NOTION_TOKEN;
const databaseId = process.env.NOTION_DATABASE_ID;

if (!token) {
  console.error("NOTION_TOKEN が未設定です（.env.local を確認してください）。");
  process.exit(1);
}
if (!databaseId) {
  console.error("NOTION_DATABASE_ID が未設定です（.env.local を確認してください）。");
  process.exit(1);
}

const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
  method: "PATCH",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
  },
  body: JSON.stringify({
    properties: {
      "PR URL": { url: {} },
    },
  }),
});

const data = await res.json().catch(() => null);

if (!res.ok) {
  console.error(`失敗: HTTP ${res.status}`);
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(`成功: HTTP ${res.status}`);
console.log(JSON.stringify({ "PR URL": data?.properties?.["PR URL"] }, null, 2));
