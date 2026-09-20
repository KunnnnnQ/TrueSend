import {formatUnits} from "viem";

import {fingerprint, type RiskAssessment} from "@truesend/engine";

import type {QueuedRow} from "./store.js";

/**
 * What the owner and the guardian are told, and how.
 *
 * The cooldown is what makes this layer matter. A hold that nobody hears about is a delay; a hold
 * somebody hears about within a minute, with a cancel link in the message, is a defence. Everything
 * in this file exists to close that gap.
 */
export interface AlertContext {
  transfer: QueuedRow;
  owner: string;
  guardian: string;
  /** What the engine makes of the recipient, when a history was available to judge it against. */
  assessment?: RiskAssessment;
  /** Deep link into the Pending screen, already pointed at this transfer. */
  cancelUrl: string;
}

export interface Channel {
  readonly name: string;
  send(alert: AlertContext): Promise<void>;
}

/**
 * The message, in one place.
 *
 * Written to be readable on a phone lock screen, because that is where it will be read. The
 * recipient's fingerprint goes in as text rather than a picture for the same reason: a phrase
 * survives a notification preview, an image does not.
 */
export function composeAlert(alert: AlertContext): {subject: string; body: string} {
  const {transfer, assessment, cancelUrl} = alert;
  const print = fingerprint(transfer.recipient);
  const amount =
    transfer.token === "0x0000000000000000000000000000000000000000"
      ? `${formatUnits(BigInt(transfer.amount), 18)} ETH`
      : `${transfer.amount} units of ${transfer.token}`;

  const verdict = assessment?.level ?? "unknown";
  const subject =
    verdict === "danger"
      ? `Held a transfer to an address TrueSend flagged`
      : `Transfer held — ${amount}`;

  const lines = [
    `${amount} is on hold, not sent.`,
    ``,
    `To   ${print.short}`,
    `     ${print.phrase}`,
    `Unlocks  ${new Date(transfer.unlockAt * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`,
  ];

  if (assessment && assessment.findings.length > 0) {
    lines.push(``, `Why this is worth a look:`);
    for (const finding of assessment.findings.slice(0, 3)) {
      lines.push(`  • ${finding.message}`);
    }
  }

  lines.push(
    ``,
    `If you did not mean this, cancel it:`,
    cancelUrl,
    ``,
    `You can cancel right up until it is executed, including after the hold ends.`,
  );

  return {subject, body: lines.join("\n")};
}

/** Always on. A watcher with no channel configured still leaves a record somebody can read. */
export class ConsoleChannel implements Channel {
  readonly name = "console";

  async send(alert: AlertContext): Promise<void> {
    const {subject, body} = composeAlert(alert);
    console.log(`\n── ${subject} ${"─".repeat(Math.max(0, 60 - subject.length))}`);
    console.log(body);
    console.log("─".repeat(64));
  }
}

/**
 * Telegram, over its plain HTTP API.
 *
 * No SDK: the whole integration is one POST, and a dependency that wraps one POST is a dependency
 * that will need updating for no benefit.
 */
export class TelegramChannel implements Channel {
  readonly name = "telegram";

  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  async send(alert: AlertContext): Promise<void> {
    const {subject, body} = composeAlert(alert);
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        chat_id: this.chatId,
        text: `*${escapeMarkdown(subject)}*\n\n\`\`\`\n${body}\n\`\`\``,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram refused the message: ${response.status} ${await response.text()}`);
    }
  }
}

/** A POST to wherever the operator wants it. The escape hatch for every channel not built in. */
export class WebhookChannel implements Channel {
  readonly name = "webhook";

  constructor(private readonly url: string) {}

  async send(alert: AlertContext): Promise<void> {
    const {subject, body} = composeAlert(alert);
    const response = await fetch(this.url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        subject,
        body,
        cancelUrl: alert.cancelUrl,
        transfer: alert.transfer,
        level: alert.assessment?.level ?? null,
        score: alert.assessment?.score ?? null,
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }
  }
}

/** Telegram's MarkdownV2 rejects a message containing any of these unescaped. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (char) => `\\${char}`);
}

export function channelsFromEnv(env: NodeJS.ProcessEnv): Channel[] {
  const channels: Channel[] = [new ConsoleChannel()];

  const token = env["TELEGRAM_BOT_TOKEN"];
  const chatId = env["TELEGRAM_CHAT_ID"];
  if (token && chatId) channels.push(new TelegramChannel(token, chatId));

  const webhook = env["ALERT_WEBHOOK_URL"];
  if (webhook) channels.push(new WebhookChannel(webhook));

  return channels;
}
