import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runRetention } from "@/lib/capture2u/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Called once a day by the Capture2u scheduler container. Same shared-secret
// check as Cap's own /api/cron routes.
export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const summary = await runRetention();
		return NextResponse.json({ success: true, ...summary });
	} catch (error) {
		console.error("[capture2u-retention] run failed", error);
		return NextResponse.json(
			{ success: false, error: "Retention run failed" },
			{ status: 500 },
		);
	}
}
