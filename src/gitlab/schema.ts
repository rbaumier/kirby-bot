/**
 * Gitlab/schema.ts — zod schemas for the GitLab JSON the pipeline consumes.
 *
 * The REST API is an external, untrusted boundary: every shape that crosses
 * it is validated here rather than `as`-cast. The defaults absorb fields an
 * endpoint may omit, so one schema serves several call sites.
 */
import { z } from "zod";

/**
 * An issue from `GET /projects/:id/issues` and `GET /projects/:id/issues/:iid`.
 * One schema covers the queue read, the claim-time label check, and the
 * staleness sweep.
 */
export const IssueSchema = z.object({
  iid: z.number(),
  title: z.string().trim().min(1),
  description: z.string().trim().nullable().default(null),
  labels: z.array(z.string().trim().min(1)).default([]),
  updated_at: z.string().trim().min(1).default(""),
});

/**
 * A merge request from `GET/POST/PUT /projects/:id/merge_requests`.
 *
 * `draft` (modern API) and `work_in_progress` (legacy) carry the same flag;
 * we accept either, with the title prefix as the final fallback. The adapter
 * folds the three into a single `isDraft` boolean.
 */
export const MergeRequestSchema = z.object({
  iid: z.number(),
  web_url: z.string().trim().min(1).default(""),
  state: z.string().trim().min(1).default(""),
  source_branch: z.string().trim().min(1).default(""),
  target_branch: z.string().trim().min(1).default(""),
  title: z.string().default(""),
  draft: z.boolean().default(false),
  work_in_progress: z.boolean().default(false),
});

/** A merge request as the orchestrator consumes it. */
export type GitLabMergeRequest = z.infer<typeof MergeRequestSchema>;
