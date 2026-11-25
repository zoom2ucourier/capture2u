import type { SupabaseClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import type { Folder } from "../../shared/types";
import { requireUser } from "../auth";
import { adminClient, profileNames } from "../db";
import type { AppBindings, SessionUser } from "../env";
import { isUuid } from "../lib/util";

const MAX_FOLDERS_PER_USER = 200;
const FOLDER_COLUMNS = "id,owner_id,name,shared,created_at";

export interface FolderRow {
	id: string;
	owner_id: string;
	name: string;
	shared: boolean;
	created_at: string;
}

export function parseFolderName(value: unknown) {
	if (typeof value !== "string") return null;
	const name = value.trim().replace(/\s+/g, " ");
	return name.length >= 1 && name.length <= 80 ? name : null;
}

export async function getFolder(db: SupabaseClient, id: string) {
	const { data, error } = await db
		.from("folders")
		.select(FOLDER_COLUMNS)
		.eq("id", id)
		.maybeSingle();
	if (error) throw new Error(`Could not load folder: ${error.message}`);
	return (data as FolderRow | null) ?? null;
}

async function toFolders(
	db: SupabaseClient,
	user: SessionUser,
	rows: FolderRow[],
): Promise<Folder[]> {
	if (rows.length === 0) return [];
	const { data, error } = await db
		.from("videos")
		.select("folder_id,owner_id,visibility")
		.in(
			"folder_id",
			rows.map((row) => row.id),
		);
	if (error) throw new Error(`Could not count videos: ${error.message}`);
	const counts = new Map<string, number>();
	for (const video of data ?? []) {
		if (video.owner_id !== user.id && video.visibility === "private") continue;
		const folderId = video.folder_id as string;
		counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
	}
	const names = await profileNames(
		db,
		rows.filter((row) => row.owner_id !== user.id).map((row) => row.owner_id),
	);
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		shared: row.shared,
		isOwner: row.owner_id === user.id,
		ownerName:
			row.owner_id === user.id ? null : (names.get(row.owner_id) ?? null),
		videoCount: counts.get(row.id) ?? 0,
	}));
}

export const folders = new Hono<AppBindings>();

folders.use("*", requireUser);

folders.get("/", async (c) => {
	const user = c.get("user");
	const db = adminClient(c.env);
	const { data, error } = await db
		.from("folders")
		.select(FOLDER_COLUMNS)
		.or(`owner_id.eq.${user.id},shared.eq.true`)
		.order("name", { ascending: true })
		.limit(1000);
	if (error) throw new Error(`Could not list folders: ${error.message}`);
	return c.json({
		folders: await toFolders(db, user, (data ?? []) as FolderRow[]),
	});
});

folders.post("/", async (c) => {
	const user = c.get("user");
	const db = adminClient(c.env);
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
	const name = parseFolderName(body.name);
	if (!name)
		return c.json(
			{ error: "invalid_name", message: "Use a name of 1 to 80 characters." },
			400,
		);

	const { count, error: countError } = await db
		.from("folders")
		.select("id", { count: "exact", head: true })
		.eq("owner_id", user.id);
	if (countError)
		throw new Error(`Could not count folders: ${countError.message}`);
	if ((count ?? 0) >= MAX_FOLDERS_PER_USER)
		return c.json({ error: "too_many_folders" }, 409);

	const { data, error } = await db
		.from("folders")
		.insert({ owner_id: user.id, name })
		.select(FOLDER_COLUMNS)
		.single();
	if (error) throw new Error(`Could not create folder: ${error.message}`);
	const [folder] = await toFolders(db, user, [data as FolderRow]);
	return c.json({ folder });
});

folders.patch("/:id", async (c) => {
	const user = c.get("user");
	const id = c.req.param("id");
	if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const existing = await getFolder(db, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	if (existing.owner_id !== user.id) return c.json({ error: "forbidden" }, 403);

	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const update: Record<string, unknown> = {};
	if ("name" in body) {
		const name = parseFolderName(body.name);
		if (!name)
			return c.json(
				{
					error: "invalid_name",
					message: "Use a name of 1 to 80 characters.",
				},
				400,
			);
		update.name = name;
	}
	if ("shared" in body) {
		if (typeof body.shared !== "boolean")
			return c.json({ error: "invalid_shared" }, 400);
		update.shared = body.shared;
	}
	if (Object.keys(update).length === 0)
		return c.json({ error: "nothing_to_update" }, 400);

	const { data, error } = await db
		.from("folders")
		.update(update)
		.eq("id", id)
		.select(FOLDER_COLUMNS)
		.single();
	if (error) throw new Error(`Could not update folder: ${error.message}`);
	const [folder] = await toFolders(db, user, [data as FolderRow]);
	return c.json({ folder });
});

folders.delete("/:id", async (c) => {
	const user = c.get("user");
	const id = c.req.param("id");
	if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const existing = await getFolder(db, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	if (existing.owner_id !== user.id) return c.json({ error: "forbidden" }, 403);
	const { error } = await db.from("folders").delete().eq("id", id);
	if (error) throw new Error(`Could not delete folder: ${error.message}`);
	return c.json({ deleted: true });
});
