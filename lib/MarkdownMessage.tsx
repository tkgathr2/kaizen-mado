import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/**
 * AIの返答を Markdown 形式で安全に描画するコンポーネント。
 *
 * 公開窓口（XSS安全）：
 * - rehype-raw を使わず生HTML埋め込み不可
 * - リンクは target="_blank" rel="noopener noreferrer nofollow"
 * - <script> / onerror 等の危険な属性はそもそも生成されない
 */

const COMPONENTS: Components = {
  // リンクを安全に開く
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {children}
      </a>
    );
  },
};

export default function MarkdownMessage({
  content,
}: {
  content: string;
}): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
}
