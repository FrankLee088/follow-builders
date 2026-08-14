#!/usr/bin/env node

// ============================================================================
// Follow Builders — LLM Remix (Anthropic Messages API)
// ============================================================================
// Turns prepare-digest.js JSON into a short Chinese digest through the Claude
// API. This is the CI counterpart to the `claude -p` path in run-digest.sh:
// same job, but it needs only ANTHROPIC_API_KEY, so it runs on a GitHub Actions
// box that has no Claude Code CLI and no ~/.follow-builders directory.
//
// What it produces, deliberately brief because it is read on a phone in Feishu:
//   今日重点 — a few one-line Chinese highlights, each with its source link
//   per-source sections — 1-2 sentence Chinese summary + 原文 link
//
// Usage:
//   node prepare-digest.js | node remix-api.js
//   node remix-api.js --file feed.json
//
// Env:
//   ANTHROPIC_API_KEY  required
//   FB_MODEL           model id (default claude-opus-5)
//   FB_EFFORT          low | medium | high | xhigh | max (default medium)
//   FB_TIMEZONE        for the date in the header (default Asia/Shanghai)
// ============================================================================

import { readFile } from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';

// GitHub Actions substitutes an unset `vars.X` as the empty string rather than
// omitting the variable, so treat blank as absent — otherwise an unconfigured
// repo variable would override these defaults with ''.
const env = (name) => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};

const MODEL = env('FB_MODEL') || 'claude-opus-5';
const EFFORT = env('FB_EFFORT') || 'medium';

// Pin the endpoint. The SDK reads ANTHROPIC_BASE_URL from the environment, so a
// relay or proxy configured for some entirely different tool would silently
// receive this API key. Requiring a dedicated variable makes redirecting a
// credential a deliberate act instead of an inherited accident.
const BASE_URL = env('FB_ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';

// On Opus 5 thinking and text share this ceiling, so leave headroom above what
// the digest text alone would need.
const MAX_TOKENS = 16000;

// One transcript can run past 70KB. That is fine to send, but cap it so a
// single pathological episode can't blow up the request.
const MAX_TRANSCRIPT_CHARS = 120000;
const MAX_TWEETS_PER_BUILDER = 12;

// -- Input -------------------------------------------------------------------

async function getFeed() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return JSON.parse(await readFile(args[fileIdx + 1], 'utf-8'));
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) throw new Error('no feed on stdin and no --file given');
  return JSON.parse(raw);
}

function formatDate(iso, timezone) {
  const d = iso ? new Date(iso) : new Date();
  try {
    return d.toLocaleDateString('zh-CN', {
      timeZone: timezone || 'Asia/Shanghai',
      year: 'numeric', month: 'long', day: 'numeric'
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Strip the speaker/timestamp scaffolding the transcript provider leaves behind.
// It is pure noise to the model and costs real input tokens.
function cleanTranscript(text) {
  return String(text || '')
    .replace(/Speaker \d+ \| [\d:]+ - [\d:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

// -- Source text -------------------------------------------------------------
// Hand the model a compact, link-anchored rendering rather than the raw JSON.
// Every item carries its url inline so the model never has to correlate an item
// with a url elsewhere in the payload — that is where invented links come from.

function buildSourceText(feed) {
  const out = [];

  const builders = (feed.x || []).filter(b => (b.tweets || []).length > 0);
  if (builders.length) {
    out.push('## SOURCE: X / Twitter');
    for (const b of builders) {
      out.push(`\n### ${b.name || b.handle}${b.bio ? ` — ${b.bio}` : ''}`);
      for (const t of (b.tweets || []).slice(0, MAX_TWEETS_PER_BUILDER)) {
        if (!t.url || !t.text) continue;
        out.push(`- URL: ${t.url}`);
        out.push(`  TEXT: ${String(t.text).replace(/\s+/g, ' ').trim()}`);
      }
    }
  }

  const blogs = (feed.blogs || []).filter(p => p.url);
  if (blogs.length) {
    out.push('\n## SOURCE: Official blogs');
    for (const p of blogs) {
      out.push(`\n### ${p.name || 'Blog'} — ${p.title || 'Untitled'}`);
      out.push(`URL: ${p.url}`);
      if (p.author) out.push(`AUTHOR: ${p.author}`);
      const body = (p.content || p.description || '').replace(/\s+/g, ' ').trim();
      if (body) out.push(`BODY: ${body}`);
    }
  }

  const pods = (feed.podcasts || []).filter(p => p.url);
  if (pods.length) {
    out.push('\n## SOURCE: Podcasts');
    for (const p of pods) {
      out.push(`\n### ${p.name || 'Podcast'} — ${p.title || 'Untitled'}`);
      out.push(`URL: ${p.url}`);
      const body = cleanTranscript(p.transcript);
      if (body) out.push(`TRANSCRIPT: ${body}`);
    }
  }

  return out.join('\n');
}

// -- Prompt ------------------------------------------------------------------
// The upstream prompts/ files describe a long-form English digest. The user
// wants the opposite: brief Chinese highlights with the original link attached.
// So the shape below is authoritative, and the upstream prompts are folded in
// only for their translation and anti-fabrication rules.

function buildSystemPrompt(feed, dateLabel) {
  const p = feed.prompts || {};

  return `你为一位忙碌的中文读者整理 AI 行业每日简报，在飞书里用手机阅读。

输出格式，严格遵守：

# AI Builders Digest — ${dateLabel}

## 今日重点

3 到 6 条。每条一行，一句话说清发生了什么，行尾直接跟原文链接。格式：
- 一句话中文概述 <链接>

## X / Twitter

### 姓名（角色/公司）
一到两句中文概述。然后单独一行放原文链接。
多位 builder 依次排列，每人之间空一行。

## 官方博客

### 博客名 — 文章标题
一到两句中文概述。然后单独一行放原文链接。

## 播客

### 播客名 — 单集标题
两到三句中文概述，写清最有价值的那个观点。然后单独一行放原文链接。

规则：

- 全文用简体中文。技术词保留英文：AI、LLM、GPU、API、token、prompt、agent、RAG、fine-tuning、transformer 等。人名、公司名、产品名保留英文原文。
- 简短。整篇控制在 900 字以内。每条概述给结论，不铺垫、不复述、不写"他讨论了……"这类空话。
- 只写素材里真实出现的内容。不要编造引语、观点、标题或动向，不要猜测某人在做什么。
- 每一条内容都必须带自己的原文链接，链接原样照抄，不要改写、不要缩短、不要拼接。素材里没有链接的条目直接不写。
- 没有实质内容的 builder 整个跳过，不要为了凑数写"今天没有值得注意的动态"。
- 某个板块没有任何素材时，连标题一起省略。
- 不要用破折号（em dash）。不要在正文里写 @handle，飞书里 @ 会被误解析。
- 只输出简报正文。不要前言、不要说明、不要把整篇包在代码块里。
- 结尾单独一行：Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders

翻译与选材参考（与上面格式冲突时，以上面的格式为准）：

${[p.translate, p.summarize_tweets, p.summarize_blogs, p.summarize_podcast]
    .filter(Boolean).join('\n\n---\n\n')}`;
}

// -- Main --------------------------------------------------------------------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const feed = await getFeed();

  const s = feed.stats || {};
  const itemCount = (s.xBuilders || 0) + (s.blogPosts || 0) + (s.podcastEpisodes || 0);
  if (itemCount === 0) {
    // Exit 2 is the runner's agreed "nothing to send today" signal.
    console.error('remix-api.js: feed has no content — nothing to remix');
    process.exit(2);
  }

  const dateLabel = formatDate(feed.generatedAt, process.env.FB_TIMEZONE);
  const sourceText = buildSourceText(feed);
  const system = buildSystemPrompt(feed, dateLabel);

  const client = new Anthropic({ baseURL: BASE_URL });
  if (BASE_URL !== 'https://api.anthropic.com') {
    console.error(`remix warning: sending the API key to ${BASE_URL}, not Anthropic`);
  }

  // Stream: at this max_tokens a non-streaming call risks the request timeout,
  // and a digest with a long transcript can sit for a while before first token.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system,
    messages: [{
      role: 'user',
      content: `今天的素材如下。按系统提示的格式输出简报。\n\n${sourceText}`
    }]
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const d = message.stop_details || {};
    throw new Error(
      `model refused (category=${d.category ?? 'unknown'}): ${d.explanation ?? 'no explanation'}`
    );
  }

  // content is a block array and thinking blocks are present by default on
  // Opus 5, so filter rather than reading content[0].
  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) {
    throw new Error(`model returned no text (stop_reason=${message.stop_reason})`);
  }

  const u = message.usage || {};
  console.error(
    `remix ok: ${text.length} chars, in=${u.input_tokens} out=${u.output_tokens}, ` +
    `model=${message.model}, stop=${message.stop_reason}`
  );
  if (message.stop_reason === 'max_tokens') {
    console.error('remix warning: hit max_tokens — the digest may be cut off');
  }

  console.log(text);
}

main().catch(err => {
  // Typed SDK errors, most specific first. APIConnectionError extends APIError,
  // so it has to be checked before it.
  let detail = err.message;
  if (err instanceof Anthropic.AuthenticationError) {
    detail = `auth failed — check ANTHROPIC_API_KEY: ${err.message}`;
  } else if (err instanceof Anthropic.RateLimitError) {
    detail = `rate limited: ${err.message}`;
  } else if (err instanceof Anthropic.BadRequestError) {
    detail = `bad request: ${err.message}`;
  } else if (err instanceof Anthropic.APIConnectionError) {
    detail = `could not reach the API: ${err.message}`;
  } else if (err instanceof Anthropic.APIError) {
    detail = `API error ${err.status}: ${err.message}`;
  }
  console.error(`remix-api.js failed: ${detail}`);
  process.exit(1);
});
