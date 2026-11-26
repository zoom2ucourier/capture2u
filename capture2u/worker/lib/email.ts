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
	`<div style="background:#F4F7FB;padding:24px 12px">` +
	`<div style="font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#FFFFFF;border:1px solid #E3E3E3;border-radius:12px;color:#384553;font-size:14px;line-height:1.5">` +
	`<p style="font-weight:700;font-size:18px;color:#1C3E61;margin:0 0 16px;padding:0 0 12px;border-bottom:2px solid #2B93FF">Capture2u</p>${body}` +
	`<p style="color:#737474;font-size:12px;margin:24px 0 0">${footer}</p></div></div>`;

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
				`<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1C3E61;margin:0 0 8px">${escapeHtml(code)}</p>` +
				`<p style="margin:0">It works for ${minutes} minutes.</p>`,
			"If you did not ask for this code, you can ignore this email.",
		),
	};
}
