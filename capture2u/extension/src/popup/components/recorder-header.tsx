import clsx from "clsx";
import { X } from "lucide-react";
import { Capture2uBrand } from "../../shared/brand";

interface RecorderHeaderProps {
	isBusy: boolean;
	/** Hide the logo row; the sign-in screen renders its own centered brand. */
	minimal?: boolean;
	onClose: () => void;
}

export const RecorderHeader = ({
	isBusy,
	minimal = false,
	onClose,
}: RecorderHeaderProps) => (
	<>
		<div className="absolute left-3.5 top-4 flex gap-2 items-center">
			<button
				type="button"
				onClick={onClose}
				disabled={isBusy}
				title="Close Capture2u"
				className={clsx(
					"flex size-4 items-center justify-center rounded-full bg-[#FF5F57] border border-[#E0443E]/60 p-0",
					isBusy
						? "opacity-50 cursor-not-allowed"
						: "cursor-pointer transition-transform hover:scale-110",
				)}
				aria-label="Close Capture2u and hide all recorder UI"
			>
				<X size={10} strokeWidth={3.5} className="text-[#741b15]" aria-hidden />
			</button>
			<div className="size-3 rounded-full bg-gray-8 opacity-50"></div>
			<div className="size-3 rounded-full bg-gray-8 opacity-50"></div>
		</div>
		{minimal ? null : (
			<div className="flex items-center justify-between pb-[0.25rem]">
				<Capture2uBrand className="block h-[26px] w-auto text-[color:var(--secondary)]" />
			</div>
		)}
	</>
);
