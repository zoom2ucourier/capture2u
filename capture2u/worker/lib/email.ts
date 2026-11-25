import type { Env } from "../env";
import { escapeHtml } from "./util";

export interface OutgoingEmail {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export async function sendEmail(env: Env, message: OutgoingEmail) {
	if (!env.EMAIL) throw new Error("Email sending is not set up");
	await env.EMAIL.send({
		from: { email: env.EMAIL_FROM, name: "Capture2u" },
		to: message.to,
		subject: message.subject,
		text: message.text,
		html: message.html,
	});
}

const layout = (body: string, footer: string) =>
	`<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;line-height:1.5">` +
	`<p style="font-weight:700;font-size:18px;margin:0 0 16px">Capture2u</p>${body}` +
	`<p style="color:#6b7280;font-size:13px;margin:24px 0 0">${footer}</p></div>`;

const button = (url: string, label: string) =>
	`<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;display:inline-block">${escapeHtml(label)}</a></p>`;

const NOTIFICATION_FOOTER =
	"You can turn these emails off on the My videos page in Capture2u.";

export function loginCodeEmail(
	to: string,
	code: string,
	minutes: number,
): OutgoingEmail {
	return {
		to,
		subject: `${code} is your Capture2u sign-in code`,
		text: `Your Capture2u sign-in code is ${code}\n\nIt works for ${minutes} minutes. If you did not ask for it, you can ignore this email.`,
		html: layout(
			`<p style="margin:0 0 8px">Your sign-in code is</p>` +
				`<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 8px">${escapeHtml(code)}</p>` +
				`<p style="margin:0">It works for ${minutes} minutes.</p>`,
			"If you did not ask for this code, you can ignore this email.",
		),
	};
}

export function commentEmail(input: {
	to: string;
	actorName: string;
	videoTitle: string;
	body: string;
	url: string;
	isReply: boolean;
}): OutgoingEmail {
	const action = input.isReply ? "replied to your comment on" : "commented on";
	const excerpt =
		input.body.length > 500 ? `${input.body.slice(0, 500)}…` : input.body;
	return {
		to: input.to,
		subject: `${input.actorName} ${action} "${input.videoTitle}"`,
		text: `${input.actorName} ${action} "${input.videoTitle}":\n\n${excerpt}\n\n${input.url}\n\n${NOTIFICATION_FOOTER}`,
		html: layout(
			`<p style="margin:0 0 12px"><strong>${escapeHtml(input.actorName)}</strong> ${action} <strong>${escapeHtml(input.videoTitle)}</strong>:</p>` +
				`<p style="margin:0;padding:12px;background:#f5f6f8;border-radius:8px;white-space:pre-wrap">${escapeHtml(excerpt)}</p>` +
				button(input.url, "Open the video"),
			NOTIFICATION_FOOTER,
		),
	};
}

export function firstViewEmail(input: {
	to: string;
	viewerName: string | null;
	videoTitle: string;
	url: string;
}): OutgoingEmail {
	const who = input.viewerName ?? "Someone";
	return {
		to: input.to,
		subject: `${who} watched "${input.videoTitle}"`,
		text: `${who} just watched "${input.videoTitle}". This is its first view.\n\n${input.url}\n\n${NOTIFICATION_FOOTER}`,
		html: layout(
			`<p style="margin:0"><strong>${escapeHtml(who)}</strong> just watched <strong>${escapeHtml(input.videoTitle)}</strong>. This is its first view.</p>` +
				button(input.url, "Open the video"),
			NOTIFICATION_FOOTER,
		),
	};
}
