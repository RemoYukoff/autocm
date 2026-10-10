import type { MediaResult, PostRow } from "../core/types.ts";

/** Media files listed in post.media_json (empty for text posts or unparsable JSON). */
export function postMediaFiles(post: PostRow): MediaResult["files"] {
  if (!post.media_json) return [];
  try {
    return (JSON.parse(post.media_json) as Partial<MediaResult>).files ?? [];
  } catch {
    return [];
  }
}
