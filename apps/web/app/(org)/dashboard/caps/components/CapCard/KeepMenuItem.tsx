"use client";

import { DropdownMenuItem } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faThumbtack } from "@fortawesome/free-solid-svg-icons/faThumbtack";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setVideoKeep } from "@/actions/capture2u/keep";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";

export function KeepMenuItem({
	videoId,
	initialKeep,
}: {
	videoId: Video.VideoId;
	initialKeep: boolean;
}) {
	const router = useRouter();
	const [keep, setKeep] = useState(initialKeep);
	const [isPending, startTransition] = useTransition();

	return (
		<DropdownMenuItem
			disabled={isPending}
			onClick={(e) => {
				e.stopPropagation();
				const next = !keep;
				startTransition(async () => {
					try {
						const result = await setVideoKeep({ videoId, keep: next });
						setKeep(result.keep);
						toast.success(
							result.keep
								? "Kept. This video will not be auto-deleted."
								: "No longer kept. This video will be deleted one year after it was recorded.",
						);
						router.refresh();
					} catch {
						toast.error("Could not update this video");
					}
				});
			}}
			className="flex gap-2 items-center rounded-lg"
		>
			<FontAwesomeIcon className="size-3" icon={faThumbtack} />
			<p className="text-sm text-gray-12">
				{keep ? "Stop keeping" : "Keep (don't auto-delete)"}
			</p>
		</DropdownMenuItem>
	);
}
