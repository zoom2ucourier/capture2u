import { Hono } from "hono";
import type { AccountSettings, Person } from "../../shared/types";
import { requireUser } from "../auth";
import { adminClient } from "../db";
import type { AppBindings } from "../env";
import { displayName } from "../lib/util";

const MAX_PEOPLE = 8;

export const peopleSearchTerm = (value: string | undefined) =>
	(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9 .-]+/g, "")
		.trim()
		.slice(0, 40);

export const account = new Hono<AppBindings>();

account.use("*", requireUser);

account.get("/", async (c) => {
	const { data, error } = await adminClient(c.env)
		.from("profiles")
		.select("slack_alerts")
		.eq("id", c.get("user").id)
		.maybeSingle();
	if (error) throw new Error(`Could not load settings: ${error.message}`);
	const settings: AccountSettings = {
		slackAlerts: data?.slack_alerts !== false,
	};
	return c.json({ settings }, 200, { "Cache-Control": "private, no-store" });
});

account.patch("/", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (typeof body.slackAlerts !== "boolean")
		return c.json({ error: "nothing_to_update" }, 400);
	const { error } = await adminClient(c.env)
		.from("profiles")
		.update({ slack_alerts: body.slackAlerts })
		.eq("id", c.get("user").id);
	if (error) throw new Error(`Could not save settings: ${error.message}`);
	const settings: AccountSettings = { slackAlerts: body.slackAlerts };
	return c.json({ settings });
});

account.get("/people", async (c) => {
	const user = c.get("user");
	const term = peopleSearchTerm(c.req.query("q"));
	let query = adminClient(c.env)
		.from("profiles")
		.select("id,full_name,email")
		.neq("id", user.id)
		.order("email", { ascending: true })
		.limit(MAX_PEOPLE);
	if (term) {
		const pattern = `%${term.replace(/ +/g, "%")}%`;
		query = query.or(`full_name.ilike.${pattern},email.ilike.${pattern}`);
	}
	const { data, error } = await query;
	if (error) throw new Error(`Could not search people: ${error.message}`);
	const people: Person[] = (data ?? []).map((row) => ({
		id: row.id as string,
		name: displayName(
			row.full_name as string | null,
			row.email as string | null,
		),
	}));
	return c.json({ people }, 200, { "Cache-Control": "private, no-store" });
});
