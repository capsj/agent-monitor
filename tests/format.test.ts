import { describe, expect, it } from "vitest";
import {
  formatWindowUsage,
  remainingPercent,
  remainingSparkline,
} from "../src/utils/format.js";

describe("usage percentage formatting", () => {
  it("shows plan usage as quota left", () => {
    expect(
      formatWindowUsage({
        id: "weekly",
        label: "Weekly",
        usedPercent: 72,
        quality: "exact",
        category: "included",
      }),
    ).toBe("28% left");
  });

  it("keeps overage usage as consumed and allows values above 100%", () => {
    expect(
      formatWindowUsage({
        id: "credits",
        label: "Usage credits",
        usedPercent: 101,
        quality: "exact",
        category: "additional",
      }),
    ).toBe("101% used");
  });

  it("clamps remaining quota at the percentage bounds", () => {
    expect(remainingPercent(-5)).toBe(100);
    expect(remainingPercent(105)).toBe(0);
  });

  it("inverts consumed sparklines for the remaining-quota display", () => {
    expect(remainingSparkline("▁▄█")).toBe("█▅▁");
  });
});
