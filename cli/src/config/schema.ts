import { z } from 'zod';

const urlString = z
  .string()
  .min(1)
  .refine((value) => URL.canParse(value), { message: 'expected an absolute URL' });

/**
 * The raw shape of `devcontext.yaml`. Everything optional here gets a default
 * in `resolveConfig()`; this schema only rejects things that are plainly wrong.
 */

const githubSyncOptionsSchema = z
  .object({
    issues: z.boolean().optional(),
    issueComments: z.boolean().optional(),
    issueTimeline: z.boolean().optional(),
    issueReactions: z.boolean().optional(),
    pullRequests: z.boolean().optional(),
    pullRequestReviews: z.boolean().optional(),
    pullRequestComments: z.boolean().optional(),
    pullRequestCommits: z.boolean().optional(),
    pullRequestFiles: z.boolean().optional(),
    labels: z.boolean().optional(),
    milestones: z.boolean().optional(),
    workflows: z.boolean().optional(),
    workflowRuns: z.boolean().optional(),
    workflowJobs: z.boolean().optional(),
    workflowLogs: z.boolean().optional(),
  })
  .strict();

const jiraSyncOptionsSchema = z
  .object({
    workitems: z.boolean().optional(),
    comments: z.boolean().optional(),
    changelog: z.boolean().optional(),
    links: z.boolean().optional(),
    attachments: z.boolean().optional(),
    boards: z.boolean().optional(),
    sprints: z.boolean().optional(),
  })
  .strict();

const githubHostSchema = z
  .object({
    name: z.string().min(1),
    apiUrl: urlString.optional(),
    webUrl: urlString.optional(),
    token: z.string().optional(),
    tokenEnv: z.string().optional(),
  })
  .strict();

const jiraSiteSchema = z
  .object({
    name: z.string().min(1),
    baseUrl: urlString,
    apiVersion: z.enum(['2', '3']).optional(),
    auth: z.enum(['basic', 'bearer']).optional(),
    email: z.string().optional(),
    token: z.string().optional(),
    tokenEnv: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const githubRepoSchema = z
  .object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"'),
    host: z.string().optional(),
    since: z.string().optional(),
    /*
     * A cap, or no cap at all.
     *
     * `null` and `"all"` both mean every run the API will return. Two spellings
     * because they answer the question in different words — one is "there is no
     * limit", the other is "give me all of them" — and a configuration file is
     * read by people who think in one or the other.
     */
    maxWorkflowRuns: z.union([z.number().int().positive(), z.null(), z.literal('all')]).optional(),
    maxLogBytes: z.number().int().positive().optional(),
    sync: githubSyncOptionsSchema.optional(),
  })
  .strict();

const jiraProjectSchema = z
  .object({
    project: z.string().min(1),
    site: z.string().optional(),
    filter: z.string().optional(),
    since: z.string().optional(),
    boards: z.array(z.number().int().positive()).optional(),
    fields: z.record(z.string(), z.string()).optional(),
    sync: jiraSyncOptionsSchema.optional(),
  })
  .strict();

/**
 * One human or one bot, and every name they answer to.
 *
 * The same person is `ghopper` on GitHub and `Grace Hopper` on Jira, and often
 * more than one of each after a rename or a second account. Listing those names
 * here is what lets a query about a person mean the person rather than one of
 * their spellings.
 */
const personSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9._-]+$/, 'only letters, digits, ".", "_" and "-" are allowed'),
    name: z.string().optional(),
    email: z.string().optional(),
    bot: z.boolean().optional(),
    github: z.array(z.string().min(1)).optional(),
    jira: z.array(z.string().min(1)).optional(),
  })
  .strict();

const teamSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9._-]+$/, 'only letters, digits, ".", "_" and "-" are allowed'),
    name: z.string().optional(),
    description: z.string().optional(),
    members: z.array(z.string().min(1)).optional(),
  })
  .strict();

const projectSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/, 'only letters, digits, ".", "_" and "-" are allowed'),
    name: z.string().optional(),
    description: z.string().optional(),
    github: z.array(githubRepoSchema).optional(),
    jira: z.array(jiraProjectSchema).optional(),
  })
  .strict();

const outputTargetSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1).optional(),
    database: z.union([z.string(), z.object({ path: z.string() }).strict()]).optional(),
    sync: z
      .object({
        minDelayMs: z.number().int().min(0).optional(),
        maxRetries: z.number().int().min(0).optional(),
        retryBaseMs: z.number().int().min(0).optional(),
        respectRateLimit: z.boolean().optional(),
        rateLimitReserve: z.number().int().min(0).optional(),
        maxRateLimitWaitMs: z.number().int().min(0).optional(),
        requestTimeoutMs: z.number().int().positive().optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        progress: z.boolean().optional(),
      })
      .strict()
      .optional(),
    outputs: z
      .object({
        yaml: outputTargetSchema.optional(),
        markdown: outputTargetSchema.optional(),
        json: outputTargetSchema.optional(),
      })
      .strict()
      .optional(),
    web: z
      .object({
        port: z.number().int().positive().max(65535).optional(),
        host: z.string().optional(),
        open: z.boolean().optional(),
      })
      .strict()
      .optional(),
    github: z
      .object({
        hosts: z.array(githubHostSchema).optional(),
        sync: githubSyncOptionsSchema.optional(),
      })
      .strict()
      .optional(),
    jira: z
      .object({
        sites: z.array(jiraSiteSchema).optional(),
        sync: jiraSyncOptionsSchema.optional(),
      })
      .strict()
      .optional(),
    /*
     * Which of the people below is you.
     *
     * Every command that filters by person takes an id, and the id of the
     * person running the command is the one they type most and the one nobody
     * should have to type at all.
     */
    me: z.string().min(1).optional(),
    people: z.array(personSchema).optional(),
    // The same shape as `people`, with `bot` already answered. A configuration
    // with four humans and nine automations reads far better split in two than
    // as one list where every second entry repeats `bot: true`.
    bots: z.array(personSchema).optional(),
    teams: z.array(teamSchema).optional(),
    projects: z.array(projectSchema).min(1, 'at least one project is required'),
  })
  .strict();

export type RawConfig = z.infer<typeof configSchema>;
export type RawPerson = z.infer<typeof personSchema>;
export type RawTeam = z.infer<typeof teamSchema>;
export type RawGithubRepo = z.infer<typeof githubRepoSchema>;
export type RawJiraProject = z.infer<typeof jiraProjectSchema>;
export type RawGithubSyncOptions = z.infer<typeof githubSyncOptionsSchema>;
export type RawJiraSyncOptions = z.infer<typeof jiraSyncOptionsSchema>;
