"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// Marks a video "keep" so the Capture2u retention job never deletes it.
// Allowed for the video's owner and for owners/admins of its organization.
export async function setVideoKeep(input: {
	videoId: Video.VideoId;
	keep: boolean;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!input || typeof input.videoId !== "string")
		throw new Error("Video not found");
	const keep = input.keep === true;

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			orgId: videos.orgId,
		})
		.from(videos)
		.where(eq(videos.id, input.videoId));
	if (!video) throw new Error("Video not found");

	let allowed = video.ownerId === user.id;
	if (!allowed && video.orgId) {
		const [membership] = await db()
			.select({ role: organizationMembers.role })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, video.orgId),
					eq(organizationMembers.userId, user.id),
				),
			);
		allowed = membership?.role === "owner" || membership?.role === "admin";
	}
	if (!allowed)
		throw new Error("You don't have permission to change this video");

	// Updated in place inside the JSON so other metadata written at the same
	// time is not overwritten, and without bumping the video's updatedAt.
	await db()
		.update(videos)
		.set({
			metadata: keep
				? sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.keep', CAST('true' AS JSON))`
				: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.keep')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(eq(videos.id, video.id));

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/caps/archived");
	revalidatePath("/dashboard/shared-caps");
	revalidatePath("/dashboard/folder/[id]", "page");
	return { keep };
}
