import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";

export type JobStatus = "queued" | "accepting" | "minting" | "delivering" | "delivered" | "disputed" | "settled" | "failed";

/** How a buyer's (single, on-chain) redo request was answered. */
export interface RedoRecord {
  at: string;
  /** reissued: old code destroyed, new one delivered. refused: a coin was already inserted, original code re-delivered. */
  decision: "reissued" | "refused";
  reason?: string;
  buyerNote?: string;
  oldCode: string;
  newCode?: string;
  coinsUsedOnOldCode: number;
}

/** Evidence we filed for a buyer's challenge. */
export interface DisputeRecord {
  disputeId: string;
  openedStatus?: string;
  evidenceSubmittedAt?: string;
  artifactId?: string;
  payloadId?: string;
  error?: string;
}

export interface Job {
  id: string;
  orderId: string;
  conversationId?: string;
  status: JobStatus;
  price?: string;
  currency?: string;
  buyer?: string;
  coins?: number;
  code?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  artifactIds: string[];
  txHashes: Record<string, string>;
  notes: string[];
  redo?: RedoRecord;
  dispute?: DisputeRecord;
}

export interface ConversationLog {
  id: string;
  orderId?: string;
  buyer?: string;
  messages: Array<{ role: "buyer" | "agent"; text: string; at: string; messageId?: string }>;
}

function jobsDir() {
  const d = path.join(getConfig().dataDir, "jobs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function convDir() {
  const d = path.join(getConfig().dataDir, "conversations");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function createJob(init: Pick<Job, "orderId"> & Partial<Job>): Job {
  const now = new Date().toISOString();
  const job: Job = { id: `order-${init.orderId}`, status: "queued", createdAt: now, updatedAt: now, artifactIds: [], txHashes: {}, notes: [], ...init };
  saveJob(job);
  return job;
}

export function saveJob(job: Job): void {
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(jobsDir(), `${job.id}.json`), JSON.stringify(job, null, 2));
}

export function listJobs(): Job[] {
  return fs
    .readdirSync(jobsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(jobsDir(), f), "utf8")) as Job)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findJobByOrder(orderId: string): Job | undefined {
  const file = path.join(jobsDir(), `order-${orderId}.json`);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Job;
}

export function loadConversation(id: string): ConversationLog {
  const file = path.join(convDir(), `${id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as ConversationLog;
  return { id, messages: [] };
}

export function saveConversation(conv: ConversationLog): void {
  fs.writeFileSync(path.join(convDir(), `${conv.id}.json`), JSON.stringify(conv, null, 2));
}
