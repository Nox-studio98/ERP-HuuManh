import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Markdown } from "../lib/md";
import { Link, usePageMeta } from "../lib/router";
import { ErrorBox, Img, Loading, useAsync } from "../ui";

interface Post { slug: string; title: string; excerpt: string | null; bodyMd: string; coverUrl: string | null; publishedAt: string | null }

export function PostPage({ slug }: { slug: string }) {
  const { data, error, loading, reload } = useAsync(() => api<Post>(`/posts/${encodeURIComponent(slug)}`), [slug]);
  usePageMeta(data?.title ?? "Bài viết", data?.excerpt ?? undefined);
  if (loading) return <div className="wrap page"><Loading /></div>;
  if (error || !data) return <div className="wrap page"><ErrorBox error={error} onRetry={reload} /></div>;
  return (
    <article className="wrap page narrow post-page">
      <nav className="crumbs" aria-label="Đường dẫn"><Link to="/">Trang chủ</Link><span aria-hidden="true">/</span><span>Bài viết</span></nav>
      <h1>{data.title}</h1>
      {data.publishedAt && <time className="muted" dateTime={data.publishedAt}>{fmtDate(data.publishedAt)}</time>}
      {data.coverUrl && <Img src={data.coverUrl} alt="" seed={data.title} className="post-cover" eager />}
      <Markdown source={data.bodyMd} />
      <p><Link to="/san-pham" className="btn">Chọn trái cây ngay</Link></p>
    </article>
  );
}
