// Two-series palette for the learning curve. Validated with the dataviz skill's
// validate_palette.js on the dark surface #0f141b: CVD ΔE 27.4, contrast >= 3:1.
export const SERIES = {
  off: { label: "Memory OFF", color: "#3987e5" },
  on: { label: "Memory ON", color: "#c98500" },
} as const;

// Third categorical slot (aqua), used for the memories-in-bank line on its own panel.
// Validated with all pairs of the above on #0f141b: worst CVD ΔE 8.4, contrast >= 3:1.
export const MEMORY_SERIES = { label: "Memories in bank", color: "#199e70" } as const;
