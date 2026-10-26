import { describe, expect, it } from "vitest";

import { titleFromFilename } from "../src/model/media.ts";
import { pageList } from "../src/ui/MediaLibrary.tsx";

describe("media library in the photo panel", () => {
	it("numbers pages with the first, the last and the neighbours of the current one", () => {
		expect(pageList(1, 1)).toEqual([1]);
		expect(pageList(1, 3)).toEqual([1, 2, 3]);
		expect(pageList(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
		expect(pageList(10, 10)).toEqual([1, "gap", 9, 10]);
	});
	it("titles an upload with its file name", () => {
		expect(titleFromFilename("Kitchen view 02.JPEG")).toBe("Kitchen view 02");
		expect(titleFromFilename("plan")).toBe("plan");
	});
});
