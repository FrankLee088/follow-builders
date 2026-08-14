#!/usr/bin/env node

// ============================================================================
// Follow Builders — 飞书 (Feishu/Lark) Delivery, CI edition
// ============================================================================
// Posts a markdown digest into Feishu as an interactive card, configured purely
// from environment variables. The local copy at ~/.follow-builders/ reads
// config.json and assumes a home directory; this one runs on a GitHub Actions
// box where neither exists.
//
// Env:
//   FEISHU_WEBHOOK_URL     required — 群自定义机器人 webhook
//   FEISHU_WEBHOOK_SECRET  optional — only if 签名校验 is enabled on the bot
//   FB_CARD_TITLE          optional — card header text
//
// Usage:
//   node remix-api.js --file feed.json | node feishu-deliver.js
//   node feishu-deliver.js --file digest.md
//   node feishu-deliver.js --file digest.md --dry-run
//
// Zero npm dependencies: global fetch plus node:crypto, so delivery still works
// even if an install step failed earlier in the job.
// ============================================================================

import { readFile } from 'fs/promises';
import { createHmac } from 'crypto';

const CARD_TITLE = process.env.FB_CARD_TITLE || '🤖 AI Builders Digest';

// Feishu rejects a card over ~30KB. Stay well under, and split a long digest
// across several cards rather than losing the tail.
const MAX_ELEMENT_CHARS = 3500;
const MAX_CARD_CHARS = 12000;

// -- Input -------------------------------------------------------------------

async function getDigestText() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Markdown → Feishu card ---------------------------------------------------
// Feishu's markdown element supports **bold**, [text](url), and bare links, but
// not ATX headings — a line starting with ## renders literally as "##". Convert
// headings to bold so the section structure survives.

function normalizeForFeishu(markdown) {
  return markdown
    .split('\n')
    .map(line => {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (!m) return line;
      return `**${m[2].trim()}**`;
    })
    .join('\n');
}

function digestToCards(markdown) {
  const lines = normalizeForFeishu(markdown.trim()).split('\n');
  const cards = [];
  let currentElements = [];
  let currentChars = 0;

  function flushCard() {
    if (currentElements.length === 0) return;
    cards.push({
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { content: CARD_TITLE, tag: 'plain_text' },
          template: 'blue'
        },
        elements: currentElements
      }
    });
    currentElements = [];
    currentChars = 0;
  }

  function addElement(el) {
    const elSize = JSON.stringify(el).length;
    if (currentChars + elSize > MAX_CARD_CHARS) flushCard();
    currentElements.push(el);
    currentChars += elSize;
  }

  function addText(text) {
    if (text.length <= MAX_ELEMENT_CHARS) {
      addElement({ tag: 'markdown', content: text });
      return;
    }
    for (let i = 0; i < text.length; i += MAX_ELEMENT_CHARS) {
      addElement({ tag: 'markdown', content: text.slice(i, i + MAX_ELEMENT_CHARS) });
    }
  }

  // Blank lines are paragraph boundaries: each block becomes one element, so
  // Feishu keeps the spacing the digest intended.
  let buffer = '';
  for (const line of lines) {
    if (!line.trim()) {
      if (buffer) {
        addText(buffer);
        buffer = '';
      }
      continue;
    }
    buffer += (buffer ? '\n' : '') + line;
  }
  if (buffer) addText(buffer);

  flushCard();
  return cards;
}

// -- Webhook transport -------------------------------------------------------

async function sendViaWebhook(cards, webhookUrl, secret) {
  for (let i = 0; i < cards.length; i++) {
    const payload = cards[i];

    if (secret) {
      // 飞书 signing: HMAC-SHA256 where "<timestamp>\n<secret>" is the KEY and
      // the message is empty, which is the reverse of the usual arrangement.
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', `${timestamp}\n${secret}`)
        .update('')
        .digest('base64');
      payload.timestamp = timestamp.toString();
      payload.sign = signature;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`webhook HTTP ${res.status}: ${await res.text()}`);
    }

    // Feishu answers 200 with a non-zero code on application errors, so the
    // body has to be checked too. 19001 = bot removed from the group.
    const result = await res.json();
    if (result.code !== 0) {
      throw new Error(`webhook error ${result.code}: ${result.msg}`);
    }

    if (i < cards.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');

  const digestText = await getDigestText();
  if (!digestText || !digestText.trim()) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'empty digest' }));
    return;
  }

  const cards = digestToCards(digestText);

  if (dryRun) {
    console.log(JSON.stringify({ status: 'dry-run', cards }, null, 2));
    return;
  }

  const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('FEISHU_WEBHOOK_URL is not set');
  }

  await sendViaWebhook(cards, webhookUrl, process.env.FEISHU_WEBHOOK_SECRET);

  console.log(JSON.stringify({
    status: 'ok',
    method: 'feishu-webhook',
    cards: cards.length,
    chars: digestText.length
  }));
}

main().catch(err => {
  // Normalize every failure to one JSON line: under Actions this is the only
  // thing that shows up in the step log, and a raw stack trace is useless there.
  console.log(JSON.stringify({
    status: 'error',
    method: 'feishu-webhook',
    message: err.message
  }));
  process.exit(1);
});
